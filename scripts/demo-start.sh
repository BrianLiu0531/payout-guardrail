#!/usr/bin/env bash
# Starts the whole demo in the background: Postgres, anvil and local KMS (Docker), the demo seed,
# then the signer, the API, base-usdc-indexer and the web app. Used by the Codespaces
# devcontainer; works the same on any machine with Docker, Node 22 and Go.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .cache/logs

docker compose up -d --wait
npm run seed

start() {
  local name=$1; shift
  # Running this script again stops the previous copy first. Each service runs in its own
  # process group (setsid), so stopping it also stops the node/go processes npm started.
  if [ -f ".cache/$name.pid" ]; then
    local old; old=$(cat ".cache/$name.pid")
    kill -- "-$old" 2>/dev/null || kill "$old" 2>/dev/null || true
    sleep 1
  fi
  if command -v setsid > /dev/null; then
    setsid nohup "$@" > ".cache/logs/$name.log" 2>&1 < /dev/null &
  else
    nohup "$@" > ".cache/logs/$name.log" 2>&1 < /dev/null &
  fi
  echo $! > ".cache/$name.pid"
  echo "started $name (logs: .cache/logs/$name.log)"
}

start signer npm run dev:signer
sleep 3
start api npm run dev:api
start indexer npm run dev:indexer
# Bind IPv4 loopback explicitly ("localhost" may resolve to ::1 only). The workspace script is called
# directly so that `--host` reaches Vite instead of being taken as an npm option.
start web npm run dev -w @guardrail/web -- --host 127.0.0.1

for i in $(seq 1 60); do
  if curl -sf http://127.0.0.1:5173/v1/auth/me > /dev/null; then
    echo "ready: open the forwarded port 5173"
    exit 0
  fi
  sleep 2
done
echo "the app did not come up within 2 minutes; see .cache/logs/" >&2
exit 1
