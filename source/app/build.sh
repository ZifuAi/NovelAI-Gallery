#!/usr/bin/env bash
# Builds the Windows app and installer.
#
#   ./build.sh   ->  app/NovelAI-Gallery-Setup.exe
#
# Requires Go 1.24+, plus makensis if you want the installer as well.
# The gallery UI and the browser extension are compiled into the binary,
# so they're copied in fresh on every build.
set -euo pipefail
cd "$(dirname "$0")"

echo "==> syncing UI + extension into the binary"
rm -rf web extension
cp -r ../ui web
cp -r ../extension extension

echo "==> building windows/amd64"
CGO_ENABLED=0 GOOS=windows GOARCH=amd64 \
  go build -ldflags="-H windowsgui -s -w" -o novelai-gallery.exe .

# Stamp the icon and version info into the .exe. Go can't do this itself,
# and rcedit is a Windows tool, so this step is skipped where it isn't
# available - the app is identical either way, it just shows a generic icon.
if [ -n "${RCEDIT:-}" ] && [ -f "${RCEDIT}" ]; then
  echo "==> stamping icon + version info"
  ${WINE:-wine} "${RCEDIT}" novelai-gallery.exe \
    --set-icon icon.ico \
    --set-version-string "ProductName" "NovelAI Gallery" \
    --set-version-string "FileDescription" "A local gallery for your NovelAI images and prompts" \
    --set-version-string "CompanyName" "NovelAI Gallery" \
    --set-file-version "1.6.0" --set-product-version "1.6.0" \
    >/dev/null 2>&1 || echo "    (rcedit failed; continuing without icon)"
fi

if command -v makensis >/dev/null 2>&1; then
  echo "==> building installer"
  makensis -NOCD installer.nsi
  echo "==> done: NovelAI-Gallery-Setup.exe"
else
  echo "==> makensis not found — built novelai-gallery.exe only."
  echo "    That .exe runs standalone; the installer is just packaging."
fi
