'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { SettingsGroup, SettingsToggle } from '@/components/settings/settings-section'
import { useUser } from '@/lib/auth/client'
import { type getNotificationPreferencesAction, updateNotificationPreferencesAction } from '@/app/(app)/settings/actions'
import { unwrapAction } from '@/lib/action-result'
import {
  EMAIL_NOTIFICATION_TYPES,
  NOTIFICATION_EMAIL_CATEGORIES,
  type EmailNotificationType,
  type EmailNotificationTypeSettings,
} from '@/lib/types/notifications'

const DEFAULT_EMAIL_TYPE_SETTINGS = Object.fromEntries(
  EMAIL_NOTIFICATION_TYPES.map((type) => [type.key, true]),
) as EmailNotificationTypeSettings

const containerClass = 'mx-auto w-full max-w-3xl space-y-8 px-5 py-6 lg:px-8 lg:py-8'

/**
 * The catalog, grouped once. A flat list of 50+ switches is unusable for the
 * person who needs it most — a bookkeeper looking for the four payment alerts
 * that page them — so the category on each type owns the layout, and the empty
 * groups drop out rather than rendering a bare header.
 */
const GROUPED_EMAIL_TYPES = NOTIFICATION_EMAIL_CATEGORIES.map((category) => ({
  ...category,
  types: EMAIL_NOTIFICATION_TYPES.filter((type) => type.category === category.key),
})).filter((group) => group.types.length > 0)

type Snapshot = {
  emailEnabled: boolean
  weeklySnapshotEnabled: boolean
  emailTypeSettings: EmailNotificationTypeSettings
}

function preferencesSnapshot(preferences: Awaited<ReturnType<typeof getNotificationPreferencesAction>>): Snapshot {
  return {
    emailEnabled: preferences.email_enabled !== false,
    weeklySnapshotEnabled: preferences.weekly_snapshot_enabled === true,
    emailTypeSettings: { ...DEFAULT_EMAIL_TYPE_SETTINGS, ...preferences.email_type_settings },
  }
}

