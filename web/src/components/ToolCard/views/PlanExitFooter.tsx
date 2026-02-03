import { useState } from 'react'
import type { ApiClient } from '@/api/client'
import type { ChatToolCall } from '@/chat/types'
import { usePlatform } from '@/hooks/usePlatform'
import { Spinner } from '@/components/Spinner'
import { useTranslation } from '@/lib/use-translation'

function PermissionRowButton(props: {
    label: string
    description?: string
    tone: 'allow' | 'deny' | 'neutral'
    loading?: boolean
    disabled: boolean
    onClick: () => void
}) {
    const base = 'flex w-full flex-col items-start rounded-md px-2 py-2 text-sm text-left transition-colors disabled:pointer-events-none disabled:opacity-50 hover:bg-[var(--app-subtle-bg)]'
    const tone = props.tone === 'allow'
        ? 'text-emerald-600'
        : props.tone === 'deny'
            ? 'text-red-600'
            : 'text-[var(--app-link)]'

    return (
        <button
            type="button"
            className={`${base} ${tone}`}
            disabled={props.disabled}
            aria-busy={props.loading === true}
            onClick={props.onClick}
        >
            <span className="flex w-full items-center justify-between">
                <span className="flex-1 font-medium">{props.label}</span>
                {props.loading ? (
                    <span className="ml-2 shrink-0">
                        <Spinner size="sm" label={null} className="text-current" />
                    </span>
                ) : null}
            </span>
            {props.description ? (
                <span className="mt-0.5 text-xs opacity-70">{props.description}</span>
            ) : null}
        </button>
    )
}

export function PlanExitFooter(props: {
    api: ApiClient
    sessionId: string
    tool: ChatToolCall
    disabled: boolean
    onDone: () => void
}) {
    const { t } = useTranslation()
    const { haptic } = usePlatform()
    const permission = props.tool.permission
    const [loading, setLoading] = useState<'approve' | 'approveEdits' | 'approveYolo' | 'approveDangerousYolo' | 'deny' | null>(null)
    const [error, setError] = useState<string | null>(null)

    if (!permission) return null

    const isPending = permission.status === 'pending'

    const run = async (action: () => Promise<void>, hapticType: 'success' | 'error') => {
        if (props.disabled) return
        setError(null)
        try {
            await action()
            haptic.notification(hapticType)
            props.onDone()
        } catch (e) {
            haptic.notification('error')
            setError(e instanceof Error ? e.message : t('tool.requestFailed'))
        }
    }

    const approve = async () => {
        if (!isPending || loading) return
        setLoading('approve')
        await run(() => props.api.approvePermission(props.sessionId, permission.id, 'default'), 'success')
        setLoading(null)
    }

    const approveWithAutoEdits = async () => {
        if (!isPending || loading) return
        setLoading('approveEdits')
        await run(() => props.api.approvePermission(props.sessionId, permission.id, 'acceptEdits'), 'success')
        setLoading(null)
    }

    const approveWithYolo = async () => {
        if (!isPending || loading) return
        setLoading('approveYolo')
        await run(() => props.api.approvePermission(props.sessionId, permission.id, 'bypassPermissions'), 'success')
        setLoading(null)
    }

    const approveWithDangerousYolo = async () => {
        if (!isPending || loading) return
        setLoading('approveDangerousYolo')
        await run(() => props.api.approvePermission(props.sessionId, permission.id, 'dangerouslySkipPermissions'), 'success')
        setLoading(null)
    }

    const deny = async () => {
        if (!isPending || loading) return
        setLoading('deny')
        await run(() => props.api.denyPermission(props.sessionId, permission.id), 'success')
        setLoading(null)
    }

    if (!isPending) {
        if (permission.status !== 'denied' && permission.status !== 'canceled') return null
        if (!permission.reason) return null

        return (
            <div className="mt-2 text-xs text-red-600">
                {permission.reason}
            </div>
        )
    }

    return (
        <div className="mt-3">
            <div className="text-xs text-[var(--app-hint)] mb-2">{t('plan.chooseAction')}</div>

            {error ? (
                <div className="mb-2 text-xs text-red-600">
                    {error}
                </div>
            ) : null}

            <div className="flex flex-col gap-1">
                <PermissionRowButton
                    label={t('plan.approve')}
                    description={t('plan.approve.desc')}
                    tone="allow"
                    loading={loading === 'approve'}
                    disabled={props.disabled || loading !== null}
                    onClick={approve}
                />
                <PermissionRowButton
                    label={t('plan.approveAutoEdits')}
                    description={t('plan.approveAutoEdits.desc')}
                    tone="neutral"
                    loading={loading === 'approveEdits'}
                    disabled={props.disabled || loading !== null}
                    onClick={approveWithAutoEdits}
                />
                <PermissionRowButton
                    label={t('plan.approveYolo')}
                    description={t('plan.approveYolo.desc')}
                    tone="neutral"
                    loading={loading === 'approveYolo'}
                    disabled={props.disabled || loading !== null}
                    onClick={approveWithYolo}
                />
                <PermissionRowButton
                    label={t('plan.approveDangerousYolo')}
                    description={t('plan.approveDangerousYolo.desc')}
                    tone="deny"
                    loading={loading === 'approveDangerousYolo'}
                    disabled={props.disabled || loading !== null}
                    onClick={approveWithDangerousYolo}
                />
                <PermissionRowButton
                    label={t('plan.deny')}
                    tone="deny"
                    loading={loading === 'deny'}
                    disabled={props.disabled || loading !== null}
                    onClick={deny}
                />
            </div>
        </div>
    )
}
