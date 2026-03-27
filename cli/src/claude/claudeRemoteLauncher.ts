import React from "react";
import { Session } from "./session";
import { RemoteModeDisplay } from "@/ui/ink/RemoteModeDisplay";
import { claudeRemote } from "./claudeRemote";
import { PermissionHandler } from "./utils/permissionHandler";
import { Future } from "@/utils/future";
import { SDKAssistantMessage, SDKMessage, SDKUserMessage, AbortError } from "./sdk";
import { formatClaudeMessageForInk } from "@/ui/messageFormatterInk";
import { logger } from "@/ui/logger";
import { SDKToLogConverter } from "./utils/sdkToLogConverter";
import { PLAN_FAKE_REJECT } from "./sdk/prompts";
import { EnhancedMode, PermissionMode } from "./loop";
import { OutgoingMessageQueue } from "./utils/OutgoingMessageQueue";
import type { ClaudePermissionMode } from "@hapi/protocol/types";
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from "@/modules/common/remote/RemoteLauncherBase";

interface PermissionsField {
    date: number;
    result: 'approved' | 'denied';
    mode?: ClaudePermissionMode;
    allowedTools?: string[];
}

class ClaudeRemoteLauncher extends RemoteLauncherBase {
    private readonly session: Session;
    private abortController: AbortController | null = null;
    private abortFuture: Future<void> | null = null;
    private permissionHandler: PermissionHandler | null = null;
    private handleSessionFound: ((sessionId: string) => void) | null = null;

