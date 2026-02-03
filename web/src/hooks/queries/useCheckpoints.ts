import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import { queryKeys } from '@/lib/query-keys'

export interface Checkpoint {
    seq: number
    createdAt: number
    preview: string
}

/**
 * Hook to fetch checkpoints (user messages) for the rewind feature.
 *
 * NOTE: This only supports conversation rewind, not code rewind.
 * Claude Code's git-based checkpointing is an interactive CLI feature
 * not exposed through the SDK. Use git directly to revert code changes.
 */
export function useCheckpoints(
    api: ApiClient | null,
    sessionId: string | null,
    enabled: boolean = true
) {
    return useQuery({
        queryKey: queryKeys.checkpoints(sessionId ?? 'unknown'),
        queryFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            const result = await api.getCheckpoints(sessionId)
            if (!result.success) {
                throw new Error(result.error ?? 'Failed to fetch checkpoints')
            }
            return result.checkpoints ?? []
        },
        enabled: Boolean(api && sessionId && enabled),
        staleTime: 0, // Always refetch when needed
        gcTime: 30 * 1000, // Keep in cache for 30 seconds
    })
}
