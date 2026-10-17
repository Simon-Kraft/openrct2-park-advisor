#!/bin/sh
# Copy the plugin into OpenRCT2's plugin folder.
set -eu
cd "$(dirname "$0")"
DEST="${OPENRCT2_PLUGIN_DIR:-$HOME/.config/OpenRCT2/plugin}"
mkdir -p "$DEST"
install -m 644 plugin/advisor.js "$DEST/advisor.js"
echo "Deployed plugin/advisor.js -> $DEST/advisor.js ($(wc -c < plugin/advisor.js) bytes)"
if pgrep -f "openrct2-cli host" >/dev/null 2>&1; then
    echo "Note: OpenRCT2 does not hot-reload plugins while hosting; restart the server to load this version."
fi
