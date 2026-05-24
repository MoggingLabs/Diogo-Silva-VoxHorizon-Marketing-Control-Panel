#!/usr/bin/env bash
#
# Build the VoxHorizon worker image locally.
#
# Tag mirrors the production GHCR coordinate so `docker compose up`
# picks up this build directly when its `image:` field also points at
# `ghcr.io/mogginglabs/voxhorizon-worker:local`. CI (VPS-4 / #161) builds
# the same Dockerfile and pushes `:main` / `:<sha>` / `:latest`.
#
# Run from the repo root:
#
#   ./worker/scripts/docker-build.sh
#
set -euo pipefail

docker build \
    -t ghcr.io/mogginglabs/voxhorizon-worker:local \
    -f worker/Dockerfile \
    worker/
