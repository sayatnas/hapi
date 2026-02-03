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

**Files Modified:**
- `shared/src/modes.ts` - Added `dangerouslySkipPermissions` to:
  - `CLAUDE_PERMISSION_MODES` array
  - `PERMISSION_MODES` array
  - `PERMISSION_MODE_LABELS` record
  - `PERMISSION_MODE_TONES` record
- `cli/src/claude/sdk/query.ts` - Special handling to pass `--dangerously-skip-permissions` flag
- `cli/src/claude/utils/permissionHandler.ts` - Added to `PLAN_EXIT_MODES` and bypass logic
- `web/src/api/client.ts` - Updated `approvePermission` method types

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

### 8. Message Queue System

**What it does**: Allows users to send messages even while Claude is processing. Messages are queued and sent automatically when the assistant stops thinking.

**How it works:**
1. User can type and send messages at any time
2. If Claude is processing, messages are queued with `'queued'` status
3. Queued messages appear immediately with a clock icon and "Queued" label
4. Messages appear slightly greyed out (60% opacity)
5. When Claude stops thinking, queued messages are sent one by one

**Files Modified:**
- `web/src/hooks/mutations/useSendMessage.ts` - Added queue state and processing logic
- `web/src/types/api.ts` - Added `'queued'` to `MessageStatus` type
- `web/src/components/AssistantChat/messages/MessageStatusIndicator.tsx` - Added queued status indicator
- `web/src/components/AssistantChat/messages/UserMessage.tsx` - Greyed out styling for queued messages
- `web/src/components/AssistantChat/HappyComposer.tsx` - Removed `threadIsRunning` from `canSend` check
- `web/src/router.tsx` - Pass `isThinking` to `useSendMessage`
- `web/src/lib/locales/en.ts` - Added `message.queued` translation
- `web/src/lib/locales/zh-CN.ts` - Added Chinese translation

**Note**: With real-time steering (see below), messages are now injected mid-process instead of waiting.

### 9. Real-Time Steering (Mid-Turn Message Injection)

**What it does**: Allows users to send messages to Claude while it's processing, and have those messages injected immediately into the conversation. Claude receives the feedback mid-turn and can adjust its approach.

**How it works:**
1. User sends a message while Claude is thinking (processing)
2. Message is sent to the Hub API immediately (only queues if a send API call is already in flight)
3. Hub pushes the message to the CLI's `MessageQueue2`
4. `MessageQueue2.onMessage` callback triggers in `claudeRemote.ts`
5. The callback **consumes** the message from the queue using `popFirst()` and injects it
6. Message is pushed to the `PushableAsyncIterable` that feeds Claude's stdin
7. Claude receives the message via `--input-format stream-json` and incorporates it

**Technical Details - Consume-and-Inject Pattern:**

The key challenge was preventing message loss and duplication:
- If we inject but don't remove from queue → duplicate processing when turn ends
- If we inject but compaction happens → message could be lost

Solution: **Consume-and-Inject Pattern**
- When `onMessage` callback fires, use `popFirst()` to REMOVE the message from the queue
- Then inject into the `PushableAsyncIterable`
- If compaction/abort happens BEFORE injection, message stays safely in queue for later
- If injection succeeds, message is removed so `nextMessage()` won't see it again

```typescript
// In claudeRemote.ts - consume-and-inject pattern
const injectQueuedMessages = () => {
    if (!opts.messageQueue || !thinking || messages.done) return;

    while (true) {
        // popFirst() REMOVES and returns the message
        const queued = opts.messageQueue.popFirst();
        if (!queued) break;

        // Inject into stdin stream
        messages.push({
            type: 'user',
            message: { role: 'user', content: queued.message },
        });
    }
};

// Callback triggers injection when new messages arrive
opts.messageQueue.setOnMessage(() => injectQueuedMessages());
```

**Files Modified:**

**Backend (CLI):**
- `cli/src/claude/claudeRemote.ts` - Added `messageQueue` parameter and consume-and-inject logic
- `cli/src/claude/claudeRemoteLauncher.ts` - Pass `session.queue` to `claudeRemote`
- `cli/src/utils/MessageQueue2.ts` - Added `popFirst()` method for consuming messages

**Frontend (Web):**
- `web/src/hooks/mutations/useSendMessage.ts` - Messages send immediately; only queue when API call in flight

**User Experience:**
- Send messages at any time, even while Claude is working
- Messages appear in the conversation immediately
- Claude will receive and process your feedback as soon as possible
- No more waiting for Claude to finish before you can provide corrections or guidance
- Messages survive compaction - they won't be lost if compaction happens mid-turn

**Limitations:**
- Claude may not immediately act on the injected message if it's in the middle of a tool call
- The injected message becomes part of the conversation history
- Rapid message injection may cause Claude to become confused if not given time to process

### 10. Queued Message Loss Fix

**Problem**: Messages sent while Claude was thinking would sometimes get "lost" - they appeared in the UI as queued but wouldn't be processed until the user sent another message.

**Root Causes**:

1. **Race condition in `waitForMessagesAndGetAsString`**: When a message was injected mid-turn via `injectQueuedMessages()`, the waiter in `waitForMessagesAndGetAsString()` would wake up and find the queue empty (because the message was already consumed by injection). It would then return `null`, causing `nextMessage()` to return `null`, which ended the session prematurely.

2. **Timing issue with `thinking` state**: The `onMessage` callback was registered BEFORE `thinking` was set to `true`. If a message arrived in that window, `injectQueuedMessages()` would skip it (because `thinking === false`), and the message would stay in the queue without being injected until another message arrived.

**Files Modified:**
- `cli/src/utils/MessageQueue2.ts` - Fixed `waitForMessagesAndGetAsString()` to loop and wait again if queue is empty
- `cli/src/claude/claudeRemote.ts` - Reordered initialization: set `thinking=true` before registering callback, then inject any pre-queued messages

**Fix 1 - MessageQueue2.ts:**
```typescript
async waitForMessagesAndGetAsString(abortSignal?: AbortSignal) {
    // Loop to handle consumed messages
    while (true) {
        if (this.queue.length > 0) {
            return this.collectBatch();
        }
        if (this.closed || abortSignal?.aborted) {
            return null;
        }

        const hasMessages = await this.waitForMessages(abortSignal);
        if (!hasMessages) {
            return null;
        }

        // If queue is empty (consumed by injection), wait again
        if (this.queue.length === 0) {
            continue;
        }

        return this.collectBatch();
    }
}
```

**Fix 2 - claudeRemote.ts:**
```typescript
// Start the query
const response = query({ prompt: messages, options: sdkOptions });

// Set thinking BEFORE registering callback
updateThinking(true);

// Now register the callback
if (opts.messageQueue) {
    opts.messageQueue.setOnMessage(() => {
        injectQueuedMessages();
    });

    // Inject any messages already in queue
    injectQueuedMessages();
}
```

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
