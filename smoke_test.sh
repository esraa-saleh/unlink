#!/usr/bin/env bash
set -e
ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "Checking manifest JSON..."
python3 -m json.tool "$ROOT/manifest.json" >/dev/null

echo "Checking JavaScript syntax..."
node --check "$ROOT/background.js"
node --check "$ROOT/popup.js"
node --check "$ROOT/chooser.js"
node --check "$ROOT/options.js"

echo "Checking required files..."
for f in manifest.json background.js popup.html popup.js popup.css chooser.html chooser.js chooser.css options.html options.js options.css README.md; do
  test -f "$ROOT/$f"
done

echo "OK: Unlink v3 static smoke test passed."
