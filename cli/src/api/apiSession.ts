import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import { io, type Socket } from 'socket.io-client'
import axios from 'axios'
import type { ZodType } from 'zod'
import { logger } from '@/ui/logger'
import { backoff } from '@/utils/time'
import { apiValidationError } from '@/utils/errorUtils'
import { AsyncLock } from '@/utils/lock'
import type { RawJSONLines } from '@/claude/types'
import { configuration } from '@/configuration'
import type { ClientToServerEvents, ServerToClientEvents, Update } from '@hapi/protocol'
import {
    TerminalClosePayloadSchema,
    TerminalOpenPayloadSchema,
    TerminalResizePayloadSchema,
    TerminalWritePayloadSchema
} from '@hapi/protocol'
import type {
    AgentState,
    MessageContent,
    MessageMeta,
    Metadata,
    Session,
    SessionModelMode,
    SessionPermissionMode,
    UserMessage
} from './types'
import { AgentStateSchema, CliMessagesResponseSchema, MetadataSchema, UserMessageSchema } from './types'
import { RpcHandlerManager } from './rpc/RpcHandlerManager'
import { registerCommonHandlers } from '../modules/common/registerCommonHandlers'
import { cleanupUploadDir } from '../modules/common/handlers/uploads'
import { TerminalManager } from '@/terminal/TerminalManager'
import { applyVersionedAck } from './versionedUpdate'

export class ApiSessionClient extends EventEmitter {
    private readonly token: string
    readonly sessionId: string
    private metadata: Metadata | null
    private metadataVersion: number
    private agentState: AgentState | null
    private agentStateVersion: number
    private readonly socket: Socket<ServerToClientEvents, ClientToServerEvents>
    private pendingMessages: UserMessage[] = []
    private pendingMessageCallback: ((message: UserMessage) => void) | null = null
    private lastSeenMessageSeq: number | null = null
    private backfillInFlight: Promise<void> | null = null
    private needsBackfill = false
    private hasConnectedOnce = false
    readonly rpcHandlerManager: RpcHandlerManager
    private readonly terminalManager: TerminalManager
    private agentStateLock = new AsyncLock()
    private metadataLock = new AsyncLock()

