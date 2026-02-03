import { useCallback, useMemo, useState } from 'react'
import { useNavigate, useParams } from '@tanstack/react-router'
import type { DirectoryEntry, FileSearchItem, GitFileStatus } from '@/types/api'
import { FileIcon } from '@/components/FileIcon'
import { useAppContext } from '@/lib/app-context'
import { useAppGoBack } from '@/hooks/useAppGoBack'
import { useDirectoryListing } from '@/hooks/queries/useDirectoryListing'
import { useGitStatusFiles } from '@/hooks/queries/useGitStatusFiles'
import { useSession } from '@/hooks/queries/useSession'
import { useSessionFileSearch } from '@/hooks/queries/useSessionFileSearch'
import { encodeBase64 } from '@/lib/utils'

function BackIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <polyline points="15 18 9 12 15 6" />
        </svg>
    )
}

function RefreshIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M21 12a9 9 0 1 1-3-6.7" />
            <polyline points="21 3 21 9 15 9" />
        </svg>
    )
}

function SearchIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
    )
}

function GitBranchIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="6" cy="18" r="3" />
            <circle cx="18" cy="6" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
    )
}

function FolderIcon(props: { className?: string; open?: boolean }) {
    if (props.open) {
        return (
            <svg
                xmlns="http://www.w3.org/2000/svg"
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
                strokeLinejoin="round"
                className={props.className}
            >
                <path d="M5 19a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h4l2 2h9a2 2 0 0 1 2 2v1" />
                <path d="M5 19h14a2 2 0 0 0 2-2v-5a2 2 0 0 0-2-2H9a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2Z" />
            </svg>
        )
    }
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
        </svg>
    )
}

function HomeIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
            <polyline points="9 22 9 12 15 12 15 22" />
        </svg>
    )
}

function ChevronRightIcon(props: { className?: string }) {
    return (
        <svg
            xmlns="http://www.w3.org/2000/svg"
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={props.className}
        >
            <polyline points="9 18 15 12 9 6" />
        </svg>
    )
}

function StatusBadge(props: { status: GitFileStatus['status'] }) {
    const { label, color } = useMemo(() => {
        switch (props.status) {
            case 'added':
                return { label: 'A', color: 'var(--app-git-staged-color)' }
            case 'deleted':
                return { label: 'D', color: 'var(--app-git-deleted-color)' }
            case 'renamed':
                return { label: 'R', color: 'var(--app-git-renamed-color)' }
            case 'untracked':
                return { label: '?', color: 'var(--app-git-untracked-color)' }
            case 'conflicted':
                return { label: 'U', color: 'var(--app-git-deleted-color)' }
            default:
                return { label: 'M', color: 'var(--app-git-unstaged-color)' }
        }
    }, [props.status])

    return (
        <span
            className="inline-flex items-center justify-center rounded border px-1.5 py-0.5 text-[10px] font-semibold"
            style={{ color, borderColor: color }}
        >
            {label}
        </span>
    )
}

