#!/bin/sh
# Copy the plugin into OpenRCT2's plugin folder.
set -eu
cd "$(dirname "$0")"
if [ "$(uname)" = "Darwin" ]; then
    DEFAULT_DEST="$HOME/Library/Application Support/OpenRCT2/plugin"
else
    DEFAULT_DEST="$HOME/.config/OpenRCT2/plugin"
fi
DEST="${OPENRCT2_PLUGIN_DIR:-$DEFAULT_DEST}"
mkdir -p "$DEST"
install -m 644 plugin/park-advisor.js "$DEST/park-advisor.js"
echo "Deployed plugin/park-advisor.js -> $DEST/park-advisor.js ($(wc -c < plugin/park-advisor.js) bytes)"
# Remove the copy deployed under the project's old name, or both would load and compete for the port.
if [ -f "$DEST/advisor.js" ] && grep -q 'name: "ParkAdvisor"' "$DEST/advisor.js"; then
    rm "$DEST/advisor.js"
    echo "Removed old $DEST/advisor.js"
fi
if pgrep -f "openrct2-cli host" >/dev/null 2>&1; then
    echo "Note: OpenRCT2 does not hot-reload plugins while hosting; restart the server to load this version."
fi
