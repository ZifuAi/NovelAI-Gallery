#!/usr/bin/env bash
# Runs everything: the Go tests, then the browser suites.
#
#   ./tests/run.sh              all suites
#   ./tests/run.sh folderui     one suite
#
# The browser suites need Playwright's chromium. If `node -e "require('playwright')"`
# fails, install it once with:
#
#   npm install playwright && npx playwright install chromium
#
# Each suite starts its own copy of the app with its own throwaway data
# directory, seeds it with generated PNGs carrying NovelAI metadata, drives
# the real interface, then cleans up. Nothing touches your own library.
set -euo pipefail
cd "$(dirname "$0")/.."

# app/web and app/extension are go:embed targets built from ui/ and
# extension/. They are generated, not checked in, so this has to happen
# before anything compiles - including `go test`, which fails at the embed
# directive rather than at a test.
echo "==> syncing ui/ and extension/ into the embed directories"
(cd app && rm -rf web extension && cp -r ../ui web && cp -r ../extension extension)

echo "==> go tests"
(cd app && go test ./ -race)

echo "==> building a linux binary for the browser suites"
# The shipped app is Windows-only, but it builds and runs headless on Linux
# and macOS, which is what the browser suites drive.
(cd app && go build -o nag-dev . && rm -f novelai-gallery)

mkdir -p tests/screenshots

SUITES=("${@:-}")
if [ -z "${SUITES[0]:-}" ]; then
  SUITES=(update regression folderui fixes nsfwtoggle promptgen generate)
fi

failed=0
for s in "${SUITES[@]}"; do
  echo "==> $s"
  node "tests/$s.test.js" || failed=1
done

# The dev binary is a build artifact; leaving it around has previously found
# its way into a release bundle and added 10 MB to it.
rm -f app/nag-dev

exit $failed