export function NotificationPreferences({ initialPreferences }: { initialPreferences: Awaited<ReturnType<typeof getNotificationPreferencesAction>> }) {
  const [state, setState] = useState({ source: initialPreferences, snapshot: preferencesSnapshot(initialPreferences) })
  if (state.source !== initialPreferences) {
    setState({ source: initialPreferences, snapshot: preferencesSnapshot(initialPreferences) })
  }
  const { emailEnabled, weeklySnapshotEnabled, emailTypeSettings } = state.snapshot
  const [isSaving, setIsSaving] = useState(false)
  const [query, setQuery] = useState('')
  const { user } = useUser()
  const mounted = useRef(false)
  const inFlight = useRef(false)
  const currentSource = useRef(initialPreferences)
  const currentActor = useRef(user?.id)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  useEffect(() => { currentSource.current = initialPreferences }, [initialPreferences])
  useEffect(() => { currentActor.current = user?.id }, [user?.id])

  const normalizedQuery = query.trim().toLowerCase()
  const visibleGroups = useMemo(() => {
    if (!normalizedQuery) return GROUPED_EMAIL_TYPES
    return GROUPED_EMAIL_TYPES.map((group) => ({
      ...group,
      types: group.types.filter((type) =>
        `${type.label} ${type.description} ${group.label}`.toLowerCase().includes(normalizedQuery),
      ),
    })).filter((group) => group.types.length > 0)
  }, [normalizedQuery])

  // Every toggle persists the full preference object. On failure we restore the snapshot
  // taken before the optimistic update, so the switch never lies about what's saved.
  const persist = async (next: Snapshot, previous: Snapshot) => {
    if (!mounted.current || !user || inFlight.current) return
    inFlight.current = true
    setIsSaving(true)
    setState((current) => ({ ...current, snapshot: next }))
    try {
      const result = await updateNotificationPreferencesAction(next)
      if (!mounted.current || currentSource.current !== initialPreferences || currentActor.current !== user.id) return
      unwrapAction(result)
    } catch (error) {
      if (!mounted.current || currentSource.current !== initialPreferences || currentActor.current !== user.id) return
      console.error('Failed to save notification preferences:', error)
      toast.error('Could not save that change', { description: 'We put the setting back the way it was.' })
      setState((current) => current.source === initialPreferences
        ? { ...current, snapshot: previous }
        : current)
    } finally {
      inFlight.current = false
      if (mounted.current) setIsSaving(false)
    }
  }

  const handleEmailChange = (checked: boolean) => {
    // Turning the master switch off also parks the digest; keep the per-type choices intact.
    void persist({ ...state.snapshot, emailEnabled: checked, weeklySnapshotEnabled: checked ? weeklySnapshotEnabled : false }, state.snapshot)
  }

  const handleWeeklySnapshotChange = (checked: boolean) => {
    if (!emailEnabled) return
    void persist({ ...state.snapshot, weeklySnapshotEnabled: checked }, state.snapshot)
  }

  const handleEmailTypeChange = (key: EmailNotificationType, checked: boolean) => {
    if (!emailEnabled) return
    void persist({ ...state.snapshot, emailTypeSettings: { ...emailTypeSettings, [key]: checked } }, state.snapshot)
  }

  const setGroup = (keys: readonly EmailNotificationType[], checked: boolean) => {
    if (!emailEnabled) return
    const nextTypes = { ...emailTypeSettings }
    for (const key of keys) nextTypes[key] = checked
    void persist({ ...state.snapshot, emailTypeSettings: nextTypes }, state.snapshot)
  }

  const enabledCount = EMAIL_NOTIFICATION_TYPES.filter((type) => emailTypeSettings[type.key] !== false).length
  const activityDisabled = isSaving || !user || !emailEnabled

  return (
    <div className={containerClass}>
      <SettingsGroup title="Email">
        <SettingsToggle
          id="email-notifications"
          label="Email notifications"
          description="The master switch for every email Arc sends you from workspace activity. Turn it off to pause them all — in-app notifications keep coming."
          checked={emailEnabled}
          onCheckedChange={handleEmailChange}
          disabled={isSaving || !user}
        />
      </SettingsGroup>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <Input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter activity emails"
          aria-label="Filter activity emails"
          className="h-9 w-full max-w-xs"
        />
        <span className="text-xs tabular-nums text-muted-foreground">
          {emailEnabled ? `${enabledCount} of ${EMAIL_NOTIFICATION_TYPES.length} on` : 'Email off'}
        </span>
      </div>

      {visibleGroups.length === 0 ? (
        <div className="border border-border bg-muted/20 px-4 py-8 text-center">
          <p className="text-sm font-medium text-foreground">No activity emails match &ldquo;{query.trim()}&rdquo;</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            Try a shorter term, or clear the filter to see all {EMAIL_NOTIFICATION_TYPES.length}.
          </p>
          <Button variant="outline" size="sm" className="mt-4" onClick={() => setQuery('')}>
            Clear filter
          </Button>
        </div>
      ) : (
        visibleGroups.map((group) => {
          const keys = group.types.map((type) => type.key)
          const allOn = keys.every((key) => emailTypeSettings[key] !== false)
          return (
            <SettingsGroup
              key={group.key}
              title={group.label}
              description={group.description}
              action={
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-xs"
                  disabled={activityDisabled}
                  onClick={() => setGroup(keys, !allOn)}
                >
                  {allOn ? 'Turn all off' : 'Turn all on'}
                </Button>
              }
            >
              {group.types.map((type) => (
                <SettingsToggle
                  key={type.key}
                  id={`email-type-${type.key}`}
                  label={type.label}
                  description={type.description}
                  checked={emailTypeSettings[type.key] !== false}
                  onCheckedChange={(checked) => handleEmailTypeChange(type.key, checked)}
                  disabled={activityDisabled}
                />
              ))}
            </SettingsGroup>
          )
        })
      )}

      <SettingsGroup title="Digests">
        <SettingsToggle
          id="weekly-snapshot"
          label="Weekly executive snapshot"
          description="A Friday summary of portfolio health, financial risk, cash exposure, and the decisions waiting on you."
          checked={weeklySnapshotEnabled}
          onCheckedChange={handleWeeklySnapshotChange}
          disabled={activityDisabled}
        />
      </SettingsGroup>
    </div>
  )
}
