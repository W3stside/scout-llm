#!/usr/bin/env bash
# Bake the `scout` model from models/Modelfile.scout.
#
# Uses the REST API rather than the `ollama` CLI because the dev container has no CLI —
# the daemon runs on the host and is reached over the bridge gateway.
#
# Creating a model does NOT load it into VRAM; it writes a manifest. Safe to run while
# another project's models are resident.
set -euo pipefail
IFS=$'\n\t'

OLLAMA_URL="${OLLAMA_URL:-http://host.docker.internal:11434}"
MODELFILE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/models/Modelfile.scout"
NAME="${SCOUT_MODEL:-scout}"

if [ ! -f "$MODELFILE" ]; then
    echo "not found: $MODELFILE" >&2
    exit 1
fi

echo "==> baking '$NAME' from $MODELFILE via $OLLAMA_URL"

python3 - "$MODELFILE" "$NAME" "$OLLAMA_URL" <<'PY'
import json, re, sys, urllib.request, urllib.error

modelfile, name, url = sys.argv[1], sys.argv[2], sys.argv[3]
text = open(modelfile).read()

base = re.search(r'^FROM\s+(\S+)\s*$', text, re.M)
if base is None:
    sys.exit("Modelfile has no FROM line")

system_match = re.search(r'SYSTEM\s+"""(.*?)"""', text, re.S)
system = system_match.group(1).strip() if system_match else ""

params = {}
for m in re.finditer(r'^PARAMETER\s+(\S+)\s+(\S+)\s*$', text, re.M):
    key, raw = m.group(1), m.group(2)
    params[key] = float(raw) if '.' in raw else int(raw)

payload = {"model": name, "from": base.group(1), "system": system,
           "parameters": params, "stream": False}
print(f"    base={base.group(1)} params={params}")

req = urllib.request.Request(f"{url}/api/create",
                             data=json.dumps(payload).encode(),
                             headers={"Content-Type": "application/json"})
try:
    with urllib.request.urlopen(req, timeout=600) as r:
        print("   ", r.read().decode()[:300])
except urllib.error.URLError as e:
    sys.exit(f"could not reach ollama at {url}: {e}")
PY

echo "==> verifying"
curl -fsS "${OLLAMA_URL}/api/show" -d "{\"model\":\"${NAME}\"}" \
    | python3 -c "
import sys, json
d = json.load(sys.stdin)
print('    capabilities:', ', '.join(d.get('capabilities', [])) or '(none)')
print('    quantization:', d.get('details', {}).get('quantization_level'))
"
echo "==> done. check with: yarn scout doctor"
