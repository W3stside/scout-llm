#!/usr/bin/env bash
# Push the repo's dev container sources out to the centralized template.
#
# Run from the HOST — the template directory is not mounted inside the container, which
# is the whole reason these files are versioned here in the first place.
#
# A rebuild is required afterwards: init-firewall.sh and fix-workspace-perms.sh are COPY'd
# into the image, so editing them changes nothing until the image is rebuilt.
set -euo pipefail
IFS=$'\n\t'

TEMPLATE="${SCOUT_TEMPLATE_DIR:-$HOME/devcontainer-configs/TS-Node-Scout}"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ ! -d "$TEMPLATE" ]; then
    echo "template dir not found: $TEMPLATE" >&2
    echo "set SCOUT_TEMPLATE_DIR if it lives elsewhere" >&2
    exit 1
fi

changed=0
for file in Dockerfile devcontainer.json init-firewall.sh fix-workspace-perms.sh; do
    if [ ! -f "$SRC/$file" ]; then
        echo "  skip    $file (not in repo)"
        continue
    fi
    if [ -f "$TEMPLATE/$file" ] && cmp -s "$SRC/$file" "$TEMPLATE/$file"; then
        echo "  same    $file"
        continue
    fi
    cp "$SRC/$file" "$TEMPLATE/$file"
    echo "  synced  $file"
    changed=$((changed + 1))
done

chmod +x "$TEMPLATE/init-firewall.sh" "$TEMPLATE/fix-workspace-perms.sh" 2>/dev/null || true

echo
if [ "$changed" -gt 0 ]; then
    echo "$changed file(s) updated in $TEMPLATE"
    echo "Now run: VS Code > Dev Containers: Rebuild Container"
else
    echo "template already up to date"
fi
