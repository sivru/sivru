#!/usr/bin/env bash
# Record beat 2 (the gate — the money shot) as a crisp, small GIF. One command,
# capture is automatic: no typing into a live recording, no manual trimming.
#
#   ./record-beat2.sh
#
# Produces (next to this script):
#   beat2.cast   the asciinema recording (commit-able / uploadable to the README)
#   beat2.gif    rendered GIF, ready to stitch with beat 1 + the closing card
#
# Requires: asciinema, agg   ->   brew install asciinema agg
# The demo repo is (re)generated fresh each run; nothing outside /tmp is touched.
#
# Beat 1 (the map) and the closing card are still human steps — see STORYBOARD.md.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../.." && pwd)"
DEMO="${SIVRU_DEMO_DIR:-/tmp/sivru-demo}"

for t in asciinema agg; do
  command -v "$t" >/dev/null 2>&1 || { echo "missing '$t' — run: brew install asciinema agg"; exit 1; }
done

# Resolve the sivru command. Prefer THIS repo's local build (the version being
# launched, so the recording matches the verified storyboard output); fall back
# to a global install. Note: 'command sivru' below bypasses the on-screen shell
# function so the global path doesn't recurse into itself.
if [ -f "$REPO_ROOT/packages/cli/dist/index.js" ]; then
  SIVRU_CMD="node $REPO_ROOT/packages/cli/dist/index.js"
elif command -v sivru >/dev/null 2>&1; then
  SIVRU_CMD="command sivru"
else
  echo "no sivru found."
  echo "  build it:   pnpm --filter @sivru/cli build   (from the repo root)"
  echo "  or install: npm install -g @sivru/cli"
  exit 1
fi

# 1) fresh demo repo, parked on the agent's 'refactor' branch.
"$HERE/make-demo.sh" "$DEMO" >/dev/null
git -C "$DEMO" checkout -q agent/refactor-session

# 2) the inner driver — exactly what the viewer sees: the prompt, the command
#    "typed" at a readable pace, then the real gate output and exit code.
DRIVER="/tmp/sivru-beat2-driver.sh"
cat > "$DRIVER" <<DRIVEREOF
#!/usr/bin/env bash
set -uo pipefail
# Show 'sivru' on screen; run whichever binary we resolved.
sivru() { ${SIVRU_CMD} "\$@"; }
type_line() { printf '\$ '; local s="\$1"; for ((i=0; i<\${#s}; i++)); do printf '%s' "\${s:\$i:1}"; sleep 0.035; done; printf '\n'; }
cd "${DEMO}"
sleep 0.8
type_line "sivru explain --project --diff --gate --base=main"
sleep 0.4
sivru explain --project --diff --gate --base=main; rc=\$?
printf '\nexit=%d\n' "\$rc"
sleep 3.0
DRIVEREOF
chmod +x "$DRIVER"

# 3) record (asciicast-v2 for agg) then render a tight GIF.
rm -f "$HERE/beat2.cast" "$HERE/beat2.gif"
asciinema rec "$HERE/beat2.cast" -f asciicast-v2 --rows 18 --cols 96 -c "bash $DRIVER"
agg --theme monokai --font-size 22 --idle-time-limit 2 "$HERE/beat2.cast" "$HERE/beat2.gif"

echo
echo "Done:"
echo "  $HERE/beat2.cast"
echo "  $HERE/beat2.gif"
echo
echo "Next (human steps, see STORYBOARD.md):"
echo "  - Beat 1 (the map): screen-record /tmp/sivru-demo-map.html, drilling System -> auth -> validateSession."
echo "  - Stitch beat1 + beat2 + closing card into docs/assets/demo.gif (< ~3 MB)."