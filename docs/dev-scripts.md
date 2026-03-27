# HAPI Development Scripts

Scripts to automate the stop/rebuild/restart cycle during HAPI development.

## Scripts

| Script | Description |
|--------|-------------|
| `dev-rebuild.sh` | Stop, rebuild, and restart (full build) |
| `dev-restart.sh` | Stop and restart only (no rebuild) |

## Location

```
/mnt/k/BENCH/Proto/hapi-dev/dev-rebuild.sh
/mnt/k/BENCH/Proto/hapi-dev/dev-restart.sh
```

## What It Does

1. **Stops the runner** - Calls `hapi-dev runner stop`
2. **Stops the server** - Kills any running hapi server processes
3. **Rebuilds** - Runs `bun run build:single-exe` (compiles CLI, Hub, and Web)
4. **Starts the server** - Launches with `HAPI_LISTEN_HOST=0.0.0.0`
5. **Starts the runner** - Launches `hapi-dev runner start`
6. **Tails logs** - Shows server output in real-time
7. **Clean shutdown** - Ctrl+C stops both processes gracefully

## Usage

### Basic Usage (Default Project)

```bash
sudo /mnt/k/BENCH/Proto/hapi-dev/dev-rebuild.sh
```

Uses default project directory: `/mnt/k/BENCH/PROJECTS/BoundMore`

### Custom Project Directory

```bash
sudo /mnt/k/BENCH/Proto/hapi-dev/dev-rebuild.sh /path/to/your/project
```

### From the hapi-dev Directory

```bash
cd /mnt/k/BENCH/Proto/hapi-dev
sudo ./dev-rebuild.sh
```

### Quick Restart (No Rebuild)

```bash
sudo /mnt/k/BENCH/Proto/hapi-dev/dev-restart.sh
```

Use this when you haven't changed any source code and just need to restart the services.

## Output

The script provides colored output showing progress:

```
[INFO] ==========================================
[INFO] HAPI Development Rebuild Script
[INFO] Project dir: /mnt/k/BENCH/PROJECTS/BoundMore
[INFO] ==========================================

[INFO] Stopping hapi-dev runner...
[SUCCESS] Runner stopped
[INFO] Stopping hapi-dev server...
[SUCCESS] Server stopped
[INFO] Starting full rebuild...
[INFO] Building single executable...
[SUCCESS] Build completed successfully
[INFO] Starting hapi-dev server from /mnt/k/BENCH/PROJECTS/BoundMore...
[INFO] Waiting for server to start...
[SUCCESS] Server started (PID: 12345)
[INFO] Starting hapi-dev runner...
[SUCCESS] Runner started (PID: 12346)

[SUCCESS] ==========================================
[SUCCESS] HAPI dev environment is ready!
[SUCCESS] Server PID: 12345
[SUCCESS] Server log: /tmp/hapi-server-12345.log
[SUCCESS] ==========================================

[INFO] Tailing server log (Ctrl+C to stop everything)...
```

## Stopping

Press **Ctrl+C** to stop. The script will:
1. Stop the runner
2. Kill the server process
3. Exit cleanly

## Server Logs

Server output is written to `/tmp/hapi-server-<pid>.log` and tailed in the terminal.

To view logs from another terminal:
```bash
tail -f /tmp/hapi-server-*.log
```

## Troubleshooting

### Build Fails

If the build fails, the script exits with an error. Check the build output for details. Common issues:
- Missing dependencies: Run `bun install` in the hapi-dev directory
- TypeScript errors: Fix the source code issues shown in the output

### Server Won't Start

If the server fails to start, the script shows the last 20 lines of the server log. Common issues:
- Port already in use: Another process is using the port
- Missing web assets: The build may have failed partially

### Permission Denied

Run with `sudo` if you get permission errors:
```bash
sudo ./dev-rebuild.sh
```

## Manual Alternative

If you prefer to run things manually in separate terminals:

**Terminal 1 (Server):**
```bash
sudo su
cd /mnt/k/BENCH/PROJECTS/BoundMore
HAPI_LISTEN_HOST=0.0.0.0 hapi-dev server
```

**Terminal 2 (Runner):**
```bash
sudo su
hapi-dev runner start
```

**To stop:**
- Terminal 1: Ctrl+C
- Terminal 2: `hapi-dev runner stop`
