#!/bin/sh
# Puts bin/yoicks, the Go binary the manifest runs (herdr-plugin.toml), in place.
#
#   sh scripts/plugin-build.sh          build this checkout from source: a linked
#                                       checkout, run by hand (herdr never runs
#                                       [[build]] for a linked plugin). Needs Go
#                                       (go.mod's version) and npm (the web UI).
#   sh scripts/plugin-build.sh release  download the release binary of this version
#                                       (herdr-plugin.toml) for this OS and CPU and check
#                                       it against release/checksums.txt: the manifest's
#                                       [[build]], which herdr runs on `herdr plugin
#                                       install`/`update`
#
# The checksums are committed with the version (scripts/release.sh), so the binary is
# trusted exactly as far as this checkout is. A mismatch fails, and never falls back
# to a source build. YOICKS_RELEASE_URL replaces the GitHub releases URL (a mirror,
# or a local server for testing a release before it is published).
set -eu
cd "$(dirname "$0")/.."

if [ "${1:-}" != release ]; then
	for tool in go npm; do
		if ! command -v $tool >/dev/null 2>&1; then
			echo "plugin-build: building from source needs $tool; or download this version's release binary: sh scripts/plugin-build.sh release" >&2
			exit 1
		fi
	done
	npm ci --ignore-scripts
	npm run build:web
	mkdir -p bin
	go build -o bin/yoicks ./cmd/yoicks
	exit 0
fi

version=$(sed -n 's/^version = "\(.*\)"$/\1/p' herdr-plugin.toml)
case $(uname -s) in Linux) os=linux ;; Darwin) os=darwin ;; *) os=$(uname -s) ;; esac
case $(uname -m) in x86_64 | amd64) arch=amd64 ;; aarch64 | arm64) arch=arm64 ;; *) arch=$(uname -m) ;; esac
name=yoicks_${version}_${os}_${arch}
want=$(awk -v n="$name" '$2 == n { print $1 }' release/checksums.txt 2>/dev/null || true)
if [ -z "$want" ]; then
	echo "plugin-build: release/checksums.txt has no $name: install a released version" \
		"(herdr plugin install y011d4/herdr-yoicks --ref v<version>)," \
		"or build from source with: sh scripts/plugin-build.sh" >&2
	exit 1
fi

url=${YOICKS_RELEASE_URL:-https://github.com/y011d4/herdr-yoicks/releases/download}/v$version/$name
mkdir -p bin
tmp=bin/yoicks.download
trap 'rm -f "$tmp"' EXIT
echo "plugin-build: downloading $url"
if command -v curl >/dev/null 2>&1; then
	curl -fsSL -o "$tmp" "$url"
elif command -v wget >/dev/null 2>&1; then
	wget -q -O "$tmp" "$url"
else
	echo "plugin-build: needs curl or wget to download $url" >&2
	exit 1
fi
if command -v sha256sum >/dev/null 2>&1; then
	got=$(sha256sum "$tmp" | cut -d' ' -f1)
else
	got=$(shasum -a 256 "$tmp" | cut -d' ' -f1)
fi
if [ "$got" != "$want" ]; then
	echo "plugin-build: checksum mismatch for $name: got $got, release/checksums.txt says $want; not installing it" >&2
	exit 1
fi
chmod 755 "$tmp"
mv "$tmp" bin/yoicks
echo "plugin-build: installed bin/yoicks $version ($os/$arch)"
