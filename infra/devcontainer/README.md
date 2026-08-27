# Dev container sources

The canonical copies of the dev container config live **here**, in the repo.

## Why here and not only in `~/devcontainer-configs/`

The centralized-template convention (a `.devcontainer` symlink into
`~/devcontainer-configs/<template>/`, globally gitignored) keeps the config out of the
repo — which is fine until you are *inside* the container and need to fix the config.
The host path is not mounted, so from in there the template is neither readable nor
editable, and it has no version history to diff against when something breaks.

That is not hypothetical: the first hand-run of `init-firewall.sh` hung for 132 seconds
and allowlisted zero targets, from two bugs that were invisible without the source
(see the comments in `init-firewall.sh` — the stale `-P DROP` policy, and the `// empty`
jq-ism that mikefarah's yq rejects).

So: edit these files, then sync them out to the template. The symlink and the global
gitignore stay exactly as they are; this is a versioned upstream, not a replacement.

## Sync

```bash
# from the host, not the container
./infra/devcontainer/sync.sh
```

Then **Rebuild Container** in VS Code — `init-firewall.sh` and `fix-workspace-perms.sh`
are `COPY`d into the image at build time, so an edit does not take effect until a rebuild.

## Files

| File | Purpose |
|---|---|
| `Dockerfile` | Node 22 + Playwright deps + yq; narrows the base image's blanket sudo to two scripts |
| `devcontainer.json` | Mounts, `cap-drop=ALL` runtime hardening, host-gateway for Ollama |
| `init-firewall.sh` | Default-deny egress; allowlists infra hosts + every `url:` in `targets/*.yaml` |
| `fix-workspace-perms.sh` | Chowns the two named volumes; the only root-run chown `node` may invoke |

## The two-tier network model

The dev container holds credentials (`~/.claude`, `~/.npmrc`) and therefore keeps a
strict egress allowlist. The scraper needs to reach arbitrary sites, so it runs as a
separate compose service with **open egress and no credentials mounted** — it gets the
open internet precisely because there is nothing there worth stealing.

Adding a target widens the dev allowlist by exactly one hostname, on the next rebuild or
`sudo /usr/local/bin/init-firewall.sh`.
