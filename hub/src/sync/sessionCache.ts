import { isThinkingLevelAllowedForModel } from '@hapi/protocol'
import { AgentStateSchema, MetadataSchema } from '@hapi/protocol/schemas'
import type { ModelMode, PermissionMode, Session, ThinkingLevel } from '@hapi/protocol/types'
import type { Store } from '../store'
import { clampAliveTime } from './aliveTime'
import { EventPublisher } from './eventPublisher'
import { extractTodoWriteTodosFromMessageContent, TodosSchema } from './todos'

export class SessionCache {
    private readonly sessions: Map<string, Session> = new Map()
    private readonly lastBroadcastAtBySessionId: Map<string, number> = new Map()
    private readonly todoBackfillAttemptedSessionIds: Set<string> = new Set()

    constructor(
        private readonly store: Store,
        private readonly publisher: EventPublisher
    ) {
    }

    getSessions(): Session[] {
        return Array.from(this.sessions.values())
    }

    getSessionsByNamespace(namespace: string): Session[] {
        return this.getSessions().filter((session) => session.namespace === namespace)
    }

    getSession(sessionId: string): Session | undefined {
        return this.sessions.get(sessionId)
    }

    getSessionByNamespace(sessionId: string, namespace: string): Session | undefined {
        const session = this.sessions.get(sessionId)
        if (!session || session.namespace !== namespace) {
            return undefined
        }
        return session
    }

    resolveSessionAccess(
        sessionId: string,
        namespace: string
    ): { ok: true; sessionId: string; session: Session } | { ok: false; reason: 'not-found' | 'access-denied' } {
        const session = this.sessions.get(sessionId) ?? this.refreshSession(sessionId)
        if (session) {
            if (session.namespace !== namespace) {
                return { ok: false, reason: 'access-denied' }
            }
            return { ok: true, sessionId, session }
        }

        return { ok: false, reason: 'not-found' }
    }

    getActiveSessions(): Session[] {
        return this.getSessions().filter((session) => session.active)
    }

    getOrCreateSession(tag: string, metadata: unknown, agentState: unknown, namespace: string): Session {
        const stored = this.store.sessions.getOrCreateSession(tag, metadata, agentState, namespace)
        return this.refreshSession(stored.id) ?? (() => { throw new Error('Failed to load session') })()
    }

    refreshSession(sessionId: string): Session | null {
        let stored = this.store.sessions.getSession(sessionId)
        if (!stored) {
            const existed = this.sessions.delete(sessionId)
            if (existed) {
                this.publisher.emit({ type: 'session-removed', sessionId })
            }
            return null
        }

        const existing = this.sessions.get(sessionId)

        if (stored.todos === null && !this.todoBackfillAttemptedSessionIds.has(sessionId)) {
            this.todoBackfillAttemptedSessionIds.add(sessionId)
            const messages = this.store.messages.getMessages(sessionId, 200)
            for (let i = messages.length - 1; i >= 0; i -= 1) {
                const message = messages[i]
                const todos = extractTodoWriteTodosFromMessageContent(message.content)
                if (todos) {
                    const updated = this.store.sessions.setSessionTodos(sessionId, todos, message.createdAt, stored.namespace)
                    if (updated) {
                        stored = this.store.sessions.getSession(sessionId) ?? stored
                    }
                    break
                }
            }
        }

        const metadata = (() => {
            const parsed = MetadataSchema.safeParse(stored.metadata)
            return parsed.success ? parsed.data : null
        })()

        const agentState = (() => {
            const parsed = AgentStateSchema.safeParse(stored.agentState)
            return parsed.success ? parsed.data : null
        })()

        const todos = (() => {
            if (stored.todos === null) return undefined
            const parsed = TodosSchema.safeParse(stored.todos)
            return parsed.success ? parsed.data : undefined
        })()

        const session: Session = {
            id: stored.id,
            namespace: stored.namespace,
            seq: stored.seq,
            createdAt: stored.createdAt,
            updatedAt: stored.updatedAt,
            active: existing?.active ?? stored.active,
            activeAt: existing?.activeAt ?? (stored.activeAt ?? stored.createdAt),
            metadata,
            metadataVersion: stored.metadataVersion,
            agentState,
            agentStateVersion: stored.agentStateVersion,
            thinking: existing?.thinking ?? false,
            thinkingAt: existing?.thinkingAt ?? 0,
            todos,
            permissionMode: existing?.permissionMode,
            modelMode: existing?.modelMode,
            thinkingLevel: existing?.thinkingLevel
        }

        this.sessions.set(sessionId, session)
        this.publisher.emit({ type: existing ? 'session-updated' : 'session-added', sessionId, data: session })
        return session
    }