    constructor(token: string, session: Session) {
        super()
        this.token = token
        this.sessionId = session.id
        this.metadata = session.metadata
        this.metadataVersion = session.metadataVersion
        this.agentState = session.agentState
        this.agentStateVersion = session.agentStateVersion

        this.rpcHandlerManager = new RpcHandlerManager({
            scopePrefix: this.sessionId,
            logger: (msg, data) => logger.debug(msg, data)
        })

        if (this.metadata?.path) {
            registerCommonHandlers(this.rpcHandlerManager, this.metadata.path)
        }

        this.socket = io(`${configuration.apiUrl}/cli`, {
            auth: {
                token: this.token,
                clientType: 'session-scoped' as const,
                sessionId: this.sessionId
            },
            path: '/socket.io/',
            reconnection: true,
            reconnectionAttempts: Infinity,
            reconnectionDelay: 2000,       // 2s initial delay (was 1s — too aggressive)
            reconnectionDelayMax: 10000,    // 10s max backoff (was 5s)
            transports: ['websocket'],
            autoConnect: false
        })

        this.terminalManager = new TerminalManager({
            sessionId: this.sessionId,
            getSessionPath: () => this.metadata?.path ?? null,
            onReady: (payload) => this.socket.emit('terminal:ready', payload),
            onOutput: (payload) => this.socket.emit('terminal:output', payload),
            onExit: (payload) => this.socket.emit('terminal:exit', payload),
            onError: (payload) => this.socket.emit('terminal:error', payload)
        })

        this.socket.on('connect', () => {
            logger.debug('Socket connected successfully')
            this.rpcHandlerManager.onSocketConnect(this.socket)
            if (this.hasConnectedOnce) {
                this.needsBackfill = true
            }
            void this.backfillIfNeeded()
            this.hasConnectedOnce = true
            this.socket.emit('session-alive', {
                sid: this.sessionId,
                time: Date.now(),
                thinking: false
            })
        })

        this.socket.on('rpc-request', async (data: { method: string; params: string }, callback: (response: string) => void) => {
            callback(await this.rpcHandlerManager.handleRequest(data))
        })

        this.socket.on('disconnect', (reason) => {
            logger.debug('[API] Socket disconnected:', reason)
            this.rpcHandlerManager.onSocketDisconnect()
            this.terminalManager.closeAll()
            if (this.hasConnectedOnce) {
                this.needsBackfill = true
            }
        })

        this.socket.on('connect_error', (error) => {
            logger.debug('[API] Socket connection error:', error)
            this.rpcHandlerManager.onSocketDisconnect()
        })

        this.socket.on('error', (payload) => {
            logger.debug('[API] Socket error:', payload)
        })

        const handleTerminalEvent = <T extends { sessionId: string }>(
            schema: ZodType<T>,
            handler: (payload: T) => void
        ) => (data: unknown) => {
            const parsed = schema.safeParse(data)
            if (!parsed.success) {
                return
            }
            if (parsed.data.sessionId !== this.sessionId) {
                return
            }
            handler(parsed.data)
        }

        this.socket.on('terminal:open', handleTerminalEvent(TerminalOpenPayloadSchema, (payload) => {
            this.terminalManager.create(payload.terminalId, payload.cols, payload.rows)
        }))

        this.socket.on('terminal:write', handleTerminalEvent(TerminalWritePayloadSchema, (payload) => {
            this.terminalManager.write(payload.terminalId, payload.data)
        }))

        this.socket.on('terminal:resize', handleTerminalEvent(TerminalResizePayloadSchema, (payload) => {
            this.terminalManager.resize(payload.terminalId, payload.cols, payload.rows)
        }))

        this.socket.on('terminal:close', handleTerminalEvent(TerminalClosePayloadSchema, (payload) => {
            this.terminalManager.close(payload.terminalId)
        }))

        this.socket.on('update', (data: Update) => {
            try {
                if (!data.body) return

                if (data.body.t === 'new-message') {
                    logger.debug(`[API] socket.on('update'): Received new-message with seq=${data.body.message?.seq}`)
                    this.handleIncomingMessage(data.body.message)
                    return
                }

                if (data.body.t === 'update-session') {
                    if (data.body.metadata && data.body.metadata.version > this.metadataVersion) {
                        const parsed = MetadataSchema.safeParse(data.body.metadata.value)
                        if (parsed.success) {
                            this.metadata = parsed.data
                        } else {
                            logger.debug('[API] Ignoring invalid metadata update', { version: data.body.metadata.version })
                        }
                        this.metadataVersion = data.body.metadata.version
                    }
                    if (data.body.agentState && data.body.agentState.version > this.agentStateVersion) {
                        const next = data.body.agentState.value
                        if (next == null) {
                            this.agentState = null
                        } else {
                            const parsed = AgentStateSchema.safeParse(next)
                            if (parsed.success) {
                                this.agentState = parsed.data
                            } else {
                                logger.debug('[API] Ignoring invalid agentState update', { version: data.body.agentState.version })
                            }
                        }
                        this.agentStateVersion = data.body.agentState.version
                    }
                    return
                }

                this.emit('message', data.body)
            } catch (error) {
                logger.debug('[SOCKET] [UPDATE] [ERROR] Error handling update', { error })
            }
        })

        this.socket.connect()
    }

    onUserMessage(callback: (data: UserMessage) => void): void {
        this.pendingMessageCallback = callback
        while (this.pendingMessages.length > 0) {
            callback(this.pendingMessages.shift()!)
        }
    }

    private enqueueUserMessage(message: UserMessage): void {
        if (this.pendingMessageCallback) {
            logger.debug(`[API] enqueueUserMessage: Calling pendingMessageCallback with message: "${message.content.text?.substring(0, 50)}..."`)
            this.pendingMessageCallback(message)
        } else {
            logger.debug(`[API] enqueueUserMessage: No callback yet, pushing to pendingMessages queue (now ${this.pendingMessages.length + 1} messages)`)
            this.pendingMessages.push(message)
        }
    }

