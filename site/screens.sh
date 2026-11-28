#!/bin/sh
# The landing's screenshots, site/static/screens/*.webp: the app over tools/shots-fixture.ts's made-up data, shot by
# the PR screenshots' own tool (`tools/e2e.ts shots`: a frozen clock, no animations, the same build gives the same
# pixels), then made small with ImageMagick. Never real data or names: the site is public. Run it again when the
# look changes, from anywhere in the repo, and commit what it writes:
#
#   sh site/screens.sh      # needs the root's `npm ci`, Chrome (as e2e.ts finds it) and `magick`
#
# It builds the web UI (web/dist) first. A screen that didn't become ready stops it before anything is written.
set -eu
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

npx vite build > "$tmp/build.log" 2>&1 || { cat "$tmp/build.log"; exit 1; }
node tools/e2e.ts shots --after web/dist --out "$tmp/shots" --only home,home-needs,home-agents > "$tmp/shots.log" 2>&1 ||
  { cat "$tmp/shots.log"; exit 1; }
node -e 'const m = require(process.argv[1]); const bad = m.shots.filter((s) => s.notReady.length).map((s) => s.name);
  if (bad.length) { console.error(`not ready: ${bad.join(", ")}`); process.exit(1); }' "$tmp/shots/manifest.json"

# <shot> <width>: a PC's at its 1280 px; a phone's (390 px wide at 2x) at 540 px, 2x of the ~270 px the page shows
out=site/static/screens
mkdir -p "$out"
while read -r shot width; do
  magick "$tmp/shots/$shot.after.png" -resize "${width}x" -strip -quality 82 "$out/$shot.webp"
  echo "$out/$shot.webp $(magick identify -format '%wx%h' "$out/$shot.webp") $(wc -c < "$out/$shot.webp") bytes"
done <<EOF
home-pc 1280
home-phone 540
needs-popover-phone 540
agents-popover-phone 540
EOF