    reloadAll(): void {
        const sessions = this.store.sessions.getSessions()
        for (const session of sessions) {
            this.refreshSession(session.id)
        }
    }

    handleSessionAlive(payload: {
        sid: string
        time: number
        thinking?: boolean
        mode?: 'local' | 'remote'
        permissionMode?: PermissionMode
        modelMode?: ModelMode
        thinkingLevel?: ThinkingLevel
    }): void {
        const t = clampAliveTime(payload.time)
        if (!t) return

        const session = this.sessions.get(payload.sid) ?? this.refreshSession(payload.sid)
        if (!session) return

        const wasActive = session.active
        const wasThinking = session.thinking
        const previousPermissionMode = session.permissionMode
        const previousModelMode = session.modelMode
        const previousThinkingLevel = session.thinkingLevel

        session.active = true
        session.activeAt = Math.max(session.activeAt, t)
        session.thinking = Boolean(payload.thinking)
        session.thinkingAt = t
        if (payload.permissionMode !== undefined) {
            session.permissionMode = payload.permissionMode
        }
        if (payload.modelMode !== undefined) {
            session.modelMode = payload.modelMode
        }
        if (payload.thinkingLevel !== undefined) {
            session.thinkingLevel = payload.thinkingLevel
        }

        const now = Date.now()
        const lastBroadcastAt = this.lastBroadcastAtBySessionId.get(session.id) ?? 0
        const modeChanged = previousPermissionMode !== session.permissionMode
            || previousModelMode !== session.modelMode
            || previousThinkingLevel !== session.thinkingLevel
        const shouldBroadcast = (!wasActive && session.active)
            || (wasThinking !== session.thinking)
            || modeChanged
            || (now - lastBroadcastAt > 10_000)

        if (shouldBroadcast) {
            this.lastBroadcastAtBySessionId.set(session.id, now)
            this.publisher.emit({
                type: 'session-updated',
                sessionId: session.id,
                data: {
                    activeAt: session.activeAt,
                    thinking: session.thinking,
                    permissionMode: session.permissionMode,
                    modelMode: session.modelMode,
                    thinkingLevel: session.thinkingLevel
                }
            })
        }
    }

    handleSessionEnd(payload: { sid: string; time: number }): void {
        const t = clampAliveTime(payload.time) ?? Date.now()

        const session = this.sessions.get(payload.sid) ?? this.refreshSession(payload.sid)
        if (!session) return

        if (!session.active && !session.thinking) {
            return
        }

        session.active = false
        session.thinking = false
        session.thinkingAt = t

        this.clearPendingRequests(session)
        this.publisher.emit({ type: 'session-updated', sessionId: session.id, data: { active: false, thinking: false } })
    }

    expireInactive(now: number = Date.now()): void {
        const sessionTimeoutMs = 30_000

        for (const session of this.sessions.values()) {
            if (!session.active) continue
            if (now - session.activeAt <= sessionTimeoutMs) continue
            session.active = false
            session.thinking = false
            this.clearPendingRequests(session)
            this.publisher.emit({ type: 'session-updated', sessionId: session.id, data: { active: false } })
        }
    }

    /**
     * Clear pending permission requests when a session goes inactive.
     * Prevents stale "Allow/Deny" buttons that can never succeed because
     * the CLI is disconnected.
     */
    private clearPendingRequests(session: Session): void {
        const requests = session.agentState?.requests
        if (!requests || Object.keys(requests).length === 0) return

        // Move pending requests to completedRequests as canceled
        const completed = { ...(session.agentState?.completedRequests ?? {}) }
        for (const [id, request] of Object.entries(requests)) {
            completed[id] = {
                ...request,
                status: 'canceled' as const,
                reason: 'Session disconnected',
                completedAt: Date.now()
            }
        }

        const newAgentState = {
            ...session.agentState,
            requests: {},
            completedRequests: completed
        }

        // Persist to database
        const result = this.store.sessions.updateSessionAgentState(
            session.id,
            newAgentState,
            session.agentStateVersion,
            session.namespace
        )

        if (result.result === 'success') {
            session.agentState = newAgentState
            session.agentStateVersion = result.version
        }
    }

