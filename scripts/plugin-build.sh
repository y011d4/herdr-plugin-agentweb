#!/bin/sh
# Puts bin/agentwebctl, the Go binary the manifest runs (herdr-plugin.toml), in place.
# herdr runs this as [[build]] from the plugin root on `herdr plugin install`/`update`,
# but not on `herdr plugin link`: after a local link, run it by hand.
#
#   sh scripts/plugin-build.sh          download the release binary of this version
#                                       (herdr-plugin.toml) for this OS and CPU, and
#                                       check it against release/checksums.txt
#   sh scripts/plugin-build.sh source   build from source instead: development (needs
#                                       Go, go.mod's version, and npm for the web UI)
#
# The checksums are committed with the version (scripts/release.sh), so the binary is
# trusted exactly as far as this checkout is. A mismatch fails, and never falls back
# to a source build. AGENTWEB_RELEASE_URL replaces the GitHub releases URL (a mirror,
# or a local server for testing a release before it is published).
set -eu
cd "$(dirname "$0")/.."

if [ "${1:-}" = source ]; then
	npm ci --ignore-scripts
	npm run build:web
	go build -o bin/agentwebctl ./cmd/agentwebctl
	exit 0
fi

version=$(sed -n 's/^version = "\(.*\)"$/\1/p' herdr-plugin.toml)
case $(uname -s) in Linux) os=linux ;; Darwin) os=darwin ;; *) os=$(uname -s) ;; esac
case $(uname -m) in x86_64 | amd64) arch=amd64 ;; aarch64 | arm64) arch=arm64 ;; *) arch=$(uname -m) ;; esac
name=agentwebctl_${version}_${os}_${arch}
want=$(awk -v n="$name" '$2 == n { print $1 }' release/checksums.txt 2>/dev/null || true)
if [ -z "$want" ]; then
	echo "plugin-build: release/checksums.txt has no $name: install a released version" \
		"(herdr plugin install y011d4/herdr-plugin-agentweb --ref v<version>)," \
		"or build from source with: sh scripts/plugin-build.sh source" >&2
	exit 1
fi

url=${AGENTWEB_RELEASE_URL:-https://github.com/y011d4/herdr-plugin-agentweb/releases/download}/v$version/$name
mkdir -p bin
tmp=bin/agentwebctl.download
trap 'rm -f "$tmp"' EXIT
echo "plugin-build: downloading $url"
if command -v curl >/dev/null 2>&1; then
	curl -fsSL -o "$tmp" "$url"
else
	wget -q -O "$tmp" "$url"
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
mv "$tmp" bin/agentwebctl
echo "plugin-build: installed bin/agentwebctl $version ($os/$arch)"