    private handleIncomingMessage(message: { seq?: number; content: unknown }): void {
        const seq = typeof message.seq === 'number' ? message.seq : null
        logger.debug(`[API] handleIncomingMessage: seq=${seq}, lastSeenMessageSeq=${this.lastSeenMessageSeq}`)

        if (seq !== null) {
            if (this.lastSeenMessageSeq !== null && seq <= this.lastSeenMessageSeq) {
                logger.debug(`[API] handleIncomingMessage: DROPPING message with seq=${seq} (already seen, lastSeenMessageSeq=${this.lastSeenMessageSeq})`)
                return
            }
            this.lastSeenMessageSeq = seq
            logger.debug(`[API] handleIncomingMessage: Updated lastSeenMessageSeq to ${seq}`)
        }

        const userResult = UserMessageSchema.safeParse(message.content)
        if (userResult.success) {
            logger.debug(`[API] handleIncomingMessage: Parsed as UserMessage, enqueueing`)
            this.enqueueUserMessage(userResult.data)
            return
        }

        logger.debug(`[API] handleIncomingMessage: Not a UserMessage, emitting as generic message`)
        this.emit('message', message.content)
    }

    /**
     * Trigger a backfill check after a Claude turn completes.
     * Catches messages silently dropped by Socket.IO during thinking
     * (socket stays connected but individual messages lost).
     */
    async backfillAfterTurn(): Promise<void> {
        if (this.lastSeenMessageSeq === null) return
        try {
            await this.backfillMessages()
        } catch (error) {
            logger.debug('[API] backfillAfterTurn failed', error)
        }
    }

    private async backfillIfNeeded(): Promise<void> {
        if (!this.needsBackfill) {
            return
        }
        try {
            await this.backfillMessages()
            this.needsBackfill = false
        } catch (error) {
            logger.debug('[API] Backfill failed', error)
            this.needsBackfill = true
        }
    }

    private async backfillMessages(): Promise<void> {
        if (this.backfillInFlight) {
            await this.backfillInFlight
            return
        }

        const startSeq = this.lastSeenMessageSeq
        if (startSeq === null) {
            logger.debug('[API] Skipping backfill because no last-seen message sequence is available')
            return
        }

        const limit = 200
        const run = async () => {
            let cursor = startSeq
            while (true) {
                const response = await axios.get(
                    `${configuration.apiUrl}/cli/sessions/${encodeURIComponent(this.sessionId)}/messages`,
                    {
                        params: { afterSeq: cursor, limit },
                        headers: {
                            Authorization: `Bearer ${this.token}`,
                            'Content-Type': 'application/json'
                        },
                        timeout: 15_000
                    }
                )

                const parsed = CliMessagesResponseSchema.safeParse(response.data)
                if (!parsed.success) {
                    throw apiValidationError('Invalid /cli/sessions/:id/messages response', response)
                }

                const messages = parsed.data.messages
                if (messages.length === 0) {
                    break
                }

                let maxSeq = cursor
                for (const message of messages) {
                    if (typeof message.seq === 'number') {
                        if (message.seq > maxSeq) {
                            maxSeq = message.seq
                        }
                    }
                    this.handleIncomingMessage(message)
                }

                const observedSeq = this.lastSeenMessageSeq ?? maxSeq
                const nextCursor = Math.max(maxSeq, observedSeq)
                if (nextCursor <= cursor) {
                    logger.debug('[API] Backfill stopped due to non-advancing cursor', {
                        cursor,
                        maxSeq,
                        observedSeq
                    })
                    break
                }

                cursor = nextCursor
                if (messages.length < limit) {
                    break
                }
            }
        }

        this.backfillInFlight = run().finally(() => {
            this.backfillInFlight = null
        })

        await this.backfillInFlight
    }

    sendClaudeSessionMessage(body: RawJSONLines): void {
        let content: MessageContent

        if (body.type === 'user' && typeof body.message.content === 'string' && body.isSidechain !== true && body.isMeta !== true) {
            content = {
                role: 'user',
                content: {
                    type: 'text',
                    text: body.message.content
                },
                meta: {
                    sentFrom: 'cli'
                }
            }
        } else {
            content = {
                role: 'agent',
                content: {
                    type: 'output',
                    data: body
                },
                meta: {
                    sentFrom: 'cli'
                }
            }
        }

        this.socket.emit('message', {
            sid: this.sessionId,
            message: content
        })

        if (body.type === 'summary' && 'summary' in body && 'leafUuid' in body) {
            this.updateMetadata((metadata) => ({
                ...metadata,
                summary: {
                    text: body.summary,
                    updatedAt: Date.now()
                }
            }))
        }
    }