    applySessionConfig(sessionId: string, config: { permissionMode?: PermissionMode; modelMode?: ModelMode; thinkingLevel?: ThinkingLevel }): void {
        const session = this.sessions.get(sessionId) ?? this.refreshSession(sessionId)
        if (!session) {
            return
        }

        if (config.permissionMode !== undefined) {
            session.permissionMode = config.permissionMode
        }
        if (config.modelMode !== undefined) {
            session.modelMode = config.modelMode
            if (session.thinkingLevel === 'max' && !isThinkingLevelAllowedForModel('max', session.modelMode)) {
                session.thinkingLevel = 'high'
            }
        }
        if (config.thinkingLevel !== undefined) {
            session.thinkingLevel = config.thinkingLevel
        }

        this.publisher.emit({ type: 'session-updated', sessionId, data: session })
    }

    async renameSession(sessionId: string, name: string): Promise<void> {
        const session = this.sessions.get(sessionId)
        if (!session) {
            throw new Error('Session not found')
        }

        const currentMetadata = session.metadata ?? { path: '', host: '' }
        const newMetadata = { ...currentMetadata, name }

        const result = this.store.sessions.updateSessionMetadata(
            sessionId,
            newMetadata,
            session.metadataVersion,
            session.namespace,
            { touchUpdatedAt: false }
        )

        if (result.result === 'error') {
            throw new Error('Failed to update session metadata')
        }

        if (result.result === 'version-mismatch') {
            throw new Error('Session was modified concurrently. Please try again.')
        }

        this.refreshSession(sessionId)
    }

    async deleteSession(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId)
        if (!session) {
            throw new Error('Session not found')
        }

        if (session.active) {
            throw new Error('Cannot delete active session')
        }

        const deleted = this.store.sessions.deleteSession(sessionId, session.namespace)
        if (!deleted) {
            throw new Error('Failed to delete session')
        }

        this.sessions.delete(sessionId)
        this.lastBroadcastAtBySessionId.delete(sessionId)
        this.todoBackfillAttemptedSessionIds.delete(sessionId)

