#!/bin/sh
# Builds release <version>'s binaries, for the maintainer (README "Releasing"): from a
# clean temporary worktree of HEAD (no leftover web build), with the Go toolchain
# pinned, for linux and darwin on amd64 and arm64. Writes dist/release/ (the binaries
# and checksums.txt, to upload) and release/checksums.txt, and sets version in
# herdr-plugin.toml: commit those two, tag the commit, push, then upload. Needs git,
# npm, Go (it downloads the pinned toolchain) and sha256sum or shasum.
set -eu
version=${1:?usage: scripts/release.sh <version, e.g. 0.1.0>}
toolchain=go1.27.4 # go.mod's toolchain line; a local Go may differ (a distro build)

root=$(git rev-parse --show-toplevel)
cd "$root"
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
	echo "release: commit your changes first (the binaries are built from HEAD)" >&2
	exit 1
fi
work=$(mktemp -d)
trap 'git worktree remove --force "$work/src" >/dev/null 2>&1; rm -rf "$work"' EXIT
git worktree add --detach "$work/src" HEAD
(cd "$work/src" && npm ci --ignore-scripts && npm run build:web)

out=$root/dist/release
rm -rf "$out"
mkdir -p "$out"
for target in linux/amd64 linux/arm64 darwin/amd64 darwin/arm64; do
	os=${target%/*}
	arch=${target#*/}
	(cd "$work/src" && GOTOOLCHAIN=$toolchain CGO_ENABLED=0 GOOS=$os GOARCH=$arch GOAMD64=v1 GOARM64=v8.0 \
		go build -trimpath -buildvcs=false \
		-ldflags "-s -w -X github.com/y011d4/herdr-plugin-agentweb/internal/bridge.Version=$version" \
		-o "$out/agentwebctl_${version}_${os}_${arch}" ./cmd/agentwebctl)
done
sum=sha256sum
command -v sha256sum >/dev/null 2>&1 || sum="shasum -a 256"
(cd "$out" && $sum agentwebctl_*) >"$out/checksums.txt"
mkdir -p release
cp "$out/checksums.txt" release/checksums.txt
sed "s/^version = \".*\"$/version = \"$version\"/" herdr-plugin.toml >"$work/manifest"
cat "$work/manifest" >herdr-plugin.toml
cat "$out/checksums.txt"
echo "release: built v$version from $(git rev-parse --short HEAD); next: commit herdr-plugin.toml and release/checksums.txt, tag v$version, push, gh release create v$version dist/release/*"
