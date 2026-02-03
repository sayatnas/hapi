import type { Database } from 'bun:sqlite'
import { randomUUID } from 'node:crypto'

import type { StoredMessage } from './types'
import { safeJsonParse } from './json'

type DbMessageRow = {
    id: string
    session_id: string
    content: string
    created_at: number
    seq: number
    local_id: string | null
}

function toStoredMessage(row: DbMessageRow): StoredMessage {
    return {
        id: row.id,
        sessionId: row.session_id,
        content: safeJsonParse(row.content),
        createdAt: row.created_at,
        seq: row.seq,
        localId: row.local_id
    }
}

export function addMessage(
    db: Database,
    sessionId: string,
    content: unknown,
    localId?: string
): StoredMessage {
    const now = Date.now()

    if (localId) {
        const existing = db.prepare(
            'SELECT * FROM messages WHERE session_id = ? AND local_id = ? LIMIT 1'
        ).get(sessionId, localId) as DbMessageRow | undefined
        if (existing) {
            return toStoredMessage(existing)
        }
    }

    const msgSeqRow = db.prepare(
        'SELECT COALESCE(MAX(seq), 0) + 1 AS nextSeq FROM messages WHERE session_id = ?'
    ).get(sessionId) as { nextSeq: number }
    const msgSeq = msgSeqRow.nextSeq

    const id = randomUUID()
    const json = JSON.stringify(content)

    db.prepare(`
        INSERT INTO messages (
            id, session_id, content, created_at, seq, local_id
        ) VALUES (
            @id, @session_id, @content, @created_at, @seq, @local_id
        )
    `).run({
        id,
        session_id: sessionId,
        content: json,
        created_at: now,
        seq: msgSeq,
        local_id: localId ?? null
    })

    const row = db.prepare('SELECT * FROM messages WHERE id = ?').get(id) as DbMessageRow | undefined
    if (!row) {
        throw new Error('Failed to create message')
    }
    return toStoredMessage(row)
}

export function getMessages(
    db: Database,
    sessionId: string,
    limit: number = 200,
    beforeSeq?: number
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200

    const rows = (beforeSeq !== undefined && beforeSeq !== null && Number.isFinite(beforeSeq))
        ? db.prepare(
            'SELECT * FROM messages WHERE session_id = ? AND seq < ? ORDER BY seq DESC LIMIT ?'
        ).all(sessionId, beforeSeq, safeLimit) as DbMessageRow[]
        : db.prepare(
            'SELECT * FROM messages WHERE session_id = ? ORDER BY seq DESC LIMIT ?'
        ).all(sessionId, safeLimit) as DbMessageRow[]

    return rows.reverse().map(toStoredMessage)
}

export function getMessagesAfter(
    db: Database,
    sessionId: string,
    afterSeq: number,
    limit: number = 200
): StoredMessage[] {
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(200, limit)) : 200
    const safeAfterSeq = Number.isFinite(afterSeq) ? afterSeq : 0

    const rows = db.prepare(
        'SELECT * FROM messages WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?'
    ).all(sessionId, safeAfterSeq, safeLimit) as DbMessageRow[]

    return rows.map(toStoredMessage)
}

export function getMaxSeq(db: Database, sessionId: string): number {
    const row = db.prepare(
        'SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM messages WHERE session_id = ?'
    ).get(sessionId) as { maxSeq: number } | undefined
    return row?.maxSeq ?? 0
}

/**
 * Delete all messages after a specific sequence number.
 * Used by /rewind to truncate conversation history.
 * @returns The number of messages deleted
 */
export function deleteMessagesAfter(
    db: Database,
    sessionId: string,
    afterSeq: number
): number {
    const safeAfterSeq = Number.isFinite(afterSeq) ? afterSeq : 0
    const result = db.prepare(
        'DELETE FROM messages WHERE session_id = ? AND seq > ?'
    ).run(sessionId, safeAfterSeq)
    return result.changes
}

