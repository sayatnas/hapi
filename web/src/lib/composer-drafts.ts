const STORAGE_KEY = 'hapi:composer-drafts'

const drafts = new Map<string, string>()
let hydrated = false

function getStorage(): Storage | null {
    if (typeof window === 'undefined') return null
    try {
        return window.sessionStorage
    } catch {
        return null
    }
}

function hydrate(): void {
    if (hydrated) return
    hydrated = true

    const storage = getStorage()
    if (!storage) return

    try {
        const stored = storage.getItem(STORAGE_KEY)
        if (!stored) return

        const parsed = JSON.parse(stored) as unknown
        if (!parsed || typeof parsed !== 'object') return

        for (const [key, value] of Object.entries(parsed)) {
            if (typeof value !== 'string') continue
            if (value.length === 0) continue
            drafts.set(key, value)
        }
    } catch {
        // Ignore invalid storage payloads.
    }
}

function persist(): void {
    const storage = getStorage()
    if (!storage) return

    try {
        const serialized = Object.fromEntries(drafts.entries())
        storage.setItem(STORAGE_KEY, JSON.stringify(serialized))
    } catch {
        // Ignore storage errors.
    }
}

export function getDraft(sessionId: string): string {
    hydrate()
    return drafts.get(sessionId) ?? ''
}

export function saveDraft(sessionId: string, text: string): void {
    hydrate()
    if (text.trim().length === 0) {
        drafts.delete(sessionId)
    } else {
        drafts.set(sessionId, text)
    }
    persist()
}

export function clearDraft(sessionId: string): void {
    hydrate()
    drafts.delete(sessionId)
    persist()
}
