#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/../.." && pwd)"
service_name="acp-monitor"
service_path="/etc/systemd/system/${service_name}.service"
dry_run=0
skip_build=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)
      dry_run=1
      ;;
    --skip-build)
      skip_build=1
      ;;
    *)
      echo "Unknown option: $1" >&2
      echo "Usage: $0 [--dry-run] [--skip-build]" >&2
      exit 1
      ;;
  esac
  shift
done

if ! command -v systemctl >/dev/null 2>&1; then
  echo "systemctl was not found. This installer is for Linux/WSL systems with systemd." >&2
  exit 1
fi

if ! command -v sudo >/dev/null 2>&1; then
  echo "sudo was not found. Install sudo or create the service file manually." >&2
  exit 1
fi

prompt_value() {
  local label="$1"
  local default_value="${2-}"
  local value=""

  while true; do
    if [[ -n "$default_value" ]]; then
      read -r -p "$label [$default_value]: " value
      value="${value:-$default_value}"
    else
      read -r -p "$label: " value
    fi

    if [[ -n "$value" ]]; then
      printf '%s\n' "$value"
      return 0
    fi

    echo "A value is required."
  done
}

prompt_existing_dir() {
  local label="$1"
  local default_value="${2-}"
  local value=""

  while true; do
    value="$(prompt_value "$label" "$default_value")"
    if [[ -d "$value" ]]; then
      printf '%s\n' "$value"
      return 0
    fi

    echo "That directory was not found: $value"
    default_value=""
  done
}

prompt_existing_executable() {
  local label="$1"
  local default_value="${2-}"
  local value=""

  while true; do
    value="$(prompt_value "$label" "$default_value")"
    if [[ -x "$value" ]]; then
      printf '%s\n' "$value"
      return 0
    fi

    echo "That path is not executable: $value"
    default_value=""
  done
}

prompt_optional_path() {
  local label="$1"
  local default_value="${2-}"
  local value=""

  while true; do
    if [[ -n "$default_value" ]]; then
      read -r -p "$label [$default_value]: " value
      value="${value:-$default_value}"
    else
      read -r -p "$label (leave blank to skip): " value
    fi

    if [[ -z "$value" ]]; then
      printf '\n'
      return 0
    fi

    if [[ -x "$value" ]]; then
      printf '%s\n' "$value"
      return 0
    fi

    echo "That path is not executable: $value"
  done
}

detect_executable() {
  local name="$1"
  command -v "$name" 2>/dev/null || true
}

append_unique_dir() {
  local dir="$1"
  if [[ -z "$dir" ]]; then
    return 0
  fi

  case ":$extra_bin_paths:" in
    *":$dir:"*) ;;
    *)
      if [[ -n "$extra_bin_paths" ]]; then
        extra_bin_paths="${extra_bin_paths}:$dir"
      else
        extra_bin_paths="$dir"
      fi
      ;;
  esac
}

echo "ACP Monitor WSL/systemd installer"
echo

linux_user="$(id -un 2>/dev/null || true)"
home_path="${HOME:-}"
node_path="$(detect_executable node)"
codex_path="$(detect_executable codex)"
claude_path="$(detect_executable claude)"

if [[ -z "$linux_user" ]]; then
  linux_user="$(prompt_value 'Linux username')"
fi

if [[ -z "$home_path" || ! -d "$home_path" ]]; then
  home_path="$(prompt_existing_dir 'Home directory path')"
fi

if [[ ! -d "$project_root" ]]; then
  project_root="$(prompt_existing_dir 'ACP Monitor project path')"
fi

if [[ -z "$node_path" ]]; then
  echo "Could not auto-detect the full path to node."
  echo "Copy and paste it below. Example: /home/your-user/.nvm/versions/node/v22.x.x/bin/node"
  node_path="$(prompt_existing_executable 'Full path to node')"
fi

if [[ ! -x "$node_path" ]]; then
  echo "The node path is not executable: $node_path" >&2
  exit 1
fi

if [[ -z "$codex_path" ]]; then
  echo "codex was not auto-detected."
  echo "Paste the full path if you want the service to read Codex usage immediately."
  codex_path="$(prompt_optional_path 'Full path to codex')"
fi

if [[ -z "$claude_path" ]]; then
  echo "claude was not auto-detected."
  echo "Paste the full path if you want the service to read Claude usage immediately."
  claude_path="$(prompt_optional_path 'Full path to claude')"
fi

extra_bin_paths=""
append_unique_dir "$(dirname "$node_path")"
if [[ -n "$codex_path" ]]; then
  append_unique_dir "$(dirname "$codex_path")"
fi
if [[ -n "$claude_path" ]]; then
  append_unique_dir "$(dirname "$claude_path")"
fi

if [[ -z "$extra_bin_paths" ]]; then
  extra_bin_paths="$(prompt_value 'Extra PATH directories for the service (colon-separated)')"
fi

echo
echo "Detected configuration"
echo "User: $linux_user"
echo "Home: $home_path"
echo "Project: $project_root"
echo "Node: $node_path"
echo "Extra PATH: $extra_bin_paths"
echo

build_answer="y"
if [[ "$skip_build" -eq 0 ]]; then
  read -r -p "Run 'npm run build' before installing the service? [Y/n]: " build_answer
fi

if [[ "$skip_build" -eq 0 && ! "${build_answer:-}" =~ ^[Nn]$ ]]; then
  (cd "$project_root" && npm run build)
fi

tmp_service="$(mktemp)"
cat >"$tmp_service" <<EOF
[Unit]
Description=ACP Monitor
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$linux_user
WorkingDirectory=$project_root
Environment=HOME=$home_path
Environment=NODE_ENV=production
Environment=PORT=5173
Environment=PATH=$extra_bin_paths:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=$node_path $project_root/server/dist/index.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

echo
echo "Installing $service_path"
if [[ "$dry_run" -eq 1 ]]; then
  echo "Dry run enabled. Generated service file:"
  echo
  cat "$tmp_service"
  rm -f "$tmp_service"
else
  sudo install -m 0644 "$tmp_service" "$service_path"
  rm -f "$tmp_service"

  sudo systemctl daemon-reload
  sudo systemctl enable --now "$service_name"

  echo
  echo "Service installed and started."
  echo "Check status with: sudo systemctl status $service_name"
  echo "Check logs with:   sudo journalctl -u $service_name -f"
fi

if [[ -n "${WSL_DISTRO_NAME:-}" ]] && command -v wslpath >/dev/null 2>&1; then
  windows_project_path="$(wslpath -w "$project_root" 2>/dev/null || true)"
  if [[ -n "$windows_project_path" ]]; then
    echo
    echo "Optional Windows startup command"
    echo "Run this once in Windows PowerShell if you want WSL to launch automatically at login:"
    printf 'powershell -ExecutionPolicy Bypass -File "%s\\ops\\windows\\Register-AcpMonitorWslAutostart.ps1" -DistroName "%s"\n' \
      "$windows_project_path" \
      "$WSL_DISTRO_NAME"
  fi
fi
