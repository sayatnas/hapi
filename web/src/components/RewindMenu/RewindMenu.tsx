import { memo, useCallback, useEffect, useRef, useState } from 'react'
import type { Checkpoint } from '@/hooks/queries/useCheckpoints'
import { Spinner } from '@/components/Spinner'

interface RewindMenuProps {
    checkpoints: Checkpoint[]
    isLoading: boolean
    error: string | null
    onRewind: (seq: number) => void
    onClose: () => void
}

function formatTime(timestamp: number): string {
    const date = new Date(timestamp)
    const now = new Date()
    const isToday = date.toDateString() === now.toDateString()

    if (isToday) {
        return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    }

    return date.toLocaleDateString([], {
        month: 'short',
        day: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
    })
}

/**
 * RewindMenu component for selecting a checkpoint to rewind to.
 *
 * NOTE: This only supports conversation rewind (deleting messages after the checkpoint).
 * Code changes are NOT reverted - Claude Code's git-based checkpointing is an
 * interactive CLI feature not exposed through the SDK.
 *
 * To revert code changes, users should use git directly:
 *   git checkout <file>  - revert specific file
 *   git stash            - stash all changes
 *   git reset --hard     - discard all changes
 */
export const RewindMenu = memo(function RewindMenu(props: RewindMenuProps) {
    const { checkpoints, isLoading, error, onRewind, onClose } = props
    const [selectedIndex, setSelectedIndex] = useState(-1)
    const [isRewinding, setIsRewinding] = useState(false)
    const listRef = useRef<HTMLDivElement>(null)

    // Handle keyboard navigation
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
                return
            }

            if (checkpoints.length === 0) return

            if (e.key === 'ArrowUp') {
                e.preventDefault()
                setSelectedIndex(prev => prev <= 0 ? checkpoints.length - 1 : prev - 1)
            } else if (e.key === 'ArrowDown') {
                e.preventDefault()
                setSelectedIndex(prev => prev >= checkpoints.length - 1 ? 0 : prev + 1)
            } else if (e.key === 'Enter' && selectedIndex >= 0) {
                e.preventDefault()
                handleRewind(checkpoints[selectedIndex].seq)
            }
        }

        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [checkpoints, selectedIndex, onClose])

    // Scroll selected item into view
    useEffect(() => {
        if (selectedIndex < 0 || selectedIndex >= checkpoints.length) return
        const listEl = listRef.current
        if (!listEl) return
        const selectedEl = listEl.querySelector<HTMLButtonElement>(
            `[data-checkpoint-index="${selectedIndex}"]`
        )
        selectedEl?.scrollIntoView({ block: 'nearest' })
    }, [selectedIndex, checkpoints])

    const handleRewind = useCallback(async (seq: number) => {
        setIsRewinding(true)
        try {
            await onRewind(seq)
        } finally {
            setIsRewinding(false)
        }
    }, [onRewind])

    if (isLoading) {
        return (
            <div className="flex items-center justify-center py-8">
                <Spinner className="h-6 w-6" />
            </div>
        )
    }

    if (error) {
        return (
            <div className="p-4 text-center text-sm text-red-500">
                {error}
            </div>
        )
    }

    if (checkpoints.length === 0) {
        return (
            <div className="p-4 text-center text-sm text-[var(--app-hint)]">
                No checkpoints available yet.
                <br />
                <span className="text-xs">Checkpoints are created at each message you send.</span>
            </div>
        )
    }

    return (
        <div className="py-1" ref={listRef}>
            <div className="px-3 pb-2 pt-1">
                <div className="text-sm font-medium text-[var(--app-fg)]">
                    Rewind Conversation
                </div>
                <div className="text-xs text-[var(--app-hint)]">
                    Select a checkpoint to rewind to. Messages after that point will be removed.
                </div>
                <div className="mt-1 text-xs text-amber-500">
                    Note: This only rewinds the conversation, not code changes. Use git to revert files.
                </div>
            </div>
            <div className="mx-3 mb-2 h-px bg-[var(--app-divider)]" />
            {/* Show checkpoints in reverse order (most recent first) */}
            {[...checkpoints].reverse().map((checkpoint, index) => {
                const reversedIndex = checkpoints.length - 1 - index
                const isSelected = reversedIndex === selectedIndex

                return (
                    <button
                        key={checkpoint.seq}
                        type="button"
                        data-checkpoint-index={reversedIndex}
                        disabled={isRewinding}
                        className={`flex w-full cursor-pointer flex-col items-start gap-0.5 px-3 py-2 text-left text-sm transition-colors ${
                            isSelected
                                ? 'bg-[var(--app-button)] text-[var(--app-button-text)]'
                                : 'text-[var(--app-fg)] hover:bg-[var(--app-secondary-bg)]'
                        } ${isRewinding ? 'cursor-not-allowed opacity-50' : ''}`}
                        onClick={() => handleRewind(checkpoint.seq)}
                        onMouseDown={(e) => e.preventDefault()}
                        onMouseEnter={() => setSelectedIndex(reversedIndex)}
                    >
                        <div className="flex w-full items-center justify-between gap-2">
                            <span className="font-medium truncate flex-1">
                                {checkpoint.preview || '(empty message)'}
                            </span>
                            <span className={`text-xs whitespace-nowrap ${
                                isSelected ? 'opacity-80' : 'text-[var(--app-hint)]'
                            }`}>
                                {formatTime(checkpoint.createdAt)}
                            </span>
                        </div>
                        <span className={`text-xs ${
                            isSelected ? 'opacity-70' : 'text-[var(--app-hint)]'
                        }`}>
                            Message #{checkpoint.seq}
                        </span>
                    </button>
                )
            })}
        </div>
    )
})