    sendUserMessage(text: string, meta?: MessageMeta): void {
        if (!text) {
            return
        }

        const content: MessageContent = {
            role: 'user',
            content: {
                type: 'text',
                text
            },
            meta: {
                sentFrom: 'cli',
                ...(meta ?? {})
            }
        }

        this.socket.emit('message', {
            sid: this.sessionId,
            message: content
        })
    }

    sendCodexMessage(body: unknown): void {
        const content = {
            role: 'agent',
            content: {
                type: 'codex',
                data: body,
                timestamp: new Date().toISOString()
            },
            meta: {
                sentFrom: 'cli'
            }
        }
        this.socket.emit('message', {
            sid: this.sessionId,
            message: content
        })
    }

    sendSessionEvent(event: {
        type: 'switch'
        mode: 'local' | 'remote'
    } | {
        type: 'message'
        message: string
    } | {
        type: 'permission-mode-changed'
        mode: SessionPermissionMode
    } | {
        type: 'ready'
    }, id?: string): void {
        const content = {
            role: 'agent',
            content: {
                id: id ?? randomUUID(),
                type: 'event',
                data: event,
                timestamp: new Date().toISOString()
            }
        }

        this.socket.emit('message', {
            sid: this.sessionId,
            message: content
        })
    }

    keepAlive(
        thinking: boolean,
        mode: 'local' | 'remote',
        runtime?: { permissionMode?: SessionPermissionMode; modelMode?: SessionModelMode }
    ): void {
        this.socket.volatile.emit('session-alive', {
            sid: this.sessionId,
            time: Date.now(),
            thinking,
            mode,
            ...(runtime ?? {})
        })
    }

    sendSessionDeath(): void {
        void cleanupUploadDir(this.sessionId)
        this.socket.emit('session-end', { sid: this.sessionId, time: Date.now() })
    }

    updateMetadata(handler: (metadata: Metadata) => Metadata): Promise<void> {
        return this.metadataLock.inLock(async () => {
            await backoff(async () => {
                const current = this.metadata ?? ({} as Metadata)
                const updated = handler(current)

                const answer = await this.socket.emitWithAck('update-metadata', {
                    sid: this.sessionId,
                    expectedVersion: this.metadataVersion,
                    metadata: updated
                }) as unknown

                applyVersionedAck(answer, {
                    valueKey: 'metadata',
                    parseValue: (value) => {
                        const parsed = MetadataSchema.safeParse(value)
                        if (!parsed.success) {
                            logger.debug(`[API] MetadataSchema.safeParse failed:`, parsed.error)
                            logger.debug(`[API] Raw value keys:`, value && typeof value === 'object' ? Object.keys(value as object) : 'not object')
                            // Check if rewindContextSummary is in the raw value
                            if (value && typeof value === 'object' && 'rewindContextSummary' in (value as object)) {
                                logger.debug(`[API] rewindContextSummary IS in raw value, length:`, ((value as Record<string, unknown>).rewindContextSummary as string)?.length)
                            }
                        }
                        return parsed.success ? parsed.data : null
                    },
                    applyValue: (value) => {
                        this.metadata = value
                        logger.debug(`[API] Applied metadata, rewindContextSummary length:`, (value as Record<string, unknown> | null)?.rewindContextSummary ? ((value as Record<string, unknown>).rewindContextSummary as string).length : 0)
                    },
                    applyVersion: (version) => {
                        this.metadataVersion = version
                    },
                    logInvalidValue: (context, version) => {
                        const suffix = context === 'success' ? 'ack' : 'version-mismatch ack'
                        logger.debug(`[API] Ignoring invalid metadata value from ${suffix}`, { version })
                    },
                    invalidResponseMessage: 'Invalid update-metadata response',
                    errorMessage: 'Metadata update failed',
                    versionMismatchMessage: 'Metadata version mismatch'
                })
            })
        })
    }