/**
 * Get user messages as checkpoints for the rewind feature.
 * Returns messages where the content contains a user-initiated message (not tool results).
 *
 * There are TWO message formats in HAPI:
 *
 * 1. Direct user message (from web UI):
 * {
 *   "role": "user",
 *   "content": { "type": "text", "text": "user input" },
 *   "meta": { "sentFrom": "webapp" }
 * }
 *
 * 2. Wrapped SDK message (from CLI):
 * {
 *   "role": "agent",
 *   "content": {
 *     "type": "output",
 *     "data": {
 *       "type": "user",
 *       "message": {
 *         "role": "user",
 *         "content": string | array
 *       }
 *     }
 *   }
 * }
 */
export function getCheckpoints(
    db: Database,
    sessionId: string
): Array<{ seq: number; createdAt: number; preview: string }> {
    const rows = db.prepare(
        'SELECT seq, created_at, content FROM messages WHERE session_id = ? ORDER BY seq ASC'
    ).all(sessionId) as DbMessageRow[]

    const checkpoints: Array<{ seq: number; createdAt: number; preview: string }> = []

    for (const row of rows) {
        const content = safeJsonParse(row.content)
        if (!content || typeof content !== 'object') continue

        const msgContent = content as Record<string, unknown>

        // Format 1: Direct user message from web UI
        // { role: "user", content: { type: "text", text: "..." }, meta: { sentFrom: "webapp" } }
        if (msgContent.role === 'user' && msgContent.content && typeof msgContent.content === 'object') {
            const contentObj = msgContent.content as Record<string, unknown>
            if (contentObj.type === 'text' && typeof contentObj.text === 'string') {
                const text = contentObj.text
                if (text.trim().length > 0) {
                    checkpoints.push({
                        seq: row.seq,
                        createdAt: row.created_at,
                        preview: text.slice(0, 100) + (text.length > 100 ? '...' : '')
                    })
                }
            }
            continue
        }

        // Format 2: Wrapped SDK message format
        // { role: "agent", content: { type: "output", data: { type: "user", message: {...} } } }
        if (msgContent.role === 'agent' && msgContent.content && typeof msgContent.content === 'object') {
            const wrapper = msgContent.content as Record<string, unknown>
            if (wrapper.type === 'output' && wrapper.data && typeof wrapper.data === 'object') {
                const data = wrapper.data as Record<string, unknown>

                // Skip sidechain messages (agent tasks, not user input)
                if (data.isSidechain === true) continue

                // Only include user-initiated messages, not tool results
                if (data.type === 'user' && data.message && typeof data.message === 'object') {
                    const message = data.message as Record<string, unknown>

                    if (message.role !== 'user') continue

                    let text: string | null = null

                    // Case 1: message.content is a string
                    if (typeof message.content === 'string') {
                        text = message.content
                    }
                    // Case 2: message.content is an array
                    else if (Array.isArray(message.content)) {
                        // Check if this is just tool_result(s) - skip those
                        const hasOnlyToolResults = message.content.every(
                            (item: unknown) =>
                                item && typeof item === 'object' &&
                                ((item as Record<string, unknown>).type === 'tool_result' ||
                                 (item as Record<string, unknown>).tool_use_id)
                        )
                        if (hasOnlyToolResults) continue

                        // Find the first text content
                        const textContent = message.content.find(
                            (item: unknown) =>
                                item && typeof item === 'object' &&
                                (item as Record<string, unknown>).type === 'text'
                        ) as Record<string, unknown> | undefined

                        if (textContent && typeof textContent.text === 'string') {
                            text = textContent.text
                        }
                    }

                    // Add checkpoint if we found user text
                    if (text && text.trim().length > 0) {
                        // Skip system messages and context continuations
                        if (text.startsWith('<local-command-caveat>')) continue
                        if (text.startsWith('This session is being continued')) continue
                        // Skip automated agent prompts (planning mode, explore tasks, etc.)
                        if (text.startsWith('Explore ')) continue
                        if (text.startsWith('Based on ')) continue
                        if (text.startsWith('Investigate ')) continue
                        if (text.startsWith('Search ')) continue
                        if (text.startsWith('Design ')) continue

                        checkpoints.push({
                            seq: row.seq,
                            createdAt: row.created_at,
                            preview: text.slice(0, 100) + (text.length > 100 ? '...' : '')
                        })
                    }
                }
            }
        }
    }

    return checkpoints
}

