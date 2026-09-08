#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
pnpm run build
if ! command -v docker >/dev/null 2>&1; then
  echo skip-playwright-no-runtime
  exit 0
fi
pnpm run e2e:fixtures:up
if command -v xvfb-run >/dev/null 2>&1; then xvfb-run -a pnpm run test:e2e; else pnpm run test:e2e; fi