        this.publisher.emit({ type: 'session-removed', sessionId, namespace: session.namespace })
    }

    async mergeSessions(oldSessionId: string, newSessionId: string, namespace: string): Promise<void> {
        if (oldSessionId === newSessionId) {
            return
        }

        const oldStored = this.store.sessions.getSessionByNamespace(oldSessionId, namespace)
        const newStored = this.store.sessions.getSessionByNamespace(newSessionId, namespace)
        if (!oldStored || !newStored) {
            throw new Error('Session not found for merge')
        }

        this.store.messages.mergeSessionMessages(oldSessionId, newSessionId)

        const mergedMetadata = this.mergeSessionMetadata(oldStored.metadata, newStored.metadata)
        if (mergedMetadata !== null && mergedMetadata !== newStored.metadata) {
            for (let attempt = 0; attempt < 2; attempt += 1) {
                const latest = this.store.sessions.getSessionByNamespace(newSessionId, namespace)
                if (!latest) break
                const result = this.store.sessions.updateSessionMetadata(
                    newSessionId,
                    mergedMetadata,
                    latest.metadataVersion,
                    namespace,
                    { touchUpdatedAt: false }
                )
                if (result.result === 'success') {
                    break
                }
                if (result.result === 'error') {
                    break
                }
            }
        }

        if (oldStored.todos !== null && oldStored.todosUpdatedAt !== null) {
            this.store.sessions.setSessionTodos(
                newSessionId,
                oldStored.todos,
                oldStored.todosUpdatedAt,
                namespace
            )
        }

        const deleted = this.store.sessions.deleteSession(oldSessionId, namespace)
        if (!deleted) {
            throw new Error('Failed to delete old session during merge')
        }

        const existed = this.sessions.delete(oldSessionId)
        if (existed) {
            this.publisher.emit({ type: 'session-removed', sessionId: oldSessionId, namespace })
        }
        this.lastBroadcastAtBySessionId.delete(oldSessionId)
        this.todoBackfillAttemptedSessionIds.delete(oldSessionId)

        this.refreshSession(newSessionId)
    }

    /**
     * Clear the Claude session ID from metadata to force a fresh SDK session on next message.
     * Used by /rewind to ensure the conversation restarts from the checkpoint.
     *
     * NOTE: This only rewinds the conversation (messages in HAPI's database).
     * It does NOT rewind code changes - Claude Code's git-based checkpointing
     * is an interactive CLI feature not exposed through the SDK.
     * Users should use git directly to revert code changes if needed.
     */
    async clearClaudeSessionId(sessionId: string): Promise<void> {
        const session = this.sessions.get(sessionId)
        if (!session) {
            return
        }

        const currentMetadata = session.metadata
        if (!currentMetadata) {
            return
        }

        // Clear the session ID for whichever agent flavor is being used
        const newMetadata = { ...currentMetadata }
        delete (newMetadata as Record<string, unknown>).claudeSessionId
        delete (newMetadata as Record<string, unknown>).codexSessionId
        delete (newMetadata as Record<string, unknown>).geminiSessionId
        delete (newMetadata as Record<string, unknown>).opencodeSessionId

        const result = this.store.sessions.updateSessionMetadata(
            sessionId,
            newMetadata,
            session.metadataVersion,
            session.namespace,
            { touchUpdatedAt: true }
        )

        if (result.result === 'success') {
            this.refreshSession(sessionId)
        }
    }

    /**
     * Set the rewind context summary in session metadata.
     * Used when rewinding past a compaction boundary to restore historical context.
     * The CLI will read this and inject it into the system prompt when resuming.
     */
    async setRewindContextSummary(sessionId: string, contextSummary: string | undefined): Promise<void> {
        const session = this.sessions.get(sessionId)
        if (!session) {
            return
        }

        const currentMetadata = session.metadata
        if (!currentMetadata) {
            return
        }

        const newMetadata = { ...currentMetadata } as Record<string, unknown>
        if (contextSummary) {
            newMetadata.rewindContextSummary = contextSummary
        } else {
            delete newMetadata.rewindContextSummary
        }

        const result = this.store.sessions.updateSessionMetadata(
            sessionId,
            newMetadata,
            session.metadataVersion,
            session.namespace,
            { touchUpdatedAt: true }
        )

        if (result.result === 'success') {
            this.refreshSession(sessionId)
        }
    }

    private mergeSessionMetadata(oldMetadata: unknown | null, newMetadata: unknown | null): unknown | null {
        if (!oldMetadata || typeof oldMetadata !== 'object') {
            return newMetadata
        }
        if (!newMetadata || typeof newMetadata !== 'object') {
            return oldMetadata
        }

        const oldObj = oldMetadata as Record<string, unknown>
        const newObj = newMetadata as Record<string, unknown>
        const merged: Record<string, unknown> = { ...newObj }
        let changed = false

        if (typeof oldObj.name === 'string' && typeof newObj.name !== 'string') {
            merged.name = oldObj.name
            changed = true
        }

        const oldSummary = oldObj.summary as { text?: unknown; updatedAt?: unknown } | undefined
        const newSummary = newObj.summary as { text?: unknown; updatedAt?: unknown } | undefined
        const oldUpdatedAt = typeof oldSummary?.updatedAt === 'number' ? oldSummary.updatedAt : null
        const newUpdatedAt = typeof newSummary?.updatedAt === 'number' ? newSummary.updatedAt : null
        if (oldUpdatedAt !== null && (newUpdatedAt === null || oldUpdatedAt > newUpdatedAt)) {
            merged.summary = oldSummary
            changed = true
        }

        if (oldObj.worktree && !newObj.worktree) {
            merged.worktree = oldObj.worktree
            changed = true
        }

        if (typeof oldObj.path === 'string' && typeof newObj.path !== 'string') {
            merged.path = oldObj.path
            changed = true
        }
        if (typeof oldObj.host === 'string' && typeof newObj.host !== 'string') {
            merged.host = oldObj.host
            changed = true
        }

        return changed ? merged : newMetadata
    }
}
