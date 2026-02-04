# HAPI Fork Notes

This is a development fork of [HAPI](https://github.com/AieatAssam/hapi) - a local-first platform for AI coding agents.

## Build Instructions

### Development Mode

```bash
# Install dependencies (uses Bun workspaces)
bun install

# Build all packages
bun run build

# Run the hub (API server)
cd hub && bun run dev

# Run the web app (in another terminal)
cd web && bun run dev

# Run the CLI runner (in another terminal)
cd cli && bun run dev
```

### Full Rebuild (for production-like testing)

When you need to fully rebuild everything, including the compiled executable with embedded web assets:

```bash
# 1. Build web first (creates dist/ with compiled assets)
cd web && bun run build

# 2. Build hub (embeds web dist/ into the compiled binary)
cd hub && bun run build

# 3. Build CLI
cd cli && bun run build

# Or from the root, just run:
bun run build
```

### Quick Hub-Only Rebuild

When changes only affect the Hub (TypeScript changes, API routes, sync engine):

```bash
cd hub && bun run build

# Then restart your server:
hapi-dev server
```

### Restarting After Rebuild

```bash
# Stop and restart the hub server
hapi-dev server   # Ctrl+C to stop, then run again

# Or if using systemd/pm2, use those restart commands

# For runner (CLI processes), restart:
hapi-dev runner stop
hapi-dev runner start
```

### Browser Cache Issues

The web app uses a PWA service worker that caches aggressively. After rebuilding:

1. Open browser DevTools → Application → Service Workers → "Unregister"
2. Or hard refresh: `Ctrl+Shift+R` (Windows/Linux) / `Cmd+Shift+R` (Mac)
3. Or clear site data in DevTools → Application → Clear storage

## Changes Made to This Fork

### 1. Dialog Z-Index Fix

**Problem**: Older terminal/plan dialog boxes were appearing in front of newer messages due to improper stacking context.

**File**: `web/src/components/ui/dialog.tsx`

**Fix**: Changed the overlay z-index from `z-50` to `z-40` so the overlay sits behind the content (`z-50`):
```tsx
<DialogPrimitive.Overlay className="fixed inset-0 z-40 bg-black/50" />
```

### 2. YOLO Mode Race Condition Fix

**Problem**: "Process exited unexpectedly" error on the first message when YOLO mode is enabled. The session was returning before the CLI was ready to receive messages.

**File**: `hub/src/sync/syncEngine.ts`

**Fix**: Added `waitForSessionActive()` call in `spawnSession()` method before returning. This ensures the CLI is ready before the web app sends the first message:
```typescript
async spawnSession(...) {
    const spawnResult = await this.rpcGateway.spawnSession(...)
    if (spawnResult.type !== 'success') {
        return spawnResult
    }
    // Wait for session to become active before returning
    const becameActive = await this.waitForSessionActive(spawnResult.sessionId)
    if (!becameActive) {
        return { type: 'error', message: 'Session failed to become active' }
    }
    return spawnResult
}
```

### 3. /rewind Feature (Conversation Only)

**What it does**: Allows users to rewind the conversation to a previous checkpoint (user message), deleting all messages after that point.

**IMPORTANT LIMITATION**: This only rewinds the **conversation** (messages in HAPI's database). It does **NOT** rewind **code changes**. Claude Code's git-based checkpointing is an interactive CLI feature not exposed through the SDK.

To revert code changes, users should use git directly:
```bash
git checkout <file>    # Revert specific file
git stash              # Stash all changes
git reset --hard       # Discard all changes (careful!)
```

#### Files Modified/Created:

**Backend (Hub):**
- `hub/src/store/messages.ts` - Added `getCheckpoints()` and `deleteMessagesAfter()` functions
- `hub/src/store/messageStore.ts` - Added class methods to expose `getCheckpoints()` and `deleteMessagesAfter()`
- `hub/src/sync/messageService.ts` - Added service methods for checkpoints
- `hub/src/sync/sessionCache.ts` - Added `clearClaudeSessionId()` method
- `hub/src/sync/syncEngine.ts` - Added `getCheckpoints()`, `rewindSession()`, and auto-archive before rewind
- `hub/src/web/routes/sessions.ts` - Added `/checkpoints` and `/rewind` API endpoints

**Frontend (Web):**
- `web/src/lib/query-keys.ts` - Added `checkpoints` query key
- `web/src/api/client.ts` - Added `getCheckpoints()` and `rewindSession()` API methods
- `web/src/hooks/queries/useCheckpoints.ts` - **NEW** React Query hook for checkpoints
- `web/src/components/RewindMenu/RewindMenu.tsx` - **NEW** UI component for checkpoint selection
- `web/src/components/RewindMenu/index.tsx` - **NEW** Export file
- `web/src/router.tsx` - Added `/rewind` command interception, rewind menu modal, and click-outside-to-close

**CLI:**
- `cli/src/parsers/specialCommands.ts` - Added `parseRewind()` function
- `cli/src/claude/claudeRemote.ts` - Added `/rewind` command handling
- `cli/src/modules/common/slashCommands.ts` - Added `/rewind` to builtin commands

#### How It Works:

1. User types `/rewind` in the chat input
2. Web app intercepts the command and shows a checkpoint selection menu
3. Menu displays all user messages as checkpoints (most recent first)
4. User selects a checkpoint to rewind to
5. Hub **archives the session** (kills the running CLI process)
6. Hub API deletes all messages after that checkpoint from the database
7. Hub clears the Claude session ID from metadata (forces fresh context rebuild)
8. Hub emits `session-rewound` event to notify clients
9. Web app invalidates message cache and refetches

#### API Endpoints:

```
GET  /api/sessions/:id/checkpoints
POST /api/sessions/:id/rewind  { seq: number }
```

#### Message Format Detection (Critical Implementation Detail)

HAPI stores messages from two different sources with different formats. The `getCheckpoints()` function must detect both:

**Format 1: Direct Web UI Messages**
```json
{
  "role": "user",
  "content": {
    "type": "text",
    "text": "User's actual message here"
  },
  "meta": {
    "sentFrom": "webapp"
  }
}
```

**Format 2: Wrapped SDK Messages (from Claude Code SDK)**
```json
{
  "role": "agent",
  "content": {
    "type": "output",
    "data": {
      "type": "user",
      "isSidechain": false,
      "message": {
        "role": "user",
        "content": "User's actual message here"
        // OR content can be an array:
        // "content": [{"type": "text", "text": "..."}]
      }
    }
  }
}
```

**Filtering Logic:**
- Skip messages where `isSidechain === true` (automated agent task prompts)
- Skip messages that are only tool results (no text content)
- Skip automated prompt prefixes: "Explore ...", "Based on ...", "Investigate ...", "Search ...", "Design ..."
- Skip system messages that start with `<local-command-caveat>` or "This session is being continued"

See `hub/src/store/messages.ts` for the full implementation.

#### Rewinding Past Compaction Boundaries

When a session is compacted (via `/compact`), Claude Code summarizes the conversation and loses the original message context. HAPI handles this by:

1. **Detecting compaction**: The Hub identifies compaction messages (those starting with "This session is being continued...")
2. **Building context summary**: When rewinding past a compaction boundary, HAPI builds a summary of the pre-compaction conversation
3. **Injecting context**: The CLI injects this summary into the system prompt when resuming

**How it works:**
```
User rewinds to checkpoint before compaction
    → Hub detects crossedCompaction=true
    → Hub builds contextSummary from messages before rewind point
    → Hub stores contextSummary in session metadata (rewindContextSummary field)
    → CLI reads rewindContextSummary when resuming
    → CLI injects summary into appendSystemPrompt
    → CLI clears rewindContextSummary after use
```

**Files involved:**
- `hub/src/store/messages.ts` - `findCompactionBoundaries()` and `buildConversationSummary()`
- `hub/src/sync/sessionCache.ts` - `setRewindContextSummary()`
- `cli/src/claude/claudeRemote.ts` - Injects context into system prompt
- `shared/src/schemas.ts` - Added `rewindContextSummary` to Metadata schema

#### Why Conversation-Only Rewind?

Claude Code's native `/rewind` command (which also rewinds code changes) is an **interactive CLI feature**:
- It uses git shadow copies to track file changes
- It shows an interactive menu in the terminal
- It's not exposed through the Claude Code SDK

HAPI uses the SDK programmatically, not the interactive CLI. The SDK doesn't have a rewind API. Therefore:
- We can only rewind what HAPI controls: the conversation (messages database)
- Code changes must be reverted manually using git

This could change in the future if Anthropic adds rewind functionality to the SDK.

## Architecture Notes

HAPI consists of three main components:

1. **Hub** (`hub/`) - The API server
   - Hono HTTP server for REST API
   - Socket.IO for real-time communication
   - SQLite database for sessions and messages
   - Manages conversation state

2. **Web** (`web/`) - The web frontend
   - React 19 + Vite
   - TanStack Router/Query
   - Tailwind CSS

3. **CLI** (`cli/`) - The runner that spawns Claude Code
   - Uses Claude Code SDK (`@anthropic-ai/claude-code`)
   - Manages Claude sessions
   - Handles permission requests

The flow:
```
Web App <--REST/SSE--> Hub <--Socket.IO--> CLI Runner <--SDK--> Claude Code
```

## Troubleshooting

### "getCheckpoints is not a function" Error

**Cause**: The `MessageStore` class wasn't exposing the functions from `messages.ts`.

**Fix**: Ensure `hub/src/store/messageStore.ts` has:
```typescript
import { getCheckpoints, deleteMessagesAfter } from './messages'

export class MessageStore {
    // ... other methods ...

    getCheckpoints(sessionId: string) {
        return getCheckpoints(this.db, sessionId)
    }

    deleteMessagesAfter(sessionId: string, afterSeq: number) {
        return deleteMessagesAfter(this.db, sessionId, afterSeq)
    }
}
```

### "No checkpoints yet" Even With Messages

**Cause**: The `getCheckpoints()` function wasn't detecting one of the two message formats.

**Debug**: Query the database directly to inspect message format:
```bash
sqlite3 ~/.config/hapi-dev/hapi.db "SELECT content FROM messages WHERE session_id='<session-id>' LIMIT 5"
```

Then compare against the two formats documented above.

### Rewind Not Appearing in Autocomplete

**Cause**: CLI module not rebuilt after adding the command.

**Fix**: Full rebuild required:
```bash
bun run build  # From root
hapi-dev runner stop
hapi-dev runner start
```

### Session Opens as New After Rewind

**Expected behavior**: After rewind, the session is archived (CLI process killed). This is intentional because:
1. The Claude Code SDK maintains its own internal state
2. Rewinding the database doesn't rewind the SDK's memory
3. Killing and restarting ensures a clean slate matching the database state

The user can resume the session normally, and it will start fresh from the rewound checkpoint.

### Browser Showing Old Version After Rebuild

**Cause**: PWA service worker caches aggressively.

**Fix**:
1. DevTools → Application → Service Workers → "Unregister"
2. Clear site data
3. Hard refresh (`Ctrl+Shift+R`)

### 4. Plan Exit Options (Claude Code-style)

**What it does**: Extended the plan mode exit options to match Claude Code's behavior, giving users more control over how the plan executes.

**Options Available:**
- **Approve** - Execute with default permission handling
- **Approve + Auto-accept Edits** - Execute with `acceptEdits` mode (auto-approve file edits)
- **Approve + YOLO** - Execute with `bypassPermissions` mode (HAPI auto-approves all tools)
- **Approve + Dangerous YOLO** - Execute with `--dangerously-skip-permissions` flag (Claude handles all permissions natively)
- **Deny** - Reject the plan

**Files Modified:**
- `web/src/components/ToolCard/views/PlanExitFooter.tsx` - **NEW** Component for plan exit options UI
- `web/src/components/ToolCard/ToolCard.tsx` - Routes `ExitPlanMode` tools to `PlanExitFooter`
- `web/src/api/client.ts` - Updated `approvePermission` types for new modes
- `web/src/lib/locales/en.ts` - Added translation keys for plan options
- `web/src/lib/locales/zh-CN.ts` - Added Chinese translations

### 5. Dangerous YOLO Permission Mode

**What it does**: Added a new permission mode that uses Claude Code's native `--dangerously-skip-permissions` flag instead of HAPI's permission handling.

**Difference from regular YOLO (`bypassPermissions`):**
- **bypassPermissions**: HAPI intercepts tool calls and auto-approves them in `canCallTool`
- **dangerouslySkipPermissions**: Claude Code itself handles all permissions natively with no prompts

**Server-Side Auto-Approval:**
When `dangerouslySkipPermissions` mode is active, the Hub will automatically approve any permission requests that come through. This handles edge cases where permission requests still reach the Hub (e.g., when running as root where Claude Code refuses `--dangerously-skip-permissions`).

The auto-approval logic is in `hub/src/index.ts` via the `onPermissionRequestReceived` callback:
```typescript
onPermissionRequestReceived: (sessionId, requestId) => {
    const session = syncEngine.getSession(sessionId)
    if (session?.permissionMode === 'dangerouslySkipPermissions') {
        console.log(`[YOLO] Auto-approving permission request ${requestId}`)
        void syncEngine.approvePermission(sessionId, requestId)
    }
}
```

**Files Modified:**
- `shared/src/modes.ts` - Added `dangerouslySkipPermissions` to:
  - `CLAUDE_PERMISSION_MODES` array
  - `PERMISSION_MODES` array
  - `PERMISSION_MODE_LABELS` record
  - `PERMISSION_MODE_TONES` record
- `cli/src/claude/sdk/query.ts` - Special handling to pass `--dangerously-skip-permissions` flag
- `cli/src/claude/utils/permissionHandler.ts` - Added to `PLAN_EXIT_MODES` and bypass logic
- `web/src/api/client.ts` - Updated `approvePermission` method types
- `hub/src/socket/handlers/cli/sessionHandlers.ts` - Added `onPermissionRequestReceived` callback
- `hub/src/socket/handlers/cli/index.ts` - Pass through `onPermissionRequestReceived` callback
- `hub/src/socket/server.ts` - Added `onPermissionRequestReceived` to `SocketServerDeps`
- `hub/src/index.ts` - Implemented auto-approval logic when session is in YOLO mode

### 6. YOLO Mode + Abort Crash Fix

**Problem**: "Process exited unexpectedly" error when aborting a session in YOLO mode.

**Root Cause**: When aborting, the process exit handler would:
1. Set `AbortError` (correct)
2. Then overwrite it with a generic exit code error because killed processes exit with non-zero
3. The `AbortError` was lost, causing the launcher to show an unexpected error

**Files Modified:**
- `cli/src/claude/sdk/query.ts` - Fixed process exit handler to resolve properly on abort
- `cli/src/claude/claudeRemoteLauncher.ts` - Added `AbortError` handling in catch block

**Fix:**
```typescript
// query.ts - Handle abort before checking exit code
child.on('close', (code) => {
    if (config.options?.abort?.aborted) {
        query.setError(new AbortError('Claude Code process aborted by user'))
        resolve()  // Resolve instead of falling through to exit code check
    } else if (code !== 0) {
        query.setError(new Error(`Claude Code process exited with code ${code}`))
    } else {
        resolve()
    }
})
```

### 7. Permission Mode Changes During Processing

**What it does**: Allows changing permission mode and model mode even while Claude is thinking/processing.

**Rationale**: Permission mode only affects future tool calls, not the current execution. Users should be able to adjust this at any time.

**Files Modified:**
- `web/src/components/AssistantChat/HappyComposer.tsx` - Removed `controlsDisabled` check from handlers
- `web/src/components/AssistantChat/ComposerButtons.tsx` - Removed `disabled` from settings button
- UI buttons no longer show disabled styling during processing

### 8. Send Messages Anytime (No Frontend Queueing)

**What it does**: Allows users to send messages at any time, even while Claude is processing. Messages are sent immediately to the backend which handles all queueing and mid-turn injection.

**Previous behavior (removed):**
- Frontend would queue messages when `mutation.isPending` was true
- Queued messages would only send when the previous API call completed
- This caused messages to get "lost" or delayed

**Current behavior:**
- All messages sent immediately to the backend API
- Backend's `MessageQueue2` handles queueing
- If Claude is thinking: message is injected mid-turn via stdin (real-time steering)
- If Claude is between turns: message queued for the next turn

**Files Modified:**
- `web/src/hooks/mutations/useSendMessage.ts` - Removed frontend queueing; all messages sent immediately
- `web/src/components/AssistantChat/HappyComposer.tsx` - Removed `threadIsRunning` from `canSend` check

**Why frontend queueing was removed:**
The frontend queue was blocking messages from reaching the backend where the real-time steering logic lives. By sending messages immediately, the backend can decide whether to inject mid-turn or queue for later.

### 9. Real-Time Steering (Queue-and-Process-After-Result)

**What it does**: Allows users to send messages to Claude while it's processing. Messages are queued and processed together after Claude finishes its current response.

**Important Discovery**: Mid-turn stdin injection does NOT interrupt Claude's current response. When messages are injected to stdin while Claude is processing, Claude Code queues them internally and processes them in the NEXT turn, not immediately. This means true "real-time steering" (interrupting Claude mid-thought) is not possible with the current SDK.

**How it actually works:**
1. User sends a message while Claude is thinking (processing)
2. Message is sent to the Hub API immediately
3. Hub pushes the message to the CLI's `MessageQueue2`
4. Messages accumulate in the queue during Claude's processing
5. When Claude finishes (result received), ALL queued messages are collected
6. All queued messages are sent as ONE combined message to Claude
7. Claude processes them together in the next turn

**Technical Details:**

The `onMessage` callback in `claudeRemote.ts` no longer injects mid-turn. Instead, it just logs that a message arrived:

```typescript
// In claudeRemote.ts - messages accumulate, processed after result
const injectQueuedMessages = () => {
    const queueSize = opts.messageQueue?.size() ?? 0;
    logger.debug(`[claudeRemote] Message arrived - thinking=${thinking}, queueSize=${queueSize}`);
    // Messages will be processed after result is received
};
```

After the result is received, the code checks for queued messages and processes them:

```typescript
// After result is received
if (opts.messageQueue && opts.messageQueue.size() > 0) {
    const queuedMessages: string[] = [];
    while (opts.messageQueue.size() > 0) {
        const queued = opts.messageQueue.popFirst();
        if (queued) {
            queuedMessages.push(queued.message);
            mode = queued.mode;
        }
    }

    if (queuedMessages.length > 0) {
        const combinedMessage = queuedMessages.join('\n');
        messages.push({ type: 'user', message: { role: 'user', content: combinedMessage } });
        continue; // Process immediately, don't wait for nextMessage
    }
}
```

**Files Modified:**

**Backend (CLI):**
- `cli/src/claude/claudeRemote.ts` - Added `messageQueue` parameter and queue-after-result logic
- `cli/src/claude/claudeRemoteLauncher.ts` - Pass `session.queue` to `claudeRemote`
- `cli/src/utils/MessageQueue2.ts` - Added `popFirst()` method for consuming messages

**Frontend (Web):**
- `web/src/hooks/mutations/useSendMessage.ts` - All messages sent immediately to backend (no frontend queueing)

**User Experience:**
- Send messages at any time, even while Claude is working
- Messages appear in the conversation immediately (optimistic UI)
- After Claude finishes its current response, it will process ALL your queued messages together
- No more messages getting "lost" - they're reliably queued and processed

**Why not true mid-turn injection?**

We tried injecting messages directly to Claude's stdin while it was processing. The messages were successfully written to stdin, but Claude Code internally queues them and only processes them after the current turn completes. This is by design in Claude Code - it can't be interrupted mid-response.

**Limitations:**
- Messages sent during processing won't affect Claude's current response
- Claude processes all queued messages together after finishing, not one at a time
- If you send "stop" or "cancel" while Claude is working, it won't stop immediately

### 10. Windows Native Support

**What it does**: Allows HAPI to run natively on Windows without requiring WSL.

**Problem**: On Windows, `spawn('claude', args, { shell: false })` doesn't work because Windows can't find the executable without a shell. But using `shell: true` causes other issues with argument escaping and command resolution.

**Solution**: Find the absolute path to `claude.exe` and use `shell: false` with the full path.

**Files Modified:**
- `cli/src/claude/sdk/utils.ts` - Added `findWindowsClaudePath()` function
- `cli/src/claude/sdk/query.ts` - Changed to `shell: false` with absolute path
- `cli/src/claude/claudeLocal.ts` - Updated to use `getDefaultClaudeCodePath()` with `shell: false`

**How it works:**

1. `findWindowsClaudePath()` searches for `claude.exe` in common locations:
   - `~/.local/bin/claude.exe`
   - `~/AppData/Local/Programs/claude/claude.exe`
   - WinGet installation path
   - PATH via `where claude.exe`

2. On Windows, `getDefaultClaudeCodePath()` returns the absolute path
3. On Unix, it still returns just `'claude'` (works with `shell: false`)

**Environment Variable Override:**
Set `HAPI_CLAUDE_PATH` to override the Claude executable path:
```bash
export HAPI_CLAUDE_PATH="C:\path\to\claude.exe"
```

**Running on Windows:**
```bash
# Build as usual
bun run build

# Run the server
hapi-dev server

# Run the runner
hapi-dev runner start
```

### 11. Queued Message Loss Fix

**Problem**: Messages sent while Claude was thinking would sometimes get "lost" - they appeared in the UI as queued but wouldn't be processed until the user sent another message.

**Root Cause**: The `injectQueuedMessages()` callback was consuming messages from the queue (via `popFirst()`), but the consumed messages weren't being properly delivered to Claude. This created a race condition where:
1. Message arrives in queue
2. `onMessage` callback fires, `popFirst()` removes it from queue
3. Message was supposed to be injected to stdin, but Claude doesn't interrupt for it
4. Queue is now empty
5. When result comes, queue check finds nothing
6. Message is effectively "lost"

**Solution**: Changed strategy from "consume-and-inject mid-turn" to "accumulate and process after result":

1. The `onMessage` callback no longer consumes messages - it just logs
2. Messages accumulate in the queue during Claude's processing
3. After result is received, ALL queued messages are collected and sent as one batch
4. This ensures no messages are lost regardless of timing

**Files Modified:**
- `cli/src/claude/claudeRemote.ts` - Simplified `injectQueuedMessages()` to just log; messages processed after result
- `cli/src/utils/MessageQueue2.ts` - `waitForMessagesAndGetAsString()` loops if queue was emptied by another consumer

**Key Code Changes:**

```typescript
// claudeRemote.ts - callback no longer consumes, just logs
const injectQueuedMessages = () => {
    const queueSize = opts.messageQueue?.size() ?? 0;
    logger.debug(`[claudeRemote] Message arrived - thinking=${thinking}, queueSize=${queueSize}`);
    // Messages will be processed after result is received
};

// After result, process ALL queued messages together
if (message.type === 'result') {
    // ...
    if (opts.messageQueue && opts.messageQueue.size() > 0) {
        const queuedMessages: string[] = [];
        while (opts.messageQueue.size() > 0) {
            const queued = opts.messageQueue.popFirst();
            if (queued) queuedMessages.push(queued.message);
        }
        // Send all as one combined message
        messages.push({ type: 'user', message: { role: 'user', content: queuedMessages.join('\n') } });
        continue;
    }
}
```

**Why this approach works:**
- No race conditions - messages stay in queue until explicitly consumed after result
- No message loss - queue is only emptied when we're ready to process
- Predictable behavior - all queued messages processed together after Claude finishes

## Operational Procedures

### Killing Stuck Processes

When processes get stuck or need to be forcefully terminated:

```bash
# Kill all hapi-related processes
pkill -f hapi-dev
pkill -f "bun.*hapi"
pkill -f "claude"

# Or more specifically:
# Kill the runner
pkill -f "hapi-dev runner"

# Kill stuck Claude processes
pkill -f "claude-code"

# Nuclear option - kill all bun processes (be careful!)
pkill -f bun
```

### Adding a New Slash Command

To add a new slash command (like `/rewind`, `/compact`, etc.):

1. **CLI - Register the command** (`cli/src/modules/common/slashCommands.ts`):
   ```typescript
   export const builtinCommands: CommandInfo[] = [
       // ... existing commands ...
       {
           command: '/mycommand',
           description: 'Description of what it does',
           isBuiltin: true,
       },
   ]
   ```

2. **CLI - Handle the command** (`cli/src/claude/claudeRemote.ts`):
   ```typescript
   // In the message processing section
   if (userMessage.startsWith('/mycommand')) {
       // Handle the command
       // Either process locally or pass to Claude
   }
   ```

3. **Web - Intercept if needed** (`web/src/router.tsx`):
   ```typescript
   // If the command needs UI handling (like /rewind shows a menu)
   if (msg.startsWith('/mycommand')) {
       // Show UI, prevent default send
       return
   }
   ```

4. **Rebuild and restart**:
   ```bash
   cd /mnt/k/BENCH/Proto/hapi-dev
   cd web && bun run build
   cd ../hub && bun run build
   cd ../cli && bun run build:exe:allinone
   # Restart runner
   ```

### Adding a New Permission Mode

1. **Shared - Define the mode** (`shared/src/modes.ts`):
   ```typescript
   export const CLAUDE_PERMISSION_MODES = [
       'default',
       'acceptEdits',
       'bypassPermissions',
       'dangerouslySkipPermissions',
       'myNewMode',  // Add here
       'plan',
   ] as const

   export const PERMISSION_MODE_LABELS: Record<PermissionMode, string> = {
       // ... existing ...
       myNewMode: 'My Mode Label',
   }

   export const PERMISSION_MODE_TONES: Record<PermissionMode, Tone> = {
       // ... existing ...
       myNewMode: 'warning',  // or 'danger', 'success', etc.
   }
   ```

2. **CLI - Handle the mode** (`cli/src/claude/utils/permissionHandler.ts`):
   ```typescript
   // In handleToolCall method
   if (this.permissionMode === 'myNewMode') {
       // Custom permission logic
   }
   ```

3. **CLI - SDK flags if needed** (`cli/src/claude/sdk/query.ts`):
   ```typescript
   // If mode needs special CLI flags
   if (permissionMode === 'myNewMode') {
       args.push('--some-flag')
   }
   ```

4. **Rebuild all packages**

### Debugging Message Flow

```bash
# Check messages in the database
sqlite3 ~/.config/hapi-dev/hapi.db "SELECT id, seq, content FROM messages WHERE session_id='<session-id>' ORDER BY seq DESC LIMIT 10"

# Watch CLI logs
tail -f ~/.config/hapi-dev/logs/runner.log

# Check session state
sqlite3 ~/.config/hapi-dev/hapi.db "SELECT * FROM sessions WHERE id='<session-id>'"
```

### Common Development Workflow

```bash
# 1. Make changes to code

# 2. Rebuild affected packages
cd web && bun run build      # If web changed
cd hub && bun run build      # If hub/API changed
cd cli && bun run build:exe:allinone  # If CLI changed

# 3. Kill existing processes
pkill -f hapi-dev

# 4. Start fresh
hapi-dev server &
hapi-dev runner start

# 5. Clear browser cache if web changed
# DevTools → Application → Clear storage
```

### Handling "Process exited unexpectedly"

This usually means:
1. Claude crashed or was killed
2. Permission handling threw an error
3. The abort signal wasn't handled properly

**Debug steps:**
1. Check the runner logs: `tail -f ~/.config/hapi-dev/logs/runner.log`
2. Check if it's mode-specific (e.g., only in YOLO mode)
3. Check the web console for API errors
4. Try with a different permission mode

### Session Won't Start / Stays Loading

1. Check if runner is running: `ps aux | grep hapi-dev`
2. Check runner logs for errors
3. Kill and restart: `pkill -f hapi-dev && hapi-dev server & && hapi-dev runner start`
4. Check database for corrupted session state

### Web App Shows Old Version

1. Hard refresh: `Ctrl+Shift+R`
2. Clear service worker: DevTools → Application → Service Workers → Unregister
3. Clear all site data: DevTools → Application → Storage → Clear site data
4. Open in incognito window to test

---

## Keeping This Document Updated

**IMPORTANT**: This document should be kept up-to-date as changes are made to the fork.

When making changes:
1. Document the **problem** being solved
2. Document the **files modified**
3. Document the **solution/approach**
4. Add any **troubleshooting** tips discovered

This helps future developers (and AI assistants) understand the codebase modifications.

---

## Reference

- Original HAPI repo: https://github.com/AieatAssam/hapi
- Claude Code docs: https://code.claude.com/docs
- Claude Code checkpointing: https://code.claude.com/docs/en/checkpointing
