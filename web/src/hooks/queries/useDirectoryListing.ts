import { useQuery } from '@tanstack/react-query'
import type { ApiClient } from '@/api/client'
import type { DirectoryEntry } from '@/types/api'
import { queryKeys } from '@/lib/query-keys'

export function useDirectoryListing(
    api: ApiClient | null,
    sessionId: string | null,
    path: string,
    options?: { enabled?: boolean }
): {
    entries: DirectoryEntry[]
    error: string | null
    isLoading: boolean
    refetch: () => Promise<unknown>
} {
    const resolvedSessionId = sessionId ?? 'unknown'
    const enabled = options?.enabled ?? Boolean(api && sessionId)

    const result = useQuery({
        queryKey: queryKeys.directory(resolvedSessionId, path),
        queryFn: async () => {
            if (!api || !sessionId) {
                throw new Error('Session unavailable')
            }
            const response = await api.listDirectory(sessionId, path || undefined)
            if (!response.success) {
                return { entries: [], error: response.error ?? 'Failed to list directory' }
            }
            return { entries: response.entries ?? [], error: null }
        },
        enabled,
    })

    const queryError = result.error instanceof Error
        ? result.error.message
        : result.error
            ? 'Failed to list directory'
            : null

    return {
        entries: result.data?.entries ?? [],
        error: queryError ?? result.data?.error ?? null,
        isLoading: result.isLoading,
        refetch: result.refetch
    }
}
