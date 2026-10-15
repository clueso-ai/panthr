#!/bin/sh
# Sign a local build so macOS knows it is the same app from build to build,
# and the permissions granted to the last one (Screen Recording, the
# microphone) still apply.
#
# With an Apple Development certificate (Xcode's, in the keychain) the app is
# signed with it: macOS then knows it by its identifier and that certificate.
# Without one it is signed ad hoc, with the app's own requirement being its
# identifier. Inside out either way: the helpers in Resources (which --deep
# passes over) first, then the app.
set -e
APP="${1:-dist/mac-arm64/Panthr.app}"
ID=$(security find-identity -v -p codesigning | awk -F'"' '/Apple Development/ { print $2; exit }')
for bin in "$APP"/Contents/Resources/resources/bin/*; do
  [ -f "$bin" ] && [ -x "$bin" ] && codesign --force -s "${ID:--}" "$bin"
done
if [ -n "$ID" ]; then
  codesign --force --deep -s "$ID" "$APP"
else
  codesign --force --deep -s - "$APP"
  codesign --force -s - -r='designated => identifier "io.clueso.panthr"' "$APP"
fi
codesign --verify --deep --strict "$APP"
echo "signed: ${ID:-ad hoc}"
