#!/bin/sh
# Sign a local build so macOS knows it is the same app from build to build.
# Without a developer certificate a build is signed ad hoc, and an ad-hoc
# signature names the app by its exact contents: every rebuild looks like a
# new app, and the permissions granted to the last one (Screen Recording,
# the microphone) no longer apply. Signed inside out, with the app's own
# requirement being its identifier, they carry over.
set -e
APP="${1:-dist/mac-arm64/Panthr.app}"
codesign --force --deep -s - "$APP"
codesign --force -s - -r='designated => identifier "io.clueso.panthr"' "$APP"
codesign --verify --deep --strict "$APP"
