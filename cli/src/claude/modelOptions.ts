import { isThinkingLevelAllowedForModel, type ModelMode, type ThinkingLevel } from '@hapi/protocol'
import { ModelModeSchema, ThinkingLevelSchema } from '@hapi/protocol/schemas'

export const DEFAULT_CLAUDE_MODEL_MODE: ModelMode = 'default'
export const DEFAULT_CLAUDE_THINKING_LEVEL: ThinkingLevel = 'medium'

export const CLAUDE_MODEL_ID_MAP: Record<ModelMode, string> = {
    default: 'sonnet',
    'claude-opus-4-5-20251101': 'claude-opus-4-5-20251101',
    sonnet: 'sonnet',
    'sonnet[1m]': 'sonnet[1m]',
    opus: 'opus',
    'opus[1m]': 'opus[1m]',
    'claude-sonnet-4-5-20250929': 'claude-sonnet-4-5-20250929'
}

export function resolveClaudeModelMode(value: unknown): ModelMode {
    const parsed = ModelModeSchema.safeParse(value)
    return parsed.success ? parsed.data : DEFAULT_CLAUDE_MODEL_MODE
}

export function resolveClaudeThinkingLevel(value: unknown): ThinkingLevel {
    const parsed = ThinkingLevelSchema.safeParse(value)
    return parsed.success ? parsed.data : DEFAULT_CLAUDE_THINKING_LEVEL
}

export function resolveClaudeModelId(modelMode: ModelMode | undefined): string {
    const resolvedModelMode = modelMode ?? DEFAULT_CLAUDE_MODEL_MODE
    return CLAUDE_MODEL_ID_MAP[resolvedModelMode]
}

export function normalizeThinkingLevelForModel(thinkingLevel: ThinkingLevel, modelMode: ModelMode): ThinkingLevel {
    if (isThinkingLevelAllowedForModel(thinkingLevel, modelMode)) {
        return thinkingLevel
    }
    return 'high'
}
