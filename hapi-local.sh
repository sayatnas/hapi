#!/bin/bash
# Local HAPI development runner
# Usage: hapi-dev [args...]

HAPI_DIR="/mnt/k/BENCH/Proto/hapi-dev"
cd "$HAPI_DIR/cli"
exec bun src/index.ts "$@"
