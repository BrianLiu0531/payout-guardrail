#!/usr/bin/env bash
# Stops what scripts/demo-start.sh started. Data is kept: `docker compose down -v` (or
# `npm run demo:reset`) wipes it.
cd "$(dirname "$0")/.."
for name in web indexer api signer; do
  if [ -f ".cache/$name.pid" ]; then
    pid=$(cat ".cache/$name.pid")
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
    rm -f ".cache/$name.pid"
    echo "stopped $name"
  fi
done
docker compose stop
