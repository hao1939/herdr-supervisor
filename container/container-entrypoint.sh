#!/bin/bash
set -eu

pi_agent_dir="${PI_CODING_AGENT_DIR:-/home/node/.pi/agent}"
legacy_extension="${pi_agent_dir}/extensions/herdr-supervisor.ts"
codex_skill_root="${CODEX_HOME:-/home/node/.codex}/skills"
goal_skill_target="${codex_skill_root}/herdr-goals"

# Remove only the discovery link installed by previous container versions.
# Dedicated supervisors now load src/extension.ts explicitly with Pi's -e.
if [ -L "$legacy_extension" ] && [ "$(readlink "$legacy_extension")" = /opt/herdr-supervisor/container/pi-extension.ts ]; then
  rm -- "$legacy_extension"
fi

# Make goal-management guidance available to ordinary Codex management panes
# without modifying a mounted workspace. Create only a missing entry so an
# operator-provided directory or symlink remains authoritative.
mkdir -p "$codex_skill_root"
if [ ! -e "$goal_skill_target" ] && [ ! -L "$goal_skill_target" ]; then
  ln -sfn /opt/herdr-supervisor/skills/herdr-goals "$goal_skill_target"
fi

watcher_pid=""
if [ -n "${HERDR_WATCH_GITHUB_REPOSITORIES:-}${HERDR_WATCH_ADO_DEFINITIONS:-}${HERDR_WATCH_ADO_REPOSITORIES:-}" ]; then
  echo "Starting the shared external event watcher (event-watchd)." >&2
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
  echo "The shared external event watcher (event-watchd) stopped unexpectedly." >&2
  [ "$status" -ne 0 ] || status=1
  kill "$main_pid" 2>/dev/null || true
  wait "$main_pid" 2>/dev/null || true
else
  kill "$watcher_pid" 2>/dev/null || true
  wait "$watcher_pid" 2>/dev/null || true
fi
exit "$status"
