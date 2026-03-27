import type { ModelMode } from '@/types/api'

/**
 * Context windows vary by model/provider and may change over time.
 *
 * The UI only needs this to compute a conservative "context remaining" warning.
 * We intentionally keep a headroom budget to avoid false confidence near the limit
 * (system prompts, tool overhead, and other hidden tokens can consume extra space).
 *
 * If/when the server provides an explicit per-session context limit, prefer that
 * and use this only as a fallback.
 */
const CONTEXT_HEADROOM_TOKENS = 10_000

const MODEL_CONTEXT_WINDOWS: Record<ModelMode, number> = {
    default: 1_000_000, // Opus 4.6 (1M context) — Auto defaults to opus[1m]
    sonnet: 200_000,    // Sonnet 4.6
    opus: 1_000_000     // Opus 4.6 (1M context)
}

export function getContextBudgetTokens(modelMode: ModelMode | undefined): number | null {
    const mode: ModelMode = modelMode ?? 'default'
    const windowTokens = MODEL_CONTEXT_WINDOWS[mode]
    if (!windowTokens) return null
    return Math.max(1, windowTokens - CONTEXT_HEADROOM_TOKENS)
}
