#!/usr/bin/env bash
set -euo pipefail
if ! command -v docker >/dev/null 2>&1; then
  echo "::error::Docker is required for e2e-ipc fixtures but was not found on the runner."
  echo "Harness + local script still land; see e2e/README.md."
  exit 1
fi
docker compose -f e2e/compose.yml up -d --wait
