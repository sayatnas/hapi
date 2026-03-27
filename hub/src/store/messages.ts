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

        // Check for compaction boundary messages (wrapped SDK format)
        if (msgContent.role === 'agent' && msgContent.content && typeof msgContent.content === 'object') {
            const wrapper = msgContent.content as Record<string, unknown>
            if (wrapper.type === 'output' && wrapper.data && typeof wrapper.data === 'object') {
                const data = wrapper.data as Record<string, unknown>

                // Detect Claude Code native compaction boundaries
                // These are system messages with subtype 'compact_boundary' or 'microcompact_boundary'
                if (data.type === 'system' && (data.subtype === 'compact_boundary' || data.subtype === 'microcompact_boundary')) {
                    boundaries.push(row.seq)
                    continue
                }

                // Detect HAPI context recovery messages ("This session is being continued...")
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

/**
 * Build the full conversation history for context injection.
 * Unlike buildConversationSummary which truncates, this preserves full messages
 * so Claude has complete context when resuming after a session reset.
 *
 * @param upToSeq - Optional: only include messages up to this sequence number (for rewind)
 * @returns A formatted string suitable for injection into the system prompt.
 */
/**
 * Truncate a string to maxLen, appending a suffix if truncated.
 */
function truncStr(s: string, maxLen: number): string {
    if (s.length <= maxLen) return s
    return s.slice(0, maxLen) + '…[truncated]'
}

/**
 * Format a tool call input for context recovery.
 * Extracts the most important fields for each known tool type.
 */
function formatToolInput(toolName: string, input: unknown): string {
    if (!input || typeof input !== 'object') return ''
    const obj = input as Record<string, unknown>

    // File-based tools: show the path and key content
    if (toolName === 'Read' || toolName === 'Glob' || toolName === 'Grep') {
        const path = obj.file_path ?? obj.path ?? obj.pattern ?? ''
        const extra = obj.pattern ? ` pattern="${obj.pattern}"` : ''
        return `${path}${extra}`
    }
    if (toolName === 'Edit') {
        const path = obj.file_path ?? ''
        const old_s = typeof obj.old_string === 'string' ? truncStr(obj.old_string, 50000) : ''
        const new_s = typeof obj.new_string === 'string' ? truncStr(obj.new_string, 50000) : ''
        return `${path}\n  old: ${old_s}\n  new: ${new_s}`
    }
    if (toolName === 'Write') {
        const path = obj.file_path ?? ''
        const content = typeof obj.content === 'string' ? truncStr(obj.content, 50000) : ''
        return `${path}\n${content}`
    }
    if (toolName === 'Bash') {
        const cmd = typeof obj.command === 'string' ? truncStr(obj.command, 50000) : ''
        return cmd
    }
    if (toolName === 'Agent' || toolName === 'Task') {
        const prompt = typeof obj.prompt === 'string' ? truncStr(obj.prompt, 50000) : ''
        return prompt
    }

    // Generic: JSON-stringify with generous limit (context goes via stdin, no ARG_MAX)
    try {
        return truncStr(JSON.stringify(input), 50000)
    } catch {
        return '[complex input]'
    }
}

/**
 * Format a tool result for context recovery.
 */
function formatToolResult(result: unknown): string {
    if (result === undefined || result === null) return ''
    if (typeof result === 'string') return truncStr(result, 100000)
    if (Array.isArray(result)) {
        // Tool results array from Claude API
        const texts: string[] = []
        for (const item of result) {
            if (item && typeof item === 'object') {
                const r = item as Record<string, unknown>
                if (r.type === 'text' && typeof r.text === 'string') {
                    texts.push(truncStr(r.text, 100000))
                }
            }
        }
        return texts.join('\n')
    }
    try {
        return truncStr(JSON.stringify(result), 100000)
    } catch {
        return '[complex result]'
    }
}

export function buildFullConversationHistory(
    db: Database,
    sessionId: string,
    upToSeq?: number
): string {
    // Only recover messages AFTER the last compaction boundary.
    // Everything before that is already summarized in the compaction message itself.
    // This prevents recovering the entire pre-compaction history (which can be millions of chars).
    const boundaries = findCompactionBoundaries(db, sessionId)
    const lastBoundary = boundaries.length > 0 ? boundaries[boundaries.length - 1] : null

    let query: string
    let rows: DbMessageRow[]

    if (lastBoundary !== null) {
        // Start from the compaction boundary message (inclusive — it contains the summary)
        query = upToSeq !== undefined
            ? 'SELECT seq, content FROM messages WHERE session_id = ? AND seq >= ? AND seq <= ? ORDER BY seq ASC'
            : 'SELECT seq, content FROM messages WHERE session_id = ? AND seq >= ? ORDER BY seq ASC'
        rows = upToSeq !== undefined
            ? db.prepare(query).all(sessionId, lastBoundary, upToSeq) as DbMessageRow[]
            : db.prepare(query).all(sessionId, lastBoundary) as DbMessageRow[]
        console.log(`[buildFullConversationHistory] Session ${sessionId}: found ${rows.length} messages after compaction boundary seq=${lastBoundary} (skipped ${lastBoundary} pre-compaction messages)`)
    } else {
        query = upToSeq !== undefined
            ? 'SELECT seq, content FROM messages WHERE session_id = ? AND seq <= ? ORDER BY seq ASC'
            : 'SELECT seq, content FROM messages WHERE session_id = ? ORDER BY seq ASC'
        rows = upToSeq !== undefined
            ? db.prepare(query).all(sessionId, upToSeq) as DbMessageRow[]
            : db.prepare(query).all(sessionId) as DbMessageRow[]
        console.log(`[buildFullConversationHistory] Session ${sessionId}: found ${rows.length} messages (no compaction boundaries found)`)
    }

    const entries: Array<{ role: 'user' | 'assistant' | 'tool'; text: string }> = []

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
                    entries.push({ role: 'user', text })
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
                // Skip rate limit events and other internal events
                if (data.type === 'rate_limit_event') continue

                // User messages (including tool results)
                if (data.type === 'user' && data.message && typeof data.message === 'object') {
                    const message = data.message as Record<string, unknown>
                    if (message.role !== 'user') continue

                    if (typeof message.content === 'string') {
                        const text = message.content.trim()
                        if (text.length > 0 && !text.startsWith('<local-command-caveat>') && !text.startsWith('This session is being continued')) {
                            entries.push({ role: 'user', text })
                        }
                    } else if (Array.isArray(message.content)) {
                        for (const item of message.content) {
                            if (!item || typeof item !== 'object') continue
                            const ci = item as Record<string, unknown>

                            if (ci.type === 'text' && typeof ci.text === 'string') {
                                const text = ci.text.trim()
                                if (text.length > 0 && !text.startsWith('<local-command-caveat>') && !text.startsWith('This session is being continued')) {
                                    entries.push({ role: 'user', text })
                                }
                            }

                            // Skip tool results — including them teaches Claude to output
                            // tool calls as text instead of using the tool_use API
                        }
                    }
                }

                // Assistant messages — include BOTH text AND tool calls
                if (data.type === 'assistant' && data.message && typeof data.message === 'object') {
                    const message = data.message as Record<string, unknown>
                    if (message.role !== 'assistant') continue

                    if (Array.isArray(message.content)) {
                        for (const item of message.content) {
                            if (!item || typeof item !== 'object') continue
                            const ci = item as Record<string, unknown>

                            // Text content
                            if (ci.type === 'text' && typeof ci.text === 'string') {
                                const text = ci.text.trim()
                                if (text.length > 0) {
                                    entries.push({ role: 'assistant', text })
                                }
                            }

                            // Skip tool_use blocks — including them in text form teaches
                            // Claude to output tool calls as text instead of using tool_use API.
                            // Only include a brief note that a tool was used.
                            if (ci.type === 'tool_use' && typeof ci.name === 'string') {
                                entries.push({
                                    role: 'assistant',
                                    text: `(used ${ci.name} tool)`
                                })
                            }
                        }
                    }
                }

                // Skip result messages — they contain tool call summaries in text form
                // that teach Claude to mimic the format instead of using tool_use API
            }
        }
    }

    console.log(`[buildFullConversationHistory] Extracted ${entries.length} conversation entries (with tool context)`)

    if (entries.length === 0) {
        return ''
    }

    const lines: string[] = [
        '## Previous Conversation History',
        '',
        'This session was interrupted and is being continued. Below is the complete conversation history from before the interruption, including tool calls and their results. Use this context to continue helping the user seamlessly:',
        ''
    ]

    for (const entry of entries) {
        if (entry.role === 'user') {
            lines.push(`**User:**`)
            lines.push(entry.text)
            lines.push('')
        } else if (entry.role === 'assistant') {
            lines.push(`**Assistant:**`)
            lines.push(entry.text)
            lines.push('')
        } else if (entry.role === 'tool') {
            lines.push(entry.text)
            lines.push('')
        }
    }

    lines.push('---')
    lines.push('Continue the conversation from where it left off.')
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
