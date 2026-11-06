#!/usr/bin/env bash
# Shared by demo-start.sh and demo-stop.sh.

# Stops a service started by demo-start.sh, including the node/go processes npm started under it.
stop_service() {
  local name=$1 pidfile=".cache/$1.pid"
  [ -f "$pidfile" ] || return 0
  local pid; pid=$(cat "$pidfile")
  if [ -r "/proc/$pid/winpid" ] && command -v taskkill > /dev/null; then
    # Git Bash on Windows: no process groups; kill the Windows process tree instead.
    taskkill //F //T //PID "$(cat "/proc/$pid/winpid")" > /dev/null 2>&1 || true
  else
    kill -- "-$pid" 2>/dev/null || kill "$pid" 2>/dev/null || true
  fi
  rm -f "$pidfile"
  echo "stopped $name"
}
