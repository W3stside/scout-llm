#!/usr/bin/env bash
# Default-deny egress firewall for the Scout dev container.
#
# Why: this container runs `yarn install` over a dependency tree containing thousands of
# transitive packages AND parses HTML fetched from hostile third-party sites. Either is a
# plausible RCE vector, and the container has ~/.npmrc (GitHub Packages PAT) and ~/.claude
# mounted. This locks egress to an explicit allowlist so a stolen secret cannot leave.
#
# The scrape-target problem: a scraper needs to reach arbitrary sites, which is the
# opposite of an allowlist. Resolved by scope — this container only ever fetches the hosts
# named in targets/*.yaml, so those are resolved and allowlisted below. Declaring a new
# target widens the policy by exactly one host. The unrestricted, credential-free scraper
# runs in the compose service instead.
#
# Idempotent: safe to re-run on every container start (postStartCommand), and safe to
# re-run by hand after adding a target. Runs as root via the narrowed sudoers entry; needs
# NET_ADMIN/NET_RAW (see runArgs).
set -euo pipefail
IFS=$'\n\t'

WORKSPACE="${SCOUT_WORKSPACE:-/workspaces/scout}"

# --- Reset any prior state -------------------------------------------------------------
# The policy reset is load-bearing and easy to miss: `iptables -F` clears RULES but leaves
# the -P DROP POLICY from a previous run in force. Without restoring ACCEPT here, every
# lookup this script performs (the GitHub metadata fetch, every dig) is dropped by the
# policy the last run installed — the script then hangs for minutes and silently
# allowlists nothing. It "works" only on a fresh container, where policies default to
# ACCEPT. Re-running by hand is exactly when that matters.
iptables -P INPUT ACCEPT
iptables -P OUTPUT ACCEPT
iptables -P FORWARD ACCEPT
iptables -F
iptables -X 2>/dev/null || true
ipset destroy allowed 2>/dev/null || true
ipset create allowed hash:net

_add_host() {
    local host="$1"
    local ip
    for ip in $(dig +short +time=3 +tries=1 "$host" A 2>/dev/null | grep -E '^[0-9.]+$' || true); do
        ipset add allowed "$ip" 2>/dev/null || true
    done
}

# --- DNS: keep name resolution working under the deny policy ---------------------------
iptables -A OUTPUT -p udp --dport 53 -j ACCEPT
iptables -A OUTPUT -p tcp --dport 53 -j ACCEPT
iptables -A INPUT  -p udp --sport 53 -j ACCEPT
iptables -A INPUT  -p tcp --sport 53 -j ACCEPT

# --- Ollama on the host ----------------------------------------------------------------
# The model runs on the host's GPU, not in here. The container reaches it via the default
# route's gateway (the docker bridge, typically 172.17.0.1). Scoped to the single port, so
# this is not a general hole to every service on the host.
HOST_GW="$(ip route | awk '/^default/ {print $3; exit}')"
if [ -n "${HOST_GW:-}" ]; then
    iptables -A OUTPUT -d "$HOST_GW" -p tcp --dport 11434 -j ACCEPT
    echo "init-firewall: ollama allowed at ${HOST_GW}:11434"
else
    echo "init-firewall: WARNING no default gateway found — Ollama will be unreachable" >&2
fi

# --- GitHub IP ranges ------------------------------------------------------------------
# Covers github.com, api/codeload.github.com, *.githubusercontent.com and release assets.
# Bounded by --max-time: if this is ever unreachable, the run must degrade to "no GitHub
# access" in seconds rather than stalling the container start for minutes.
gh_meta="$(curl -fsSL --max-time 15 https://api.github.com/meta || true)"
if [ -n "$gh_meta" ]; then
    echo "$gh_meta" \
        | grep -oE '"[0-9.]+/[0-9]+"' | tr -d '"' \
        | while read -r cidr; do ipset add allowed "$cidr" 2>/dev/null || true; done
else
    echo "init-firewall: WARNING could not fetch GitHub ranges — git over https will fail" >&2
fi

# --- Fixed infrastructure hosts --------------------------------------------------------
# NOTE: statsig.anthropic.com was decommissioned (now NXDOMAIN) — Claude Code's feature
# gating resolves via statsig.com, so that is the host to allowlist.
ALLOW_HOSTS=(
    registry.npmjs.org
    api.anthropic.com
    console.anthropic.com
    statsig.com

    # Telegram Bot API — long-polling and sendPhoto
    api.telegram.org

    # Playwright's Chromium download (postCreate only, but harmless to keep)
    cdn.playwright.dev
    playwright.azureedge.net
)
for host in "${ALLOW_HOSTS[@]}"; do
    _add_host "$host"
done

# --- Declared scrape targets -----------------------------------------------------------
# Read from the `url:` field of every targets/*.yaml.
#
# NOTE the yq dialect: this is mikefarah's Go yq, where `// empty` is a jq-ism that errors
# out with `invalid input text "empty"` — which failed silently here and allowlisted zero
# targets. Use the `// ""` alternative operator and filter the blanks in bash.
target_count=0
if [ -d "${WORKSPACE}/targets" ]; then
    # Each file is read separately. Handing yq several files at once makes it emit a `---`
    # document separator between them, which the loop below would otherwise take for a
    # hostname — harmless, since it never resolves, but it inflates the count and logs a
    # line that looks like a real allowlist entry.
    for target_file in "${WORKSPACE}"/targets/*.yaml "${WORKSPACE}"/targets/*.yml; do
        [ -e "$target_file" ] || continue

        url="$(yq -r '.url // ""' "$target_file" 2>/dev/null || true)"
        [ -z "$url" ] && continue
        [ "$url" = "null" ] && continue

        # Strip scheme, then anything from the first / : or ? onward.
        host="${url#*://}"
        host="${host%%/*}"; host="${host%%:*}"; host="${host%%\?*}"
        [ -z "$host" ] && continue
        # A bare `---` or anything without a dot is not a hostname worth resolving.
        case "$host" in *.*) ;; *) continue ;; esac

        # Both the apex and the www form. Previously this added "www.$host" after stripping
        # a leading www, which for a target already written as www.example.com resolved the
        # SAME name twice and never allowlisted the apex — so a redirect or a discovered URL
        # using the bare domain timed out with no indication why.
        apex="${host#www.}"
        _add_host "$apex"
        _add_host "www.${apex}"
        target_count=$((target_count + 1))
        echo "init-firewall: target host allowed -> ${host}"
    done
fi
echo "init-firewall: ${target_count} scrape target host(s) allowlisted"

# --- Policy: loopback + established + allowlist; deny everything else -------------------
iptables -A INPUT  -i lo -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A INPUT  -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -m set --match-set allowed dst -j ACCEPT

iptables -P OUTPUT DROP
iptables -P INPUT  DROP
iptables -P FORWARD DROP

echo "init-firewall: egress locked to allowlist ($(ipset list allowed | grep -cE '^[0-9]') entries)"
