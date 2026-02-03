/**
 * Parsers for special commands that require dedicated remote session handling
 */

export interface CompactCommandResult {
    isCompact: boolean;
    originalMessage: string;
}

export interface ClearCommandResult {
    isClear: boolean;
}

export interface RewindCommandResult {
    isRewind: boolean;
    targetSeq?: number;  // Optional: rewind to specific message sequence
}

export interface SpecialCommandResult {
    type: 'compact' | 'clear' | 'rewind' | null;
    originalMessage?: string;
    rewindOptions?: { targetSeq?: number };
}

/**
 * Parse /compact command
 * Matches messages starting with "/compact " or exactly "/compact"
 */
export function parseCompact(message: string): CompactCommandResult {
    const trimmed = message.trim();

    if (trimmed === '/compact') {
        return {
            isCompact: true,
            originalMessage: trimmed
        };
    }

    if (trimmed.startsWith('/compact ')) {
        return {
            isCompact: true,
            originalMessage: trimmed
        };
    }

    return {
        isCompact: false,
        originalMessage: message
    };
}

/**
 * Parse /clear command
 * Only matches exactly "/clear"
 */
export function parseClear(message: string): ClearCommandResult {
    const trimmed = message.trim();

    return {
        isClear: trimmed === '/clear'
    };
}

/**
 * Parse /rewind command
 * Matches "/rewind" or "/rewind N" where N is a sequence number
 *
 * NOTE: This command only rewinds the CONVERSATION (messages in HAPI's database).
 * It does NOT rewind CODE CHANGES - Claude Code's git-based checkpointing
 * is an interactive CLI feature not exposed through the SDK.
 * Users should use git directly to revert code changes.
 */
export function parseRewind(message: string): RewindCommandResult {
    const trimmed = message.trim();

    if (trimmed === '/rewind') {
        return { isRewind: true };
    }

    // Match: /rewind 5 (rewind to seq 5)
    const match = trimmed.match(/^\/rewind\s+(\d+)$/);
    if (match) {
        return {
            isRewind: true,
            targetSeq: parseInt(match[1], 10)
        };
    }

    return { isRewind: false };
}

/**
 * Unified parser for special commands
 * Returns the type of command and original message if applicable
 */
export function parseSpecialCommand(message: string): SpecialCommandResult {
    const compactResult = parseCompact(message);
    if (compactResult.isCompact) {
        return {
            type: 'compact',
            originalMessage: compactResult.originalMessage
        };
    }

    const clearResult = parseClear(message);
    if (clearResult.isClear) {
        return {
            type: 'clear'
        };
    }

    const rewindResult = parseRewind(message);
    if (rewindResult.isRewind) {
        return {
            type: 'rewind',
            rewindOptions: rewindResult.targetSeq !== undefined
                ? { targetSeq: rewindResult.targetSeq }
                : undefined
        };
    }

    return {
        type: null
    };
}
