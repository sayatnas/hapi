#!/bin/bash

# HAPI Development Rebuild Script
# Stops server/runner, rebuilds, and restarts both processes
#
# Usage: ./dev-rebuild.sh [project_dir]
#   project_dir: Optional. Directory to run server from (default: /mnt/k/BENCH/PROJECTS/BoundMore)
#
# Run with sudo if needed: sudo ./dev-rebuild.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HAPI_EXE="$SCRIPT_DIR/cli/dist-exe/bun-linux-x64/hapi"
PROJECT_DIR="${1:-/mnt/k/BENCH/PROJECTS/BoundMore}"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() {
    echo -e "${BLUE}[INFO]${NC} $1"
}

log_success() {
    echo -e "${GREEN}[SUCCESS]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

echo ""
log_info "=========================================="
log_info "HAPI Development Rebuild Script"
log_info "Project dir: $PROJECT_DIR"
log_info "=========================================="
echo ""

# Step 1: Stop runner
log_info "Stopping hapi-dev runner..."
if "$HAPI_EXE" runner stop 2>/dev/null; then
    log_success "Runner stopped"
else
    log_warn "Runner was not running or failed to stop"
fi

# Step 2: Stop server (kill any existing hapi server processes)
log_info "Stopping hapi-dev server..."
# Find and kill hapi server processes
pkill -f "hapi.*server" 2>/dev/null || true
pkill -f "bun-linux-x64/hapi" 2>/dev/null || true
sleep 1
log_success "Server stopped"

# Step 3: Build
log_info "Starting full rebuild..."
cd "$SCRIPT_DIR"

log_info "Building single executable..."
if bun run build:single-exe; then
    log_success "Build completed successfully"
else
    log_error "Build failed!"
    exit 1
fi

# Step 4: Start server in background
log_info "Starting hapi-dev server from $PROJECT_DIR..."

# Create log file for server output
SERVER_LOG="/tmp/hapi-server-$$.log"
touch "$SERVER_LOG"

# Start server in background
cd "$PROJECT_DIR"
HAPI_LISTEN_HOST=0.0.0.0 "$HAPI_EXE" server > "$SERVER_LOG" 2>&1 &
SERVER_PID=$!

# Wait for server to start
log_info "Waiting for server to start..."
sleep 3

if kill -0 $SERVER_PID 2>/dev/null; then
    log_success "Server started (PID: $SERVER_PID)"
else
    log_error "Server failed to start. Last 20 lines of log:"
    tail -20 "$SERVER_LOG"
    exit 1
fi

# Step 5: Start runner
log_info "Starting hapi-dev runner..."
if "$HAPI_EXE" runner start; then
    log_success "Runner started"
else
    log_error "Runner failed to start"
    exit 1
fi

echo ""
log_success "=========================================="
log_success "HAPI dev environment is ready!"
log_success "Server PID: $SERVER_PID"
log_success "Server log: $SERVER_LOG"
log_success "=========================================="
echo ""

# Trap to cleanup on exit
cleanup() {
    echo ""
    log_info "Shutting down..."
    "$HAPI_EXE" runner stop 2>/dev/null || true
    kill $SERVER_PID 2>/dev/null || true
    log_success "Cleanup complete"
}

trap cleanup EXIT INT TERM

# Keep script running and show server logs
log_info "Tailing server log (Ctrl+C to stop everything)..."
echo ""
tail -f "$SERVER_LOG"