/**
 * Find compaction message sequence numbers in the session.
 * Compaction messages are identified by the text "This session is being continued"
 * which indicates where context was summarized.
 *
 * Returns array of seq numbers where compaction occurred.
 */
export function findCompactionBoundaries(
    db: Database,
    sessionId: string
): number[] {
    const rows = db.prepare(
        'SELECT seq, content FROM messages WHERE session_id = ? ORDER BY seq ASC'
    ).all(sessionId) as DbMessageRow[]

    const boundaries: number[] = []

    for (const row of rows) {
        const content = safeJsonParse(row.content)
        if (!content || typeof content !== 'object') continue

        const msgContent = content as Record<string, unknown>

        // Check for compaction summary message (wrapped SDK format)
        if (msgContent.role === 'agent' && msgContent.content && typeof msgContent.content === 'object') {
            const wrapper = msgContent.content as Record<string, unknown>
            if (wrapper.type === 'output' && wrapper.data && typeof wrapper.data === 'object') {
                const data = wrapper.data as Record<string, unknown>

                if (data.type === 'user' && data.message && typeof data.message === 'object') {
                    const message = data.message as Record<string, unknown>

                    let text: string | null = null
                    if (typeof message.content === 'string') {
                        text = message.content
                    } else if (Array.isArray(message.content)) {
                        const textContent = message.content.find(
                            (item: unknown) =>
                                item && typeof item === 'object' &&
                                (item as Record<string, unknown>).type === 'text'
                        ) as Record<string, unknown> | undefined

                        if (textContent && typeof textContent.text === 'string') {
                            text = textContent.text
                        }
                    }

                    if (text && text.startsWith('This session is being continued')) {
                        boundaries.push(row.seq)
                    }
                }
            }
        }
    }

    return boundaries
}

/**
 * Build a conversation summary from messages for context injection.
 * This is used when rewinding past a compaction boundary to restore
 * the historical context that was lost during compaction.
 *
 * Returns a formatted string suitable for injection into a system prompt.
 */
