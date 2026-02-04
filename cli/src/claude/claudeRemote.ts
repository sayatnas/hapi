import { EnhancedMode, PermissionMode } from "./loop";
import { query, type QueryOptions as Options, type SDKMessage, type SDKSystemMessage, AbortError, SDKUserMessage } from '@/claude/sdk'
import { claudeCheckSession } from "./utils/claudeCheckSession";
import { join } from 'node:path';
import { parseSpecialCommand } from "@/parsers/specialCommands";
import { logger } from "@/lib";
import { PushableAsyncIterable } from "@/utils/PushableAsyncIterable";
import { getProjectPath } from "./utils/path";
import { awaitFileExist } from "@/modules/watcher/awaitFileExist";
import { systemPrompt } from "./utils/systemPrompt";
import { PermissionResult } from "./sdk/types";
import { getHapiBlobsDir } from "@/constants/uploadPaths";
import { MessageQueue2 } from "@/utils/MessageQueue2";

export async function claudeRemote(opts: {

    // Fixed parameters
    sessionId: string | null,
    path: string,
    mcpServers?: Record<string, any>,
    claudeEnvVars?: Record<string, string>,
    claudeArgs?: string[],
    allowedTools: string[],
    hookSettingsPath: string,
    signal?: AbortSignal,
    canCallTool: (toolName: string, input: unknown, mode: EnhancedMode, options: { signal: AbortSignal }) => Promise<PermissionResult>,

    // Dynamic parameters
    nextMessage: () => Promise<{ message: string, mode: EnhancedMode } | null>,
    onReady: () => void,
    isAborted: (toolCallId: string) => boolean,

    // Callbacks
    onSessionFound: (id: string) => void,
    onThinkingChange?: (thinking: boolean) => void,
    onMessage: (message: SDKMessage) => void,
    onCompletionEvent?: (message: string) => void,
    onSessionReset?: () => void,

    // Context for rewinding past compaction
    rewindContextSummary?: string,
    onRewindContextConsumed?: () => void,

    // Real-time steering: message queue for injecting messages mid-turn
    messageQueue?: MessageQueue2<EnhancedMode>
}) {

    // Check if session is valid
    let startFrom = opts.sessionId;
    if (opts.sessionId && !claudeCheckSession(opts.sessionId, opts.path)) {
        startFrom = null;
    }
    
    // Extract --resume from claudeArgs if present (for first spawn)
    if (!startFrom && opts.claudeArgs) {
        for (let i = 0; i < opts.claudeArgs.length; i++) {
            if (opts.claudeArgs[i] === '--resume') {
                // Check if next arg exists and looks like a session ID
                if (i + 1 < opts.claudeArgs.length) {
                    const nextArg = opts.claudeArgs[i + 1];
                    // If next arg doesn't start with dash and contains dashes, it's likely a UUID
                    if (!nextArg.startsWith('-') && nextArg.includes('-')) {
                        startFrom = nextArg;
                        logger.debug(`[claudeRemote] Found --resume with session ID: ${startFrom}`);
                        break;
                    } else {
                        // Just --resume without UUID - SDK doesn't support this
                        logger.debug('[claudeRemote] Found --resume without session ID - not supported in remote mode');
                        break;
                    }
                } else {
                    // --resume at end of args - SDK doesn't support this
                    logger.debug('[claudeRemote] Found --resume without session ID - not supported in remote mode');
                    break;
                }
            }
        }
    }

    // Set environment variables for Claude Code SDK
    if (opts.claudeEnvVars) {
        Object.entries(opts.claudeEnvVars).forEach(([key, value]) => {
            process.env[key] = value;
        });
    }
    process.env.DISABLE_AUTOUPDATER = '1';

    // Get initial message
    const initial = await opts.nextMessage();
    if (!initial) { // No initial message - exit
        return;
    }

    // Handle special commands
    const specialCommand = parseSpecialCommand(initial.message);

    // Handle /clear command
    if (specialCommand.type === 'clear') {
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Context was reset');
        }
        if (opts.onSessionReset) {
            opts.onSessionReset();
        }
        return;
    }

    // Handle /compact command
    let isCompactCommand = false;
    if (specialCommand.type === 'compact') {
        logger.debug('[claudeRemote] /compact command detected - will process as normal but with compaction behavior');
        isCompactCommand = true;
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('Compaction started');
        }
    }

    // Handle /rewind command
    // NOTE: This only rewinds the conversation (messages in HAPI's database).
    // It does NOT rewind code changes - Claude Code's git-based checkpointing
    // is an interactive CLI feature not exposed through the SDK.
    if (specialCommand.type === 'rewind') {
        logger.debug('[claudeRemote] /rewind command detected');
        // Signal to web UI to show checkpoint selection
        // The actual rewind is handled by the Hub API
        if (opts.onCompletionEvent) {
            const targetSeq = specialCommand.rewindOptions?.targetSeq;
            if (targetSeq !== undefined) {
                opts.onCompletionEvent(`__rewind_to_seq__:${targetSeq}`);
            } else {
                opts.onCompletionEvent('__rewind_requested__');
            }
        }
        return;
    }

    // Handle /recover command
    // Forces context recovery - requests full conversation history from Hub
    if (specialCommand.type === 'recover') {
        logger.debug('[claudeRemote] /recover command detected');
        if (opts.onCompletionEvent) {
            opts.onCompletionEvent('__recover_context__');
        }
        if (opts.onSessionReset) {
            opts.onSessionReset();
        }
        return;
    }

    // Build append system prompt with optional rewind context
    let baseAppendPrompt = initial.mode.appendSystemPrompt
        ? initial.mode.appendSystemPrompt + '\n\n' + systemPrompt
        : systemPrompt;

    // If we have a rewind context summary, prepend it to help Claude understand the conversation history
    // Note: We track whether we successfully used the context so we can clear it only on success
    let usedRewindContext = false;
    logger.debug(`[claudeRemote] opts.rewindContextSummary: ${opts.rewindContextSummary ? `${opts.rewindContextSummary.length} chars` : 'undefined'}`);
    if (opts.rewindContextSummary) {
        // Log the context size for debugging
        const contextLength = opts.rewindContextSummary.length;
        logger.debug(`[claudeRemote] Injecting rewind context summary into system prompt (length: ${contextLength})`);

        // Limit context size to prevent potential issues with very large prompts
        // 100KB should be plenty while staying safe
        const MAX_CONTEXT_SIZE = 100 * 1024;
        if (contextLength > MAX_CONTEXT_SIZE) {
            logger.debug(`[claudeRemote] Context too large (${contextLength}), truncating to ${MAX_CONTEXT_SIZE}`);
            const truncated = opts.rewindContextSummary.slice(0, MAX_CONTEXT_SIZE) + '\n\n[Context truncated due to size...]';
            baseAppendPrompt = truncated + '\n\n' + baseAppendPrompt;
        } else {
            baseAppendPrompt = opts.rewindContextSummary + '\n\n' + baseAppendPrompt;
        }
        usedRewindContext = true;
    }

    // Prepare SDK options
    let mode = initial.mode;

    // Note: canCallTool is always provided to handle AskUserQuestion and other tools
    // that need user interaction even in bypassPermissions mode
    const sdkOptions: Options = {
        cwd: opts.path,
        resume: startFrom ?? undefined,
        mcpServers: opts.mcpServers,
        permissionMode: initial.mode.permissionMode,
        model: initial.mode.model,
        fallbackModel: initial.mode.fallbackModel,
        customSystemPrompt: initial.mode.customSystemPrompt ? initial.mode.customSystemPrompt + '\n\n' + systemPrompt : undefined,
        appendSystemPrompt: baseAppendPrompt,
        allowedTools: initial.mode.allowedTools ? initial.mode.allowedTools.concat(opts.allowedTools) : opts.allowedTools,
        disallowedTools: initial.mode.disallowedTools,
        canCallTool: (toolName: string, input: unknown, options: { signal: AbortSignal }) => opts.canCallTool(toolName, input, mode, options),
        abort: opts.signal,
        pathToClaudeCodeExecutable: 'claude',
        settingsPath: opts.hookSettingsPath,
        additionalDirectories: [getHapiBlobsDir()],
    }

    // Track thinking state
    let thinking = false;
    const updateThinking = (newThinking: boolean) => {
        if (thinking !== newThinking) {
            thinking = newThinking;
            logger.debug(`[claudeRemote] Thinking state changed to: ${thinking}`);
            if (opts.onThinkingChange) {
                opts.onThinkingChange(thinking);
            }
        }
    };

    // Push initial message
    let messages = new PushableAsyncIterable<SDKUserMessage>();
    messages.push({
        type: 'user',
        message: {
            role: 'user',
            content: initial.message,
        },
    });

    // Real-time steering: inject messages mid-turn using consume-and-inject pattern
    //
    // How it works:
    // 1. When a new message arrives in the queue, onMessage callback is triggered
    // 2. We use popFirst() to REMOVE the message from the queue
    // 3. Then inject it into the PushableAsyncIterable (Claude's stdin)
    // 4. Since the message is removed from queue, it won't be processed again by nextMessage()
    // 5. If compaction/abort happens before we inject, the message stays safely in the queue
    //
    // This ensures:
    // - No duplicate messages (removed from queue when injected)
    // - No lost messages (stays in queue until consumed)
    // - Real-time feedback to Claude mid-turn

    // NOTE: Mid-turn injection doesn't work as expected with Claude Code.
    // When we inject messages to stdin while Claude is processing, it queues them
    // internally and processes them in the NEXT turn, not immediately.
    //
    // Instead, we let messages accumulate in the queue during thinking, then
    // process them all together after the result is received (see code after Result handling).
    //
    // This callback is kept to log when messages arrive, but doesn't inject.
    const injectQueuedMessages = () => {
        const queueSize = opts.messageQueue?.size() ?? 0;
        logger.debug(`[claudeRemote] Message arrived - thinking=${thinking}, queueSize=${queueSize}`);
        // Messages will be processed after result is received
    };

    // Start the loop
    const response = query({
        prompt: messages,
        options: sdkOptions,
    });

    // Set thinking to true BEFORE registering the message callback
    // This ensures that if messages arrive immediately after registration,
    // they will be injected (since injectQueuedMessages checks thinking state)
    updateThinking(true);

    // Set up callback to be notified when new messages arrive
    // The callback triggers injection of queued messages
    if (opts.messageQueue) {
        opts.messageQueue.setOnMessage(() => {
            // Inject any queued messages immediately
            injectQueuedMessages();
        });

        // Inject any messages that were already queued before we set up the callback
        // (e.g., user sent message while claudeRemote was starting up)
        injectQueuedMessages();
    }
    try {
        logger.debug(`[claudeRemote] Starting to iterate over response`);

        for await (const message of response) {
            logger.debugLargeJson(`[claudeRemote] Message ${message.type}`, message);

            // Handle messages
            opts.onMessage(message);

            // Handle special system messages
            if (message.type === 'system' && message.subtype === 'init') {
                // Start thinking when session initializes
                updateThinking(true);

                // Session successfully started - clear the rewind context now that it's been used
                // We wait until init to ensure the spawn actually succeeded
                if (usedRewindContext && opts.onRewindContextConsumed) {
                    logger.debug('[claudeRemote] Session init successful, clearing rewind context');
                    opts.onRewindContextConsumed();
                    usedRewindContext = false;  // Don't clear again
                }

                const systemInit = message as SDKSystemMessage;

                // Session id is still in memory, wait until session file is written to disk
                // Start a watcher for to detect the session id
                if (systemInit.session_id) {
                    logger.debug(`[claudeRemote] Waiting for session file to be written to disk: ${systemInit.session_id}`);
                    const projectDir = getProjectPath(opts.path);
                    const found = await awaitFileExist(join(projectDir, `${systemInit.session_id}.jsonl`));
                    logger.debug(`[claudeRemote] Session file found: ${systemInit.session_id} ${found}`);
                    opts.onSessionFound(systemInit.session_id);
                }
            }

            // Handle result messages
            if (message.type === 'result') {
                updateThinking(false);
                logger.debug('[claudeRemote] Result received');

                // Send completion messages
                if (isCompactCommand) {
                    logger.debug('[claudeRemote] Compaction completed');
                    if (opts.onCompletionEvent) {
                        opts.onCompletionEvent('Compaction completed');
                    }
                    isCompactCommand = false;
                }

                // Send ready event
                opts.onReady();

                // Check if there are queued messages that arrived while we were thinking
                // If so, send them immediately without waiting for user input
                const queueSizeAfterResult = opts.messageQueue?.size() ?? 0;
                logger.debug(`[claudeRemote] After result: queue size = ${queueSizeAfterResult}`);
                if (opts.messageQueue && queueSizeAfterResult > 0) {
                    logger.debug(`[claudeRemote] Found ${queueSizeAfterResult} queued message(s), processing immediately`);
                    logger.debug(`[claudeRemote] Found ${queueSizeAfterResult} queued message(s), processing immediately`);

                    // Collect all queued messages into one batch
                    const queuedMessages: string[] = [];
                    while (opts.messageQueue.size() > 0) {
                        const queued = opts.messageQueue.popFirst();
                        if (queued) {
                            queuedMessages.push(queued.message);
                            mode = queued.mode; // Use the mode from the last message
                        }
                    }

                    if (queuedMessages.length > 0) {
                        const combinedMessage = queuedMessages.join('\n');
                        logger.debug(`[claudeRemote] Sending ${queuedMessages.length} queued message(s) as one: "${combinedMessage.substring(0, 50)}..."`);
                        messages.push({ type: 'user', message: { role: 'user', content: combinedMessage } });
                        continue; // Continue processing - don't wait for nextMessage
                    }
                }

                // No queued messages - wait for user input
                logger.debug('[claudeRemote] No queued messages, waiting for next message');
                const next = await opts.nextMessage();
                if (!next) {
                    messages.end();
                    return;
                }
                mode = next.mode;
                messages.push({ type: 'user', message: { role: 'user', content: next.message } });
            }

            // Handle tool result
            if (message.type === 'user') {
                const msg = message as SDKUserMessage;
                if (msg.message.role === 'user' && Array.isArray(msg.message.content)) {
                    for (let c of msg.message.content) {
                        if (c.type === 'tool_result' && c.tool_use_id && opts.isAborted(c.tool_use_id)) {
                            logger.debug('[claudeRemote] Tool aborted, exiting claudeRemote');
                            return;
                        }
                    }
                }
            }
        }
    } catch (e) {
        if (e instanceof AbortError) {
            logger.debug(`[claudeRemote] Aborted`);
            // Ignore
        } else {
            throw e;
        }
    } finally {
        updateThinking(false);
        // Clean up the message queue callback to prevent stale injections
        if (opts.messageQueue) {
            opts.messageQueue.setOnMessage(null);
        }
    }
}
