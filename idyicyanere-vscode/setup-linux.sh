#!/usr/bin/env bash

set -euo pipefail

echo "--- 1/3 Preparing system dependencies ---"
if command -v apt >/dev/null 2>&1; then
  if [ "$(id -u)" -eq 0 ]; then
    apt update
    apt install -y build-essential python3 make g++ libssl-dev git curl
  else
    echo "Non-root shell detected: skipping apt installs."
    echo "If native build fails, rerun with sudo to install system packages."
  fi
fi

if ! command -v node >/dev/null 2>&1; then
  if [ "$(id -u)" -ne 0 ]; then
    echo "Node.js is missing. Install Node.js 20+ (or run this script with sudo)." >&2
    exit 1
  fi
  echo "Node.js not found. Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt install -y nodejs
fi

echo "--- 2/3 Verifying toolchain ---"
node -v
npm -v

echo "--- 3/3 Building Linux VSIX ---"
# Reuse the canonical npm pipeline (prepare/clean/install/bundle/native/package)
npm run vsix:linux

echo ""
echo "BUILD COMPLETE! VSIX generated in dist-vsix/idyicyanere-linux-x64.vsix"
