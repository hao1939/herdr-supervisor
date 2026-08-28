#!/bin/sh
set -eu

pi_agent_dir="${PI_CODING_AGENT_DIR:-/home/node/.pi/agent}"
extension_dir="${pi_agent_dir}/extensions"

mkdir -p "$extension_dir"
ln -sfn /opt/herdr-supervisor/container/pi-extension.ts "$extension_dir/herdr-supervisor.ts"

exec "$@"
