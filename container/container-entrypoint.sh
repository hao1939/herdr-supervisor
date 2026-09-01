#!/bin/bash
set -eu

pi_agent_dir="${PI_CODING_AGENT_DIR:-/home/node/.pi/agent}"
extension_dir="${pi_agent_dir}/extensions"

mkdir -p "$extension_dir"
ln -sfn /opt/herdr-supervisor/container/pi-extension.ts "$extension_dir/herdr-supervisor.ts"

watcher_pid=""
if [ -n "${HERDR_WATCH_GITHUB_REPOSITORIES:-}${HERDR_WATCH_ADO_DEFINITIONS:-}" ]; then
  echo "Starting the shared provider metadata watcher." >&2
  node /opt/herdr-supervisor/src/event-watcher/daemon.mjs &
  watcher_pid=$!
fi

if [ -z "$watcher_pid" ]; then
  exec "$@"
fi

"$@" <&0 &
main_pid=$!

trap '
  kill "$main_pid" 2>/dev/null || true
  if [ -n "$watcher_pid" ]; then
    kill "$watcher_pid" 2>/dev/null || true
  fi
' INT TERM

set +e
wait -n -p stopped_pid "$main_pid" "$watcher_pid"
status=$?
if [ "${stopped_pid:-}" = "$watcher_pid" ]; then
  echo "The shared provider metadata watcher stopped unexpectedly." >&2
  [ "$status" -ne 0 ] || status=1
  kill "$main_pid" 2>/dev/null || true
  wait "$main_pid" 2>/dev/null || true
else
  kill "$watcher_pid" 2>/dev/null || true
  wait "$watcher_pid" 2>/dev/null || true
fi
exit "$status"
