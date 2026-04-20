#!/usr/bin/env bash

set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
project_root="$(cd "$script_dir/../.." && pwd)"

if [[ -z "${WSL_DISTRO_NAME:-}" ]]; then
  echo "This installer is only meant to run inside WSL." >&2
  exit 1
fi

if ! command -v wslpath >/dev/null 2>&1; then
  echo "wslpath is required to create the Windows desktop shortcut." >&2
  exit 1
fi

if ! command -v powershell.exe >/dev/null 2>&1; then
  echo "powershell.exe is required to create the Windows desktop shortcut." >&2
  exit 1
fi

windows_installer_path="$(wslpath -w "$project_root/ops/windows/Install-AcpMonitorDesktopShortcut.ps1")"

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$windows_installer_path" \
  -DistroName "$WSL_DISTRO_NAME" \
  -LinuxProjectPath "$project_root"
