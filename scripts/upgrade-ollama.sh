#!/usr/bin/env bash
# One-shot, reversible upgrade of the host Ollama from 0.30.10 to 0.32.x.
#
# Why this exists rather than just piping install.sh into a shell: the official
# installer unconditionally rewrites /etc/systemd/system/ollama.service with
# Environment="PATH=$PATH", capturing the PATH of whatever shell invoked it. The
# live unit carries a supra venv entry that would be silently dropped. systemd
# applies drop-ins AFTER the main unit, so pinning the PATH in a .d/ file makes
# the rewrite a no-op for our purposes.
#
# Not touched by this upgrade: the model store (/usr/share/ollama/.ollama/models,
# where supra-fast / supra-reason live) and the existing .d/ drop-ins carrying
# HSA_OVERRIDE_GFX_VERSION, OLLAMA_FLASH_ATTENTION and OLLAMA_KV_CACHE_TYPE.
#
# Rollback:  curl -fsSL https://ollama.com/install.sh | OLLAMA_VERSION=0.30.10 sh
set -euo pipefail
IFS=$'\n\t'

DROPIN_DIR=/etc/systemd/system/ollama.service.d
BACKUP_DIR=/home/ghost/.ollama-backup

if [ "$(id -u)" -ne 0 ]; then
    echo "re-executing under sudo..." >&2
    exec sudo -- "$0" "$@"
fi

echo "==> before: $(/usr/local/bin/ollama --version 2>&1)"

# --- 1. Capture the live PATH as a drop-in, so the installer's rewrite of the
#        main unit cannot drop the supra venv entry. -------------------------
current_path="$(systemctl show ollama -p Environment --value 2>/dev/null \
    | tr ' ' '\n' | grep '^PATH=' | head -1 | cut -d= -f2- || true)"

if [ -z "$current_path" ]; then
    echo "!! could not read the unit's current PATH — aborting rather than guessing" >&2
    exit 1
fi

mkdir -p "$DROPIN_DIR"
cat > "$DROPIN_DIR/30-path.conf" <<EOF
[Service]
# Pins the PATH the unit had before the 0.30.10 -> 0.32.x upgrade. The official
# install.sh rewrites ollama.service with Environment="PATH=\$PATH", capturing the
# PATH of whatever shell ran it — which would silently drop the supra venv entry
# below. Drop-ins are applied after the main unit, so this wins regardless.
Environment="PATH=${current_path}"
EOF
chmod 0644 "$DROPIN_DIR/30-path.conf"
echo "==> pinned PATH in $DROPIN_DIR/30-path.conf"

# --- 2. Snapshot what we cannot trivially regenerate ------------------------
mkdir -p "$BACKUP_DIR"
cp -a /usr/local/bin/ollama "$BACKUP_DIR/ollama-0.30.10" 2>/dev/null || true
cp -a "$DROPIN_DIR" "$BACKUP_DIR/" 2>/dev/null || true
cp -a /etc/systemd/system/ollama.service "$BACKUP_DIR/ollama.service.before" 2>/dev/null || true
echo "==> snapshot in $BACKUP_DIR"

# --- 3. Record the model inventory so we can prove nothing was lost ---------
/usr/local/bin/ollama list > "$BACKUP_DIR/models-before.txt" 2>&1 || true

# --- 4. Upgrade -------------------------------------------------------------
echo "==> running official installer (this restarts ollama; the in-car Pi will"
echo "    lose its Tailscale connection for a few seconds)"
curl -fsSL https://ollama.com/install.sh | sh

# --- 5. Verify --------------------------------------------------------------
sleep 5
echo
echo "==> after:  $(/usr/local/bin/ollama --version 2>&1)"
echo "==> unit PATH now:"
systemctl show ollama -p Environment --value | tr ' ' '\n' | grep '^PATH=' || echo "   !! PATH MISSING"
echo "==> drop-ins present:"
ls -1 "$DROPIN_DIR"
echo "==> models (must match models-before.txt):"
/usr/local/bin/ollama list
echo
if diff -q <(sed 's/[[:space:]]\+/ /g' "$BACKUP_DIR/models-before.txt") \
           <(/usr/local/bin/ollama list | sed 's/[[:space:]]\+/ /g') >/dev/null 2>&1; then
    echo "==> OK: model inventory unchanged"
else
    echo "==> NOTE: model list differs from before (compare $BACKUP_DIR/models-before.txt)"
fi
echo "==> service state: $(systemctl is-active ollama)"
