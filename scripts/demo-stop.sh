#!/usr/bin/env bash
# Stops what scripts/demo-start.sh started. Data is kept: `docker compose down -v` (or
# `npm run demo:reset`) wipes it.
cd "$(dirname "$0")/.."
source scripts/lib.sh
for name in web indexer api signer; do stop_service "$name"; done
docker compose stop
