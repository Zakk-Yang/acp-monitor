#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/../.." && pwd)"
port="${PORT:-1234}"
health_url="http://127.0.0.1:${port}/api/health"
app_url="http://localhost:${port}"
state_dir="${XDG_STATE_HOME:-$HOME/.local/state}/acp-monitor"
log_path="${state_dir}/launcher.log"
unit_name="acp-monitor-dashboard"

mkdir -p "$state_dir"

require_command() {
  local name="$1"

  if ! command -v "$name" >/dev/null 2>&1; then
    echo "Missing required command: $name" >&2
    exit 1
  fi
}

is_healthy() {
  curl --silent --show-error --fail --max-time 2 "$health_url" >/dev/null 2>&1
}

port_is_listening() {
  if ! command -v ss >/dev/null 2>&1; then
    return 1
  fi

  ss -ltn "sport = :${port}" | awk 'NR > 1 { found = 1 } END { exit found ? 0 : 1 }'
}

describe_port_listener() {
  if ! command -v ss >/dev/null 2>&1; then
    return 0
  fi

  ss -ltnp "sport = :${port}" | awk 'NR > 1 { print; exit }'
}

any_newer_than() {
  local marker="$1"
  shift
  local path

  for path in "$@"; do
    if [[ -e "$path" && "$path" -nt "$marker" ]]; then
      return 0
    fi
  done

  return 1
}

tree_has_newer_files() {
  local marker="$1"
  shift
  local tree

  for tree in "$@"; do
    [[ -d "$tree" ]] || continue

    if find "$tree" -type f -newer "$marker" -print -quit | grep -q .; then
      return 0
    fi
  done

  return 1
}

server_has_newer_files() {
  local marker="$1"

  [[ -d "$project_root/server" ]] || return 1

  find "$project_root/server" \
    -path "$project_root/server/dist" -prune -o \
    -type f -newer "$marker" -print -quit | grep -q .
}

needs_build() {
  local frontend_marker="$project_root/dist/index.html"
  local backend_marker="$project_root/server/dist/index.js"

  if [[ ! -f "$frontend_marker" || ! -f "$backend_marker" ]]; then
    return 0
  fi

  if any_newer_than "$frontend_marker" \
    "$project_root/index.html" \
    "$project_root/package.json" \
    "$project_root/package-lock.json" \
    "$project_root/tsconfig.json" \
    "$project_root/tsconfig.app.json" \
    "$project_root/tsconfig.node.json" \
    "$project_root/vite.config.ts"; then
    return 0
  fi

  if tree_has_newer_files "$frontend_marker" "$project_root/src" "$project_root/public"; then
    return 0
  fi

  if any_newer_than "$backend_marker" \
    "$project_root/package.json" \
    "$project_root/package-lock.json" \
    "$project_root/tsconfig.json" \
    "$project_root/server/tsconfig.json"; then
    return 0
  fi

  if server_has_newer_files "$backend_marker"; then
    return 0
  fi

  return 1
}

build_if_needed() {
  if [[ ! -d "$project_root/node_modules" ]]; then
    echo "Dependencies are missing. Run 'npm install' in $project_root first." >&2
    exit 1
  fi

  if needs_build; then
    echo "Building ACP Monitor..."
    (cd "$project_root" && npm run build)
  fi
}

start_server() {
  local node_path

  node_path="$(command -v node)"

  if command -v systemd-run >/dev/null 2>&1 && systemctl --user is-system-running >/dev/null 2>&1; then
    echo "Starting ACP Monitor through the WSL user systemd manager..."
    systemctl --user stop "${unit_name}.service" >/dev/null 2>&1 || true
    systemctl --user reset-failed "${unit_name}.service" >/dev/null 2>&1 || true

    systemd-run --user \
      --quiet \
      --unit "$unit_name" \
      --collect \
      --working-directory="$project_root" \
      --setenv="HOME=$HOME" \
      --setenv="NODE_ENV=production" \
      --setenv="PORT=$port" \
      --setenv="PATH=$PATH" \
      --property="StandardOutput=append:$log_path" \
      --property="StandardError=append:$log_path" \
      "$node_path" "$project_root/server/dist/index.js" >/dev/null
    return 0
  fi

  echo "Starting ACP Monitor in the background..."
  (
    cd "$project_root"
    if command -v setsid >/dev/null 2>&1; then
      setsid env PORT="$port" npm run start >>"$log_path" 2>&1 < /dev/null &
    else
      nohup env PORT="$port" npm run start >>"$log_path" 2>&1 < /dev/null &
    fi
  )
}

print_recent_logs() {
  if command -v journalctl >/dev/null 2>&1 && systemctl --user status "${unit_name}.service" >/dev/null 2>&1; then
    journalctl --user -u "${unit_name}.service" -n 40 --no-pager >&2 || true
    return 0
  fi

  tail -n 40 "$log_path" >&2 || true
}

wait_for_health() {
  local attempts=30

  while (( attempts > 0 )); do
    if is_healthy; then
      return 0
    fi

    sleep 1
    ((attempts -= 1))
  done

  return 1
}

require_command npm
require_command curl

if is_healthy; then
  echo "ACP Monitor is already running at ${app_url}"
  exit 0
fi

if port_is_listening; then
  echo "Port ${port} is already in use, so ACP Monitor cannot start there." >&2
  listener="$(describe_port_listener)"
  if [[ -n "$listener" ]]; then
    echo "$listener" >&2
  fi
  echo "Stop the existing process or rerun with PORT=<free-port> bash ops/wsl/start-acp-monitor.sh" >&2
  exit 1
fi

build_if_needed
start_server

if wait_for_health; then
  echo "ACP Monitor is ready at ${app_url}"
  exit 0
fi

echo "ACP Monitor did not become ready. Recent log output:" >&2
print_recent_logs
exit 1