function formatFileSize(bytes?: number): string {
    if (bytes === undefined) return ''
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

function DirectoryEntryRow(props: {
    entry: DirectoryEntry
    gitStatus?: GitFileStatus
    onNavigate: () => void
    onOpenFile: () => void
    showDivider: boolean
}) {
    const isDirectory = props.entry.type === 'directory'
    const handleClick = isDirectory ? props.onNavigate : props.onOpenFile

    return (
        <button
            type="button"
            onClick={handleClick}
            className={`flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--app-subtle-bg)] transition-colors ${props.showDivider ? 'border-b border-[var(--app-divider)]' : ''}`}
        >
            {isDirectory ? (
                <FolderIcon className="text-[var(--app-link)]" />
            ) : (
                <FileIcon fileName={props.entry.name} size={22} />
            )}
            <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{props.entry.name}</div>
                {!isDirectory && props.entry.size !== undefined ? (
                    <div className="truncate text-xs text-[var(--app-hint)]">
                        {formatFileSize(props.entry.size)}
                    </div>
                ) : null}
            </div>
            {props.gitStatus ? (
                <StatusBadge status={props.gitStatus.status} />
            ) : null}
            {isDirectory ? (
                <ChevronRightIcon className="text-[var(--app-hint)]" />
            ) : null}
        </button>
    )
}

function SearchResultRow(props: {
    file: FileSearchItem
    onOpen: () => void
    showDivider: boolean
}) {
    const subtitle = props.file.filePath || 'project root'
    const icon = props.file.fileType === 'file'
        ? <FileIcon fileName={props.file.fileName} size={22} />
        : <FolderIcon className="text-[var(--app-link)]" />

    return (
        <button
            type="button"
            onClick={props.onOpen}
            className={`flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--app-subtle-bg)] transition-colors ${props.showDivider ? 'border-b border-[var(--app-divider)]' : ''}`}
        >
            {icon}
            <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{props.file.fileName}</div>
                <div className="truncate text-xs text-[var(--app-hint)]">{subtitle}</div>
            </div>
        </button>
    )
}

function FileListSkeleton(props: { label: string; rows?: number }) {
    const titleWidths = ['w-1/3', 'w-1/2', 'w-2/3', 'w-2/5', 'w-3/5']
    const subtitleWidths = ['w-1/2', 'w-2/3', 'w-3/4', 'w-1/3']
    const rows = props.rows ?? 6

    return (
        <div className="p-3 animate-pulse space-y-3" role="status" aria-live="polite">
            <span className="sr-only">{props.label}</span>
            {Array.from({ length: rows }).map((_, index) => (
                <div key={`skeleton-row-${index}`} className="flex items-center gap-3">
                    <div className="h-6 w-6 rounded bg-[var(--app-subtle-bg)]" />
                    <div className="flex-1 space-y-2">
                        <div className={`h-3 ${titleWidths[index % titleWidths.length]} rounded bg-[var(--app-subtle-bg)]`} />
                        <div className={`h-2 ${subtitleWidths[index % subtitleWidths.length]} rounded bg-[var(--app-subtle-bg)]`} />
                    </div>
                </div>
            ))}
        </div>
    )
}

function Breadcrumbs(props: {
    currentPath: string
    onNavigate: (path: string) => void
}) {
    const parts = props.currentPath ? props.currentPath.split('/').filter(Boolean) : []

    return (
        <div className="flex items-center gap-1 text-sm overflow-x-auto">
            <button
                type="button"
                onClick={() => props.onNavigate('')}
                className="flex items-center gap-1 px-2 py-1 rounded hover:bg-[var(--app-subtle-bg)] text-[var(--app-link)] shrink-0"
            >
                <HomeIcon />
            </button>
            {parts.map((part, index) => {
                const pathUpToHere = parts.slice(0, index + 1).join('/')
                const isLast = index === parts.length - 1
                return (
                    <div key={pathUpToHere} className="flex items-center gap-1 shrink-0">
                        <ChevronRightIcon className="text-[var(--app-hint)]" />
                        {isLast ? (
                            <span className="px-2 py-1 font-medium truncate max-w-[150px]">{part}</span>
                        ) : (
                            <button
                                type="button"
                                onClick={() => props.onNavigate(pathUpToHere)}
                                className="px-2 py-1 rounded hover:bg-[var(--app-subtle-bg)] text-[var(--app-link)] truncate max-w-[150px]"
                            >
                                {part}
                            </button>
                        )}
                    </div>
                )
            })}
        </div>
    )
}

export default function FilesPage() {
    const { api } = useAppContext()
    const navigate = useNavigate()
    const goBack = useAppGoBack()
    const { sessionId } = useParams({ from: '/sessions/$sessionId/files' })
    const { session } = useSession(api, sessionId)

    // Current directory path (relative to session root)
    const [currentPath, setCurrentPath] = useState('')
    const [searchQuery, setSearchQuery] = useState('')

    // Directory listing (primary)
    const {
        entries,
        error: dirError,
        isLoading: dirLoading,
        refetch: refetchDir
    } = useDirectoryListing(api, sessionId, currentPath)

    // Git status (optional enhancement)
    const {
        status: gitStatus,
        error: gitError,
        isLoading: gitLoading,
    } = useGitStatusFiles(api, sessionId)

    // Search (when user types in search box)
    const isSearching = Boolean(searchQuery)
    const searchResults = useSessionFileSearch(api, sessionId, searchQuery, {
        enabled: isSearching
    })

    // Build a map of file paths to their git status for quick lookup
    const gitStatusMap = useMemo(() => {
        const map = new Map<string, GitFileStatus>()
        if (gitStatus) {
            for (const file of [...gitStatus.stagedFiles, ...gitStatus.unstagedFiles]) {
                map.set(file.fullPath, file)
            }
        }
        return map
    }, [gitStatus])

    const handleOpenFile = useCallback((fullPath: string, staged?: boolean) => {
        const search = staged === undefined
            ? { path: encodeBase64(fullPath) }
            : { path: encodeBase64(fullPath), staged }
        navigate({
            to: '/sessions/$sessionId/file',
            params: { sessionId },
            search
        })
    }, [navigate, sessionId])

    const handleNavigateToDir = useCallback((path: string) => {
        setCurrentPath(path)
        setSearchQuery('') // Clear search when navigating
    }, [])

    const handleNavigateToEntry = useCallback((entryName: string) => {
        const newPath = currentPath ? `${currentPath}/${entryName}` : entryName
        setCurrentPath(newPath)
    }, [currentPath])

    const branchLabel = gitStatus?.branch ?? null
    const subtitle = session?.metadata?.path ?? sessionId
    const hasGitStatus = Boolean(gitStatus) && !gitError

    return (
        <div className="flex h-full flex-col">
            {/* Header */}
            <div className="bg-[var(--app-bg)] pt-[env(safe-area-inset-top)]">
                <div className="mx-auto w-full max-w-content flex items-center gap-2 p-3 border-b border-[var(--app-border)]">
                    <button
                        type="button"
                        onClick={goBack}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                    >
                        <BackIcon />
                    </button>
                    <div className="min-w-0 flex-1">
                        <div className="truncate font-semibold">Files</div>
                        <div className="truncate text-xs text-[var(--app-hint)]">{subtitle}</div>
                    </div>
                    <button
                        type="button"
                        onClick={() => { void refetchDir() }}
                        className="flex h-8 w-8 items-center justify-center rounded-full text-[var(--app-hint)] transition-colors hover:bg-[var(--app-secondary-bg)] hover:text-[var(--app-fg)]"
                        title="Refresh"
                    >
                        <RefreshIcon />
                    </button>
                </div>
            </div>

            {/* Search bar */}
            <div className="bg-[var(--app-bg)]">
                <div className="mx-auto w-full max-w-content p-3 border-b border-[var(--app-border)]">
                    <div className="flex items-center gap-2 rounded-md bg-[var(--app-subtle-bg)] px-3 py-2">
                        <SearchIcon className="text-[var(--app-hint)]" />
                        <input
                            value={searchQuery}
                            onChange={(event) => setSearchQuery(event.target.value)}
                            placeholder="Search files..."
                            className="w-full bg-transparent text-sm text-[var(--app-fg)] placeholder:text-[var(--app-hint)] focus:outline-none"
                            autoCapitalize="none"
                            autoCorrect="off"
                        />
                        {searchQuery ? (
                            <button
                                type="button"
                                onClick={() => setSearchQuery('')}
                                className="text-[var(--app-hint)] hover:text-[var(--app-fg)]"
                            >
                                &times;
                            </button>
                        ) : null}
                    </div>
                </div>
            </div>

            {/* Git branch info (if available) */}
            {!gitLoading && hasGitStatus && branchLabel ? (
                <div className="bg-[var(--app-bg)]">
                    <div className="mx-auto w-full max-w-content px-3 py-2 border-b border-[var(--app-divider)]">
                        <div className="flex items-center gap-2 text-sm">
                            <GitBranchIcon className="text-[var(--app-hint)]" />
                            <span className="font-semibold">{branchLabel}</span>
                            {gitStatus ? (
                                <span className="text-xs text-[var(--app-hint)]">
                                    ({gitStatus.totalStaged + gitStatus.totalUnstaged} changes)
                                </span>
                            ) : null}
                        </div>
                    </div>
                </div>
            ) : null}

            {/* Breadcrumbs (only when not searching) */}
            {!isSearching ? (
                <div className="bg-[var(--app-bg)]">
                    <div className="mx-auto w-full max-w-content px-3 py-2 border-b border-[var(--app-divider)]">
                        <Breadcrumbs
                            currentPath={currentPath}
                            onNavigate={handleNavigateToDir}
                        />
                    </div>
                </div>
            ) : null}

            {/* Content */}
            <div className="flex-1 overflow-y-auto">
                <div className="mx-auto w-full max-w-content">
                    {isSearching ? (
                        // Search results mode
                        searchResults.isLoading ? (
                            <FileListSkeleton label="Searching files..." />
                        ) : searchResults.error ? (
                            <div className="p-6 text-sm text-[var(--app-hint)]">{searchResults.error}</div>
                        ) : searchResults.files.length === 0 ? (
                            <div className="p-6 text-sm text-[var(--app-hint)]">
                                No files match "{searchQuery}"
                            </div>
                        ) : (
                            <div>
                                <div className="px-3 py-2 text-xs text-[var(--app-hint)] border-b border-[var(--app-divider)]">
                                    {searchResults.files.length} result{searchResults.files.length !== 1 ? 's' : ''}
                                </div>
                                {searchResults.files.map((file, index) => (
                                    <SearchResultRow
                                        key={`${file.fullPath}-${index}`}
                                        file={file}
                                        onOpen={() => handleOpenFile(file.fullPath)}
                                        showDivider={index < searchResults.files.length - 1}
                                    />
                                ))}
                            </div>
                        )
                    ) : (
                        // Directory browser mode
                        dirLoading ? (
                            <FileListSkeleton label="Loading directory..." />
                        ) : dirError ? (
                            <div className="p-6 text-sm text-[var(--app-hint)]">{dirError}</div>
                        ) : entries.length === 0 ? (
                            <div className="p-6 text-sm text-[var(--app-hint)]">
                                This directory is empty.
                            </div>
                        ) : (
                            <div>
                                {entries.map((entry, index) => {
                                    const fullPath = currentPath
                                        ? `${session?.metadata?.path}/${currentPath}/${entry.name}`
                                        : `${session?.metadata?.path}/${entry.name}`
                                    const gitFileStatus = gitStatusMap.get(fullPath)

                                    return (
                                        <DirectoryEntryRow
                                            key={`${entry.name}-${index}`}
                                            entry={entry}
                                            gitStatus={gitFileStatus}
                                            onNavigate={() => handleNavigateToEntry(entry.name)}
                                            onOpenFile={() => handleOpenFile(fullPath)}
                                            showDivider={index < entries.length - 1}
                                        />
                                    )
                                })}
                            </div>
                        )
                    )}
                </div>
            </div>
        </div>
    )
}
