#!/bin/sh
# Builds bin/agentwebctl, the Go binary the manifest runs (herdr-plugin.toml). herdr
# runs this as [[build]] from the plugin root on `herdr plugin install`/`update`, but
# not on `herdr plugin link`: after a local link, run it by hand. Until releases exist
# it builds from source, so it needs Go (go.mod's version) and npm, for the web UI the
# binary embeds. P6 replaces it with a download checked against release/checksums.txt
# (docs/go-migration-plan.md §8.2).
set -eu
npm ci --ignore-scripts
npm run build:web
go build -o bin/agentwebctl ./cmd/agentwebctl
