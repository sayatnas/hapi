export type AgentType = 'claude' | 'codex' | 'gemini' | 'opencode'
export type SessionType = 'simple' | 'worktree'

export const DEFAULT_MODEL_SELECTION: Record<AgentType, string> = {
    claude: 'default',
    codex: 'auto',
    gemini: 'auto',
    opencode: ''
}

export const MODEL_OPTIONS: Record<AgentType, { value: string; label: string }[]> = {
    claude: [
        { value: 'default', label: 'Default (Sonnet 4.6 [200k])' },
        { value: 'claude-opus-4-5-20251101', label: 'claude-opus-4-5-20251101' },
        { value: 'sonnet', label: 'Sonnet 4.6 [200k]' },
        { value: 'sonnet[1m]', label: 'Sonnet 4.6 [1m]' },
        { value: 'opus', label: 'Opus 4.6 [200k]' },
        { value: 'opus[1m]', label: 'Opus 4.6 [1m]' },
        { value: 'claude-sonnet-4-5-20250929', label: 'claude-sonnet-4-5-20250929' },
    ],
    codex: [
        { value: 'auto', label: 'Auto' },
        { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex' },
        { value: 'gpt-5.2', label: 'GPT-5.2' },
        { value: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max' },
        { value: 'gpt-5.1-codex-mini', label: 'GPT-5.1 Codex Mini' },
    ],
    gemini: [
        { value: 'auto', label: 'Auto' },
        { value: 'gemini-3-pro-preview', label: 'Gemini 3 Pro Preview' },
        { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
        { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    ],
    opencode: [],
}