export function buildConversationSummary(
    db: Database,
    sessionId: string,
    upToSeq: number
): string {
    const rows = db.prepare(
        'SELECT seq, content FROM messages WHERE session_id = ? AND seq <= ? ORDER BY seq ASC'
    ).all(sessionId, upToSeq) as DbMessageRow[]

    const conversations: Array<{ role: 'user' | 'assistant'; text: string }> = []

    for (const row of rows) {
        const content = safeJsonParse(row.content)
        if (!content || typeof content !== 'object') continue

        const msgContent = content as Record<string, unknown>

        // Format 1: Direct web UI message
        if (msgContent.role === 'user' && msgContent.content && typeof msgContent.content === 'object') {
            const contentObj = msgContent.content as Record<string, unknown>
            if (contentObj.type === 'text' && typeof contentObj.text === 'string') {
                const text = contentObj.text.trim()
                if (text.length > 0) {
                    conversations.push({ role: 'user', text })
                }
            }
            continue
        }

        // Format 2: Wrapped SDK messages
        if (msgContent.role === 'agent' && msgContent.content && typeof msgContent.content === 'object') {
            const wrapper = msgContent.content as Record<string, unknown>
            if (wrapper.type === 'output' && wrapper.data && typeof wrapper.data === 'object') {
                const data = wrapper.data as Record<string, unknown>

                // Skip sidechain messages
                if (data.isSidechain === true) continue

                // User messages
                if (data.type === 'user' && data.message && typeof data.message === 'object') {
                    const message = data.message as Record<string, unknown>
                    if (message.role !== 'user') continue

                    let text: string | null = null
                    if (typeof message.content === 'string') {
                        text = message.content
                    } else if (Array.isArray(message.content)) {
                        // Skip if only tool results
                        const hasOnlyToolResults = message.content.every(
                            (item: unknown) =>
                                item && typeof item === 'object' &&
                                ((item as Record<string, unknown>).type === 'tool_result' ||
                                 (item as Record<string, unknown>).tool_use_id)
                        )
                        if (hasOnlyToolResults) continue

                        const textContent = message.content.find(
                            (item: unknown) =>
                                item && typeof item === 'object' &&
                                (item as Record<string, unknown>).type === 'text'
                        ) as Record<string, unknown> | undefined

                        if (textContent && typeof textContent.text === 'string') {
                            text = textContent.text
                        }
                    }

                    if (text && text.trim().length > 0) {
                        // Skip system/automated messages
                        if (text.startsWith('<local-command-caveat>')) continue
                        if (text.startsWith('This session is being continued')) continue
                        if (text.startsWith('Explore ')) continue
                        if (text.startsWith('Based on ')) continue
                        if (text.startsWith('Investigate ')) continue
                        if (text.startsWith('Search ')) continue
                        if (text.startsWith('Design ')) continue

                        conversations.push({ role: 'user', text: text.trim() })
                    }
                }

                // Assistant messages (text only, skip tool calls)
                if (data.type === 'assistant' && data.message && typeof data.message === 'object') {
                    const message = data.message as Record<string, unknown>
                    if (message.role !== 'assistant') continue

                    if (Array.isArray(message.content)) {
                        for (const item of message.content) {
                            if (item && typeof item === 'object') {
                                const contentItem = item as Record<string, unknown>
                                if (contentItem.type === 'text' && typeof contentItem.text === 'string') {
                                    const text = contentItem.text.trim()
                                    if (text.length > 0) {
                                        conversations.push({ role: 'assistant', text })
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    // Build formatted summary
    if (conversations.length === 0) {
        return ''
    }

    const lines: string[] = [
        '## Previous Conversation Context',
        '',
        'The following is a summary of the conversation history before this point:',
        ''
    ]

    for (const conv of conversations) {
        const roleLabel = conv.role === 'user' ? 'User' : 'Assistant'
        // Truncate long messages to keep context manageable
        const truncatedText = conv.text.length > 500
            ? conv.text.slice(0, 500) + '...'
            : conv.text
        lines.push(`**${roleLabel}:** ${truncatedText}`)
        lines.push('')
    }

    lines.push('---')
    lines.push('')

    return lines.join('\n')
}

export function mergeSessionMessages(
    db: Database,
    fromSessionId: string,
    toSessionId: string
): { moved: number; oldMaxSeq: number; newMaxSeq: number } {
    if (fromSessionId === toSessionId) {
        return { moved: 0, oldMaxSeq: 0, newMaxSeq: 0 }
    }

    const oldMaxSeq = getMaxSeq(db, fromSessionId)
    const newMaxSeq = getMaxSeq(db, toSessionId)

    try {
        db.exec('BEGIN')

        if (newMaxSeq > 0 && oldMaxSeq > 0) {
            db.prepare(
                'UPDATE messages SET seq = seq + ? WHERE session_id = ?'
            ).run(oldMaxSeq, toSessionId)
        }

        const collisions = db.prepare(`
            SELECT local_id FROM messages
            WHERE session_id = ? AND local_id IS NOT NULL
            INTERSECT
            SELECT local_id FROM messages
            WHERE session_id = ? AND local_id IS NOT NULL
        `).all(toSessionId, fromSessionId) as Array<{ local_id: string }>

        if (collisions.length > 0) {
            const localIds = collisions.map((row) => row.local_id)
            const placeholders = localIds.map(() => '?').join(', ')
            db.prepare(
                `UPDATE messages SET local_id = NULL WHERE session_id = ? AND local_id IN (${placeholders})`
            ).run(fromSessionId, ...localIds)
        }

        const result = db.prepare(
            'UPDATE messages SET session_id = ? WHERE session_id = ?'
        ).run(toSessionId, fromSessionId)

        db.exec('COMMIT')
        return { moved: result.changes, oldMaxSeq, newMaxSeq }
    } catch (error) {
        db.exec('ROLLBACK')
        throw error
    }
}
