#!/usr/bin/env bash
docker compose -f e2e/compose.yml logs || true
