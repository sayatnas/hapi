import { useMutation } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { AttachmentMetadata, DecryptedMessage } from '@/types/api'
import { makeClientSideId } from '@/lib/messages'
import {
    appendOptimisticMessage,
    getMessageWindowState,
    updateMessageStatus,
} from '@/lib/message-window-store'
import { usePlatform } from '@/hooks/usePlatform'

type SendMessageInput = {
    sessionId: string
    text: string
    localId: string
    createdAt: number
    attachments?: AttachmentMetadata[]
}

type BlockedReason = 'no-api' | 'no-session' | 'pending'

export interface QueuedMessage {
    localId: string
    text: string
    attachments?: AttachmentMetadata[]
    createdAt: number
}

type UseSendMessageOptions = {
    resolveSessionId?: (sessionId: string) => Promise<string>
    onSessionResolved?: (sessionId: string) => void
    onBlocked?: (reason: BlockedReason) => void
    /** @deprecated No longer used - real-time steering injects messages mid-turn on the backend */
    isThinking?: boolean
}

function findMessageByLocalId(
    sessionId: string,
    localId: string,
): DecryptedMessage | null {
    const state = getMessageWindowState(sessionId)
    for (const message of state.messages) {
        if (message.localId === localId) return message
    }
    for (const message of state.pending) {
        if (message.localId === localId) return message
    }
    return null
}

export function useSendMessage(
    api: ApiClient | null,
    sessionId: string | null,
    options?: UseSendMessageOptions
): {
    sendMessage: (text: string, attachments?: AttachmentMetadata[]) => void
    retryMessage: (localId: string) => void
    isSending: boolean
    queuedMessages: QueuedMessage[]
    removeFromQueue: (localId: string) => void
} {
    const { haptic } = usePlatform()
    const [isResolving, setIsResolving] = useState(false)
    const [queue, setQueue] = useState<QueuedMessage[]>([])
    const resolveGuardRef = useRef(false)
    const processingQueueRef = useRef(false)

    const mutation = useMutation({
        mutationFn: async (input: SendMessageInput) => {
            if (!api) {
                throw new Error('API unavailable')
            }
            await api.sendMessage(input.sessionId, input.text, input.localId, input.attachments)
        },
        onMutate: async (input) => {
            const optimisticMessage: DecryptedMessage = {
                id: input.localId,
                seq: null,
                localId: input.localId,
                content: {
                    role: 'user',
                    content: {
                        type: 'text',
                        text: input.text,
                        attachments: input.attachments
                    }
                },
                createdAt: input.createdAt,
                status: 'sending',
                originalText: input.text,
            }

            appendOptimisticMessage(input.sessionId, optimisticMessage)
        },
        onSuccess: (_, input) => {
            updateMessageStatus(input.sessionId, input.localId, 'sent')
            haptic.notification('success')
        },
        onError: (_, input) => {
            updateMessageStatus(input.sessionId, input.localId, 'failed')
            haptic.notification('error')
        },
    })

    // Internal function to actually send a message
    const doSend = useCallback((text: string, localId: string, createdAt: number, attachments?: AttachmentMetadata[]) => {
        if (!api || !sessionId) return

        void (async () => {
            let targetSessionId = sessionId
            if (options?.resolveSessionId) {
                resolveGuardRef.current = true
                setIsResolving(true)
                try {
                    const resolved = await options.resolveSessionId(sessionId)
                    if (resolved && resolved !== sessionId) {
                        options.onSessionResolved?.(resolved)
                        targetSessionId = resolved
                    }
                } catch (error) {
                    haptic.notification('error')
                    console.error('Failed to resolve session before send:', error)
                    return
                } finally {
                    resolveGuardRef.current = false
                    setIsResolving(false)
                }
            }
            mutation.mutate({
                sessionId: targetSessionId,
                text,
                localId,
                createdAt,
                attachments,
            })
        })()
    }, [api, sessionId, options, mutation, haptic])

    // Process queue - send queued messages when the previous send completes
    // Messages are queued if user sends while a previous send is in progress
    useEffect(() => {
        if (queue.length === 0) return
        // Only send when no other send is in progress
        if (mutation.isPending || resolveGuardRef.current) return
        if (processingQueueRef.current) return

        processingQueueRef.current = true
        const [next, ...rest] = queue

        if (next) {
            // Update status from 'queued' to 'sending'
            if (sessionId) {
                updateMessageStatus(sessionId, next.localId, 'sending')
            }
            doSend(next.text, next.localId, next.createdAt, next.attachments)
            setQueue(rest)
        }

        processingQueueRef.current = false
    }, [queue, mutation.isPending, doSend, sessionId])

    const sendMessage = (text: string, attachments?: AttachmentMetadata[]) => {
        if (!api) {
            options?.onBlocked?.('no-api')
            haptic.notification('error')
            return
        }
        if (!sessionId) {
            options?.onBlocked?.('no-session')
            haptic.notification('error')
            return
        }

        const localId = makeClientSideId('local')
        const createdAt = Date.now()

        // Queue if a send API call is in progress (prevents race conditions)
        // Otherwise send immediately - backend handles mid-turn injection for real-time steering
        if (mutation.isPending || resolveGuardRef.current) {
            // Add to queue and show as "queued" status
            const queuedMessage: QueuedMessage = {
                localId,
                text,
                attachments,
                createdAt
            }
            setQueue(prev => [...prev, queuedMessage])

            // Also add optimistic message with 'queued' status
            const optimisticMessage: DecryptedMessage = {
                id: localId,
                seq: null,
                localId,
                content: {
                    role: 'user',
                    content: {
                        type: 'text',
                        text,
                        attachments
                    }
                },
                createdAt,
                status: 'queued',
                originalText: text,
            }
            appendOptimisticMessage(sessionId, optimisticMessage)
            return
        }

        // Send immediately - if Claude is thinking, backend injects mid-turn (real-time steering)
        doSend(text, localId, createdAt, attachments)
    }

    const retryMessage = (localId: string) => {
        if (!api) {
            options?.onBlocked?.('no-api')
            haptic.notification('error')
            return
        }
        if (!sessionId) {
            options?.onBlocked?.('no-session')
            haptic.notification('error')
            return
        }
        if (mutation.isPending || resolveGuardRef.current) {
            options?.onBlocked?.('pending')
            return
        }

        const message = findMessageByLocalId(sessionId, localId)
        if (!message?.originalText) return

        updateMessageStatus(sessionId, localId, 'sending')

        mutation.mutate({
            sessionId,
            text: message.originalText,
            localId,
            createdAt: message.createdAt,
        })
    }

    const removeFromQueue = useCallback((localId: string) => {
        setQueue(prev => prev.filter(m => m.localId !== localId))
        // Also remove from optimistic messages
        if (sessionId) {
            // Mark as failed so it can be removed or retried
            updateMessageStatus(sessionId, localId, 'failed')
        }
    }, [sessionId])

    return {
        sendMessage,
        retryMessage,
        isSending: mutation.isPending || isResolving,
        queuedMessages: queue,
        removeFromQueue,
    }
}
