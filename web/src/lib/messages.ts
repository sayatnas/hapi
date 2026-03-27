import type { InfiniteData } from '@tanstack/react-query'
import type { DecryptedMessage, MessagesResponse } from '@/types/api'

export function makeClientSideId(prefix: string): string {
    if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
        return `${prefix}-${crypto.randomUUID()}`
    }
    return `${prefix}-${Date.now()}-${Math.random()}`
}

function isUserMessage(msg: DecryptedMessage): boolean {
    const content = msg.content
    if (content && typeof content === 'object' && 'role' in content) {
        return (content as { role: string }).role === 'user'
    }
    return false
}

function isOptimisticMessage(msg: DecryptedMessage): boolean {
    return Boolean(msg.localId && msg.id === msg.localId)
}

/**
 * Extract the embedded timestamp from message content.
 * CLI messages embed their creation timestamp in the message content.
 * This is the actual time the message was created, unlike createdAt which
 * is set when the message is stored in the hub database.
 *
 * Timestamp locations by content type:
 * - output: { role: 'agent', content: { type: 'output', data: { timestamp: '...' } } }
 * - codex:  { role: 'agent', content: { type: 'codex', timestamp: '...' } }
 * - event:  { role: 'agent', content: { type: 'event', timestamp: '...' } }
 */
function getEmbeddedTimestamp(msg: DecryptedMessage): number | null {
    const content = msg.content
    if (!content || typeof content !== 'object') {
        return null
    }

    const record = content as Record<string, unknown>

    // Structure: { role: 'agent'|'user', content: { type: '...', ... } }
    const innerContent = record.content
    if (!innerContent || typeof innerContent !== 'object') {
        return null
    }

    const inner = innerContent as Record<string, unknown>
    const contentType = inner.type

    let timestamp: unknown = null

    if (contentType === 'output') {
        // Output messages: timestamp is in data.timestamp
        const data = inner.data
        if (data && typeof data === 'object') {
            timestamp = (data as Record<string, unknown>).timestamp
        }
    } else if (contentType === 'codex' || contentType === 'event') {
        // Codex and event messages: timestamp is directly on inner content
        timestamp = inner.timestamp
    }

    if (typeof timestamp !== 'string') {
        return null
    }

    const parsed = Date.parse(timestamp)
    if (Number.isNaN(parsed)) {
        return null
    }

    return parsed
}

function compareMessages(a: DecryptedMessage, b: DecryptedMessage): number {
    // Primary sort: use embedded timestamp when available, fall back to createdAt.
    // This ensures messages with embedded timestamps (CLI/agent messages) and those
    // without (web UI user messages) are compared on the same timescale.
    const aTime = getEmbeddedTimestamp(a) ?? a.createdAt
    const bTime = getEmbeddedTimestamp(b) ?? b.createdAt
    if (aTime !== bTime) {
        return aTime - bTime
    }

    // Tiebreaker: by seq (storage order)
    const aSeq = typeof a.seq === 'number' ? a.seq : null
    const bSeq = typeof b.seq === 'number' ? b.seq : null
    if (aSeq !== null && bSeq !== null && aSeq !== bSeq) {
        return aSeq - bSeq
    }

    // Final tiebreaker: by id
    return a.id.localeCompare(b.id)
}

export function mergeMessages(existing: DecryptedMessage[], incoming: DecryptedMessage[]): DecryptedMessage[] {
    if (existing.length === 0) {
        return [...incoming].sort(compareMessages)
    }
    if (incoming.length === 0) {
        return [...existing].sort(compareMessages)
    }

    const byId = new Map<string, DecryptedMessage>()
    for (const msg of existing) {
        byId.set(msg.id, msg)
    }
    for (const msg of incoming) {
        byId.set(msg.id, msg)
    }

    let merged = Array.from(byId.values())

    const incomingStoredLocalIds = new Set<string>()
    for (const msg of incoming) {
        if (msg.localId && !isOptimisticMessage(msg)) {
            incomingStoredLocalIds.add(msg.localId)
        }
    }

    // If we received stored messages with a localId, drop any optimistic bubbles with the same localId.
    if (incomingStoredLocalIds.size > 0) {
        merged = merged.filter((msg) => {
            if (!msg.localId || !incomingStoredLocalIds.has(msg.localId)) {
                return true
            }
            return !isOptimisticMessage(msg)
        })
    }

    // Fallback: if an optimistic message was marked as sent but we didn't get a localId echo,
    // drop it when a server user message appears close in time.
    const optimisticMessages = merged.filter((m) => isOptimisticMessage(m))
    const nonOptimisticMessages = merged.filter((m) => !isOptimisticMessage(m))
    const result: DecryptedMessage[] = [...nonOptimisticMessages]

    for (const optimistic of optimisticMessages) {
        if (optimistic.status === 'sent') {
            const hasServerUserMessage = nonOptimisticMessages.some((m) =>
                isUserMessage(m) &&
                Math.abs(m.createdAt - optimistic.createdAt) < 10_000
            )
            if (hasServerUserMessage) {
                continue
            }
        }
        result.push(optimistic)
    }

    result.sort(compareMessages)
    return result
}

export function upsertMessagesInCache(
    data: InfiniteData<MessagesResponse> | undefined,
    incoming: DecryptedMessage[],
): InfiniteData<MessagesResponse> {
    const mergedIncoming = mergeMessages([], incoming)

    if (!data || data.pages.length === 0) {
        return {
            pages: [
                {
                    messages: mergedIncoming,
                    page: {
                        limit: 50,
                        beforeSeq: null,
                        nextBeforeSeq: null,
                        hasMore: false,
                    },
                },
            ],
            pageParams: [null],
        }
    }

    const pages = data.pages.slice()
    const first = pages[0]
    pages[0] = {
        ...first,
        messages: mergeMessages(first.messages, mergedIncoming),
    }

    return {
        ...data,
        pages,
    }
}