    constructor(session: Session) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(RemoteModeDisplay, context);
    }

    private async abort(): Promise<void> {
        if (this.abortController && !this.abortController.signal.aborted) {
            this.abortController.abort();
        }
        await this.abortFuture?.promise;
    }

    private async handleAbortRequest(): Promise<void> {
        logger.debug('[remote]: doAbort');
        await this.abort();
    }

    private async handleSwitchRequest(): Promise<void> {
        logger.debug('[remote]: doSwitch');
        await this.requestExit('switch', async () => {
            await this.abort();
        });
    }

    private async handleExitFromUi(): Promise<void> {
        logger.debug('[remote]: Exiting client via Ctrl-C');
        await this.requestExit('exit', async () => {
            await this.abort();
        });
    }

    private async handleSwitchFromUi(): Promise<void> {
        logger.debug('[remote]: Switching to local mode via double space');
        await this.handleSwitchRequest();
    }

    public async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({
            onExit: () => this.handleExitFromUi(),
            onSwitchToLocal: () => this.handleSwitchFromUi()
        });
    }

    protected async runMainLoop(): Promise<void> {
        logger.debug('[claudeRemoteLauncher] Starting remote launcher');
        logger.debug(`[claudeRemoteLauncher] TTY available: ${this.hasTTY}`);

        const session = this.session;
        const messageBuffer = this.messageBuffer;

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbortRequest(),
            onSwitch: () => this.handleSwitchRequest()
        });

        const permissionHandler = new PermissionHandler(session);
        this.permissionHandler = permissionHandler;

        const messageQueue = new OutgoingMessageQueue(
            (logMessage) => session.client.sendClaudeSessionMessage(logMessage)
        );

        permissionHandler.setOnPermissionRequest((toolCallId: string) => {
            messageQueue.releaseToolCall(toolCallId);
        });

        const sdkToLogConverter = new SDKToLogConverter({
            sessionId: session.sessionId || 'unknown',
            cwd: session.path,
            version: process.env.npm_package_version
        }, permissionHandler.getResponses());

        const handleSessionFound = (sessionId: string) => {
            sdkToLogConverter.updateSessionId(sessionId);
        };
        this.handleSessionFound = handleSessionFound;
        session.addSessionFoundCallback(handleSessionFound);

        let planModeToolCalls = new Set<string>();
        let ongoingToolCalls = new Map<string, { parentToolCallId: string | null }>();

        function onMessage(message: SDKMessage) {
            formatClaudeMessageForInk(message, messageBuffer);
            permissionHandler.onMessage(message);

            if (message.type === 'assistant') {
                let umessage = message as SDKAssistantMessage;
                if (umessage.message.content && Array.isArray(umessage.message.content)) {
                    for (let c of umessage.message.content) {
                        if (c.type === 'tool_use' && (c.name === 'exit_plan_mode' || c.name === 'ExitPlanMode')) {
                            logger.debug('[remote]: detected plan mode tool call ' + c.id!);
                            planModeToolCalls.add(c.id! as string);
                        }
                    }
                }
            }

            if (message.type === 'assistant') {
                let umessage = message as SDKAssistantMessage;
                if (umessage.message.content && Array.isArray(umessage.message.content)) {
                    for (let c of umessage.message.content) {
                        if (c.type === 'tool_use') {
                            logger.debug('[remote]: detected tool use ' + c.id! + ' parent: ' + umessage.parent_tool_use_id);
                            ongoingToolCalls.set(c.id!, { parentToolCallId: umessage.parent_tool_use_id ?? null });
                        }
                    }
                }
            }
            if (message.type === 'user') {
                let umessage = message as SDKUserMessage;
                if (umessage.message.content && Array.isArray(umessage.message.content)) {
                    for (let c of umessage.message.content) {
                        if (c.type === 'tool_result' && c.tool_use_id) {
                            ongoingToolCalls.delete(c.tool_use_id);
                            messageQueue.releaseToolCall(c.tool_use_id);
                        }
                    }
                }
            }

            let msg = message;

            if (message.type === 'user') {
                let umessage = message as SDKUserMessage;
                if (umessage.message.content && Array.isArray(umessage.message.content)) {
                    msg = {
                        ...umessage,
                        message: {
                            ...umessage.message,
                            content: umessage.message.content.map((c) => {
                                if (c.type === 'tool_result' && c.tool_use_id && planModeToolCalls.has(c.tool_use_id!)) {
                                    if (c.content === PLAN_FAKE_REJECT) {
                                        logger.debug('[remote]: hack plan mode exit');
                                        logger.debugLargeJson('[remote]: hack plan mode exit', c);
                                        return {
                                            ...c,
                                            is_error: false,
                                            content: 'Plan approved',
                                            mode: c.mode
                                        };
                                    } else {
                                        return c;
                                    }
                                }
                                return c;
                            })
                        }
                    };
                }
            }

            const logMessage = sdkToLogConverter.convert(msg);
            if (logMessage) {
                if (logMessage.type === 'user' && logMessage.message?.content) {
                    const content = Array.isArray(logMessage.message.content)
                        ? logMessage.message.content
                        : [];

                    for (let i = 0; i < content.length; i++) {
                        const c = content[i];
                        if (c.type === 'tool_result' && c.tool_use_id) {
                            const responses = permissionHandler.getResponses();
                            const response = responses.get(c.tool_use_id);

                            if (response) {
                                const permissions: PermissionsField = {
                                    date: response.receivedAt || Date.now(),
                                    result: response.approved ? 'approved' : 'denied'
                                };

                                if (response.mode) {
                                    permissions.mode = response.mode;
                                }

                                if (response.allowTools && response.allowTools.length > 0) {
                                    permissions.allowedTools = response.allowTools;
                                }

                                content[i] = {
                                    ...c,
                                    permissions
                                };
                            }
                        }
                    }
                }

                if (logMessage.type === 'assistant' && message.type === 'assistant') {
                    const assistantMsg = message as SDKAssistantMessage;
                    const toolCallIds: string[] = [];

                    if (assistantMsg.message.content && Array.isArray(assistantMsg.message.content)) {
                        for (const block of assistantMsg.message.content) {
                            if (block.type === 'tool_use' && block.id) {
                                toolCallIds.push(block.id);
                            }
                        }
                    }

                    if (toolCallIds.length > 0) {
                        const isSidechain = assistantMsg.parent_tool_use_id !== undefined;

                        if (!isSidechain) {
                            messageQueue.enqueue(logMessage, {
                                delay: 250,
                                toolCallIds
                            });
                            return;
                        }
                    }
                }

                messageQueue.enqueue(logMessage);
            }

            if (message.type === 'assistant') {
                let umessage = message as SDKAssistantMessage;
                if (umessage.message.content && Array.isArray(umessage.message.content)) {
                    for (let c of umessage.message.content) {
                        if (c.type === 'tool_use' && (c.name === 'Task' || c.name === 'Agent') && c.input && typeof (c.input as any).prompt === 'string') {
                            const logMessage2 = sdkToLogConverter.convertSidechainUserMessage(c.id!, (c.input as any).prompt);
                            if (logMessage2) {
                                messageQueue.enqueue(logMessage2);
                            }
                        }
                    }
                }
            }
        }

        try {
            let pending: {
                message: string;
                mode: EnhancedMode;
            } | null = null;

            let previousSessionId: string | null = null;
            // Track if we need to temporarily downgrade YOLO mode after abort
            // YOLO mode (bypassPermissions/dangerouslySkipPermissions) can fail on the
            // first message after abort because the fresh Claude process hasn't fully
            // initialized. We temporarily use 'acceptEdits' for the first message, then
            // restore the original mode once the session is established.
            let downgradeYoloForFirstMessage = false;
            let originalYoloMode: string | null = null;
            while (!this.exitReason) {
                logger.debug('[remote]: launch');
                messageBuffer.addMessage('═'.repeat(40), 'status');

                const isNewSession = session.sessionId !== previousSessionId;
                if (isNewSession) {
                    messageBuffer.addMessage('Starting new Claude session...', 'status');
                    permissionHandler.reset();
                    sdkToLogConverter.resetParentChain();
                    logger.debug(`[remote]: New session detected (previous: ${previousSessionId}, current: ${session.sessionId})`);
                } else {
                    messageBuffer.addMessage('Continuing Claude session...', 'status');
                    logger.debug(`[remote]: Continuing existing session: ${session.sessionId}`);
                }

                previousSessionId = session.sessionId;
                const controller = new AbortController();
                this.abortController = controller;
                this.abortFuture = new Future<void>();
                let modeHash: string | null = null;
                let mode: EnhancedMode | null = null;

                // If starting fresh (no Claude session ID) and no rewind context available,
                // request context recovery to preserve conversation history
                let rewindContext = session.getRewindContextSummary();
                if (!session.sessionId && !rewindContext) {
                    logger.debug('[remote]: No session ID and no rewind context - requesting context recovery');
                    await session.requestContextRecovery();
                    rewindContext = session.getRewindContextSummary();
                    logger.debug(`[remote]: After context recovery - hasRewindContext=${!!rewindContext}, length=${rewindContext?.length ?? 0}`);
                }

                // Log key state for debugging
                logger.debug(`[remote]: About to call claudeRemote - sessionId=${session.sessionId}, hasRewindContext=${!!rewindContext}, rewindContextLength=${rewindContext?.length ?? 0}`);

                try {
                    await claudeRemote({
                        sessionId: session.sessionId,
                        path: session.path,
                        allowedTools: session.allowedTools ?? [],
                        mcpServers: session.mcpServers,
                        hookSettingsPath: session.hookSettingsPath,
                        canCallTool: permissionHandler.handleToolCall,
                        isAborted: (toolCallId: string) => {
                            return permissionHandler.isAborted(toolCallId);
                        },
                        nextMessage: async () => {
                            logger.debug(`[remote] nextMessage called - pending=${!!pending}, queueSize=${session.queue.size()}, downgradeYolo=${downgradeYoloForFirstMessage}`);

                            if (pending) {
                                let p = pending;
                                pending = null;
                                logger.debug(`[remote] nextMessage returning pending message`);
                                // Apply YOLO downgrade if needed
                                if (downgradeYoloForFirstMessage && originalYoloMode) {
                                    logger.debug(`[remote] Downgrading YOLO mode to acceptEdits for first message after abort`);
                                    p = {
                                        ...p,
                                        mode: { ...p.mode, permissionMode: 'acceptEdits' as PermissionMode }
                                    };
                                    downgradeYoloForFirstMessage = false;
                                }
                                permissionHandler.handleModeChange(p.mode.permissionMode);
                                return p;
                            }

                            logger.debug(`[remote] nextMessage waiting for messages...`);
                            let msg = await session.queue.waitForMessagesAndGetAsString(controller.signal);
                            logger.debug(`[remote] nextMessage got message: ${msg ? `"${msg.message.substring(0, 30)}..."` : 'null'}`);

                            if (msg) {
                                if ((modeHash && msg.hash !== modeHash) || msg.isolate) {
                                    logger.debug(`[remote]: mode has changed (modeHash=${modeHash}, msg.hash=${msg.hash}, isolate=${msg.isolate}), setting pending`);
                                    pending = msg;
                                    return null;
                                }
                                modeHash = msg.hash;
                                mode = msg.mode;

                                // Apply YOLO downgrade if needed for first message after abort
                                if (downgradeYoloForFirstMessage && originalYoloMode) {
                                    logger.debug(`[remote] Downgrading YOLO mode to acceptEdits for first message after abort`);
                                    const downgradedMode: EnhancedMode = { ...msg.mode, permissionMode: 'acceptEdits' as PermissionMode };
                                    downgradeYoloForFirstMessage = false;
                                    permissionHandler.handleModeChange(downgradedMode.permissionMode);
                                    return {
                                        message: msg.message,
                                        mode: downgradedMode
                                    };
                                }

                                permissionHandler.handleModeChange(mode.permissionMode);
                                logger.debug(`[remote] nextMessage returning message`);
                                return {
                                    message: msg.message,
                                    mode: msg.mode
                                };
                            }

                            logger.debug(`[remote] nextMessage returning null (no message)`);
                            return null;
                        },
                        onSessionFound: (sessionId) => {
                            session.onSessionFound(sessionId);
                        },
                        onThinkingChange: session.onThinkingChange,
                        claudeEnvVars: session.claudeEnvVars,
                        claudeArgs: session.claudeArgs,
                        onMessage,
                        onCompletionEvent: async (message: string) => {
                            logger.debug(`[remote]: Completion event: ${message}`);

                            // Handle /recover command - force context recovery
                            if (message === '__recover_context__') {
                                console.log('[RECOVER]: Context recovery requested via /recover command');
                                session.client.sendSessionEvent({ type: 'message', message: 'Recovering conversation context...' });

                                // Clear session ID first
                                session.clearSessionId();
                                console.log('[RECOVER]: Cleared session ID');

                                // Request context recovery
                                await session.requestContextRecovery();
                                console.log('[RECOVER]: requestContextRecovery() completed');

                                const context = session.getRewindContextSummary();
                                console.log(`[RECOVER]: getRewindContextSummary() returned: ${context ? `${context.length} chars` : 'undefined'}`);

                                if (context) {
                                    console.log(`[RECOVER]: First 200 chars of context: ${context.slice(0, 200)}`);
                                    session.client.sendSessionEvent({ type: 'message', message: `Context recovered (${context.length} characters). Send a message to continue.` });
                                } else {
                                    console.log('[RECOVER]: No context found to recover');
                                    session.client.sendSessionEvent({ type: 'message', message: 'No conversation history found to recover.' });
                                }
                                session.client.sendSessionEvent({ type: 'ready' });
                                return;
                            }

                            session.client.sendSessionEvent({ type: 'message', message });
                        },
                        onSessionReset: () => {
                            logger.debug('[remote]: Session reset');
                            session.clearSessionId();
                        },
                        onReady: () => {
                            // Restore YOLO mode after the first successful result
                            // The first message was sent with acceptEdits for safety,
                            // now that the session is established, restore the original mode
                            if (originalYoloMode) {
                                logger.debug(`[remote] Session established, restoring permission mode to ${originalYoloMode}`);
                                if (mode) {
                                    mode = { ...mode, permissionMode: originalYoloMode as PermissionMode };
                                }
                                permissionHandler.handleModeChange(originalYoloMode as PermissionMode);
                                originalYoloMode = null;
                            }
                            // Backfill any messages that may have been dropped by Socket.IO
                            // during thinking (socket stays connected but messages silently lost)
                            void session.client.backfillAfterTurn();
                            if (!pending && session.queue.size() === 0) {
                                session.client.sendSessionEvent({ type: 'ready' });
                            }
                        },
                        signal: controller.signal,
                        // Pass rewind context summary for cross-compaction rewind support
                        rewindContextSummary: (() => {
                            const ctx = session.getRewindContextSummary();
                            console.log(`[LAUNCHER]: Passing rewindContextSummary to claudeRemote: ${ctx ? `${ctx.length} chars` : 'undefined'}`);
                            return ctx;
                        })(),
                        onRewindContextConsumed: () => {
                            console.log('[LAUNCHER]: onRewindContextConsumed called - clearing context');
                            session.clearRewindContextSummary();
                        },
                        // Pass message queue for real-time steering (mid-turn message injection)
                        messageQueue: session.queue,
                    });

                    session.consumeOneTimeFlags();

                    if (!this.exitReason && controller.signal.aborted) {
                        session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                        // Keep session ID so next spawn can --resume with full Claude context.
                        // claudeCheckSession() in claudeRemote.ts will validate the session file;
                        // if invalid, it falls back to null (fresh session + context recovery).
                        logger.debug(`[remote]: Abort - keeping session ID ${session.sessionId} for resume`);
                        // If we were in YOLO mode, downgrade first message to acceptEdits
                        // to avoid process crash on fresh session spawn
                        if (mode && (mode.permissionMode === 'bypassPermissions' || mode.permissionMode === 'dangerouslySkipPermissions')) {
                            originalYoloMode = mode.permissionMode;
                            downgradeYoloForFirstMessage = true;
                            logger.debug(`[remote]: YOLO mode abort - will downgrade first message to acceptEdits, then restore ${originalYoloMode}`);
                        }
                        if (!pending && session.queue.size() === 0) {
                            session.client.sendSessionEvent({ type: 'ready' });
                        }
                    }
                } catch (e) {
                    // AbortError is expected when user aborts - don't show error message
                    if (e instanceof AbortError) {
                        logger.debug(`[remote]: AbortError caught (expected) - keeping session ID ${session.sessionId} for resume`);
                        // If we were in YOLO mode, downgrade first message to acceptEdits
                        if (mode && (mode.permissionMode === 'bypassPermissions' || mode.permissionMode === 'dangerouslySkipPermissions')) {
                            originalYoloMode = mode.permissionMode;
                            downgradeYoloForFirstMessage = true;
                            logger.debug(`[remote]: YOLO mode abort - will downgrade first message to acceptEdits, then restore ${originalYoloMode}`);
                        }
                        session.client.sendSessionEvent({ type: 'ready' });
                        continue;
                    }

                    // If we get a non-AbortError after abort (e.g., process exit code 1),
                    // clear the session ID and request context recovery, then retry silently
                    if (controller.signal.aborted) {
                        logger.debug(`[remote]: Non-AbortError after abort - keeping session ID ${session.sessionId} for resume`);
                        // If we were in YOLO mode, downgrade first message to acceptEdits
                        if (mode && (mode.permissionMode === 'bypassPermissions' || mode.permissionMode === 'dangerouslySkipPermissions')) {
                            originalYoloMode = mode.permissionMode;
                            downgradeYoloForFirstMessage = true;
                            logger.debug(`[remote]: YOLO mode abort - will downgrade first message to acceptEdits, then restore ${originalYoloMode}`);
                        }
                        if (!pending && session.queue.size() === 0) {
                            session.client.sendSessionEvent({ type: 'ready' });
                        }
                        continue;
                    }
                    const errorMessage = e instanceof Error ? e.message : String(e);
                    const errorStack = e instanceof Error ? e.stack : undefined;
                    logger.debug('[remote]: launch error', e);
                    logger.debug('[remote]: error message:', errorMessage);
                    if (errorStack) {
                        logger.debug('[remote]: error stack:', errorStack);
                    }
                    if (!this.exitReason && !controller.signal.aborted) {
                        // Detect root/sudo permission crash and auto-downgrade to prevent death loop
                        // When Claude Code rejects --dangerously-skip-permissions under root,
                        // every subsequent message would crash with the same error.
                        const isRootPermissionCrash = errorMessage.includes('dangerously-skip-permissions')
                            && (errorMessage.includes('root') || errorMessage.includes('sudo'));
                        if (isRootPermissionCrash && mode) {
                            logger.debug('[remote]: Root/sudo permission crash detected - downgrading to acceptEdits');
                            mode = { ...mode, permissionMode: 'acceptEdits' as PermissionMode };
                            permissionHandler.handleModeChange('acceptEdits' as PermissionMode);
                            session.client.sendSessionEvent({
                                type: 'message',
                                message: 'Cannot use Yolo mode as root/sudo. Automatically downgraded to Accept Edits mode. Send your message again to continue.'
                            });
                        } else {
                            session.client.sendSessionEvent({ type: 'message', message: `Process exited unexpectedly: ${errorMessage}` });
                        }
                        // Clear session ID on error so next spawn starts fresh
                        // The context recovery will happen automatically at the start of the next iteration
                        session.clearSessionId();
                        // Send ready event so the UI re-enables input after the crash.
                        // Without this, the web UI stays in "running" state and the user
                        // can't interact with the session.
                        if (!pending && session.queue.size() === 0) {
                            session.client.sendSessionEvent({ type: 'ready' });
                        }
                        continue;
                    }
                } finally {
                    logger.debug('[remote]: launch finally');

                    for (let [toolCallId, { parentToolCallId }] of ongoingToolCalls) {
                        const converted = sdkToLogConverter.generateInterruptedToolResult(toolCallId, parentToolCallId);
                        if (converted) {
                            logger.debug('[remote]: terminating tool call ' + toolCallId + ' parent: ' + parentToolCallId);
                            session.client.sendClaudeSessionMessage(converted);
                        }
                    }
                    ongoingToolCalls.clear();

                    logger.debug('[remote]: flushing message queue');
                    await messageQueue.flush();
                    messageQueue.destroy();
                    logger.debug('[remote]: message queue flushed');

                    this.abortController = null;
                    this.abortFuture?.resolve(undefined);
                    this.abortFuture = null;
                    logger.debug('[remote]: launch done');
                    permissionHandler.reset();
                    modeHash = null;
                    mode = null;
                }
            }
        } finally {
            if (this.permissionHandler) {
                this.permissionHandler.reset();
            }
        }
    }

    protected async cleanup(): Promise<void> {
        this.clearAbortHandlers(this.session.client.rpcHandlerManager);

        if (this.handleSessionFound) {
            this.session.removeSessionFoundCallback(this.handleSessionFound);
            this.handleSessionFound = null;
        }

        if (this.permissionHandler) {
            this.permissionHandler.reset();
        }

        if (this.abortFuture) {
            this.abortFuture.resolve(undefined);
        }
    }
}

export async function claudeRemoteLauncher(session: Session): Promise<'switch' | 'exit'> {
    const launcher = new ClaudeRemoteLauncher(session);
    return launcher.launch();
}