    updateAgentState(handler: (state: AgentState) => AgentState): void {
        this.agentStateLock.inLock(async () => {
            await backoff(async () => {
                const current = this.agentState ?? ({} as AgentState)
                const updated = handler(current)

                const answer = await this.socket.emitWithAck('update-state', {
                    sid: this.sessionId,
                    expectedVersion: this.agentStateVersion,
                    agentState: updated
                }) as unknown

                applyVersionedAck(answer, {
                    valueKey: 'agentState',
                    parseValue: (value) => {
                        const parsed = AgentStateSchema.safeParse(value)
                        return parsed.success ? parsed.data : null
                    },
                    applyValue: (value) => {
                        this.agentState = value
                    },
                    applyVersion: (version) => {
                        this.agentStateVersion = version
                    },
                    logInvalidValue: (context, version) => {
                        const suffix = context === 'success' ? 'ack' : 'version-mismatch ack'
                        logger.debug(`[API] Ignoring invalid agentState value from ${suffix}`, { version })
                    },
                    invalidResponseMessage: 'Invalid update-state response',
                    errorMessage: 'Agent state update failed',
                    versionMismatchMessage: 'Agent state version mismatch'
                })
            })
        })
    }

    private async waitForConnected(timeoutMs: number): Promise<boolean> {
        if (this.socket.connected) {
            return true
        }

        this.socket.connect()

        return await new Promise<boolean>((resolve) => {
            let settled = false

            const cleanup = () => {
                this.socket.off('connect', onConnect)
                clearTimeout(timeout)
            }

            const onConnect = () => {
                if (settled) return
                settled = true
                cleanup()
                resolve(true)
            }

            const timeout = setTimeout(() => {
                if (settled) return
                settled = true
                cleanup()
                resolve(false)
            }, Math.max(0, timeoutMs))

            this.socket.on('connect', onConnect)
        })
    }

    private async drainLock(lock: AsyncLock, timeoutMs: number): Promise<boolean> {
        if (timeoutMs <= 0) {
            return false
        }

        return await new Promise<boolean>((resolve) => {
            let settled = false
            let timeout: ReturnType<typeof setTimeout> | null = null

            const finish = (value: boolean) => {
                if (settled) return
                settled = true
                if (timeout) {
                    clearTimeout(timeout)
                }
                resolve(value)
            }

            timeout = setTimeout(() => finish(false), timeoutMs)

            lock.inLock(async () => { })
                .then(() => finish(true))
                .catch(() => finish(false))
        })
    }

    async flush(options?: { timeoutMs?: number }): Promise<void> {
        const deadlineMs = Date.now() + (options?.timeoutMs ?? 5_000)

        const remainingMs = () => Math.max(0, deadlineMs - Date.now())

        await this.drainLock(this.metadataLock, remainingMs())
        await this.drainLock(this.agentStateLock, remainingMs())

        if (remainingMs() === 0) {
            return
        }

        const connected = await this.waitForConnected(remainingMs())
        if (!connected) {
            return
        }

        const pingTimeoutMs = remainingMs()
        if (pingTimeoutMs === 0) {
            return
        }

        try {
            await this.socket.timeout(pingTimeoutMs).emitWithAck('ping')
        } catch {
            // best effort
        }
    }

    close(): void {
        this.rpcHandlerManager.onSocketDisconnect()
        this.terminalManager.closeAll()
        this.socket.disconnect()
    }

    /**
     * Get the rewind context summary from metadata.
     * Used to inject historical conversation context when resuming after rewinding past compaction.
     */
    getRewindContextSummary(): string | undefined {
        return (this.metadata as Record<string, unknown> | null)?.rewindContextSummary as string | undefined
    }

    /**
     * Clear the rewind context summary from metadata.
     * Called after successfully injecting the context into the system prompt.
     */
    clearRewindContextSummary(): void {
        this.updateMetadata((metadata) => {
            const updated = { ...metadata } as Record<string, unknown>
            delete updated.rewindContextSummary
            return updated as typeof metadata
        })
    }

    /**
     * Request context recovery from the Hub.
     * Sets needsContextRecovery flag in metadata, which triggers the Hub to build
     * full conversation history and store it as rewindContextSummary.
     * This preserves conversation context when Claude session is reset (e.g., after abort).
     * @returns Promise that resolves when the context recovery is complete and metadata is updated
     */
    requestContextRecovery(): Promise<void> {
        return this.updateMetadata((metadata) => {
            const updated = { ...metadata } as Record<string, unknown>
            updated.needsContextRecovery = true
            return updated as typeof metadata
        })
    }
}
