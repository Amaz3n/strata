'use client'

import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { SettingsError, SettingsGroup, SettingsToggle } from '@/components/settings/settings-section'
import { useUser } from '@/lib/auth/client'
import { getNotificationPreferencesAction, updateNotificationPreferencesAction } from '@/app/(app)/settings/actions'
import { unwrapAction } from '@/lib/action-result'
import {
  EMAIL_NOTIFICATION_TYPES,
  type EmailNotificationType,
  type EmailNotificationTypeSettings,
} from '@/lib/types/notifications'

const DEFAULT_EMAIL_TYPE_SETTINGS = Object.fromEntries(
  EMAIL_NOTIFICATION_TYPES.map((type) => [type.key, true]),
) as EmailNotificationTypeSettings

const containerClass = 'mx-auto w-full max-w-3xl space-y-8 px-5 py-6 lg:px-8 lg:py-8'

type Snapshot = {
  emailEnabled: boolean
  weeklySnapshotEnabled: boolean
  emailTypeSettings: EmailNotificationTypeSettings
}

export function NotificationPreferences() {
  const [emailEnabled, setEmailEnabled] = useState(true)
  const [weeklySnapshotEnabled, setWeeklySnapshotEnabled] = useState(false)
  const [emailTypeSettings, setEmailTypeSettings] = useState<EmailNotificationTypeSettings>(DEFAULT_EMAIL_TYPE_SETTINGS)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const { user } = useUser()

  const loadPreferences = useCallback(async () => {
    setIsLoading(true)
    setLoadError(false)
    try {
      const prefs = await getNotificationPreferencesAction()
      setEmailEnabled(prefs.email_enabled !== false)
      setWeeklySnapshotEnabled(prefs.weekly_snapshot_enabled === true)
      setEmailTypeSettings({
        ...DEFAULT_EMAIL_TYPE_SETTINGS,
        ...(prefs.email_type_settings ?? {}),
      } as EmailNotificationTypeSettings)
      return true
    } catch (error) {
      console.error('Failed to load notification preferences:', error)
      setLoadError(true)
      return false
    } finally {
      setIsLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!user) return
    void loadPreferences()
  }, [user, loadPreferences])

  // Every toggle persists the full preference object. On failure we restore the snapshot
  // taken before the optimistic update, so the switch never lies about what's saved.
  const persist = async (next: Snapshot, previous: Snapshot) => {
    if (!user) return
    setIsSaving(true)
    try {
      unwrapAction(
        await updateNotificationPreferencesAction({
          emailEnabled: next.emailEnabled,
          weeklySnapshotEnabled: next.weeklySnapshotEnabled,
          emailTypeSettings: next.emailTypeSettings,
        }),
      )
    } catch (error) {
      console.error('Failed to save notification preferences:', error)
      toast.error('Could not save that change', { description: 'We put the setting back the way it was.' })
      setEmailEnabled(previous.emailEnabled)
      setWeeklySnapshotEnabled(previous.weeklySnapshotEnabled)
      setEmailTypeSettings(previous.emailTypeSettings)
    } finally {
      setIsSaving(false)
    }
  }

  const snapshot = (): Snapshot => ({ emailEnabled, weeklySnapshotEnabled, emailTypeSettings })

  const handleEmailChange = (checked: boolean) => {
    const previous = snapshot()
    // Turning the master switch off also parks the digest; keep the per-type choices intact.
    const nextWeekly = checked ? weeklySnapshotEnabled : false
    setEmailEnabled(checked)
    setWeeklySnapshotEnabled(nextWeekly)
    void persist({ emailEnabled: checked, weeklySnapshotEnabled: nextWeekly, emailTypeSettings }, previous)
  }

  const handleWeeklySnapshotChange = (checked: boolean) => {
    const previous = snapshot()
    setWeeklySnapshotEnabled(checked)
    void persist({ emailEnabled, weeklySnapshotEnabled: checked, emailTypeSettings }, previous)
  }

  const handleEmailTypeChange = (key: EmailNotificationType, checked: boolean) => {
    const previous = snapshot()
    const nextTypes = { ...emailTypeSettings, [key]: checked }
    setEmailTypeSettings(nextTypes)
    void persist({ emailEnabled, weeklySnapshotEnabled, emailTypeSettings: nextTypes }, previous)
  }

  if (isLoading) {
    return (
      <div className={containerClass} aria-busy>
        {[3, 5].map((rows, groupIndex) => (
          <div key={groupIndex}>
            <Skeleton className="h-3 w-24 rounded-none" />
            <div className="mt-2 divide-y divide-border border-t border-border">
              {Array.from({ length: rows }).map((_, rowIndex) => (
                <div key={rowIndex} className="flex items-start justify-between gap-6 py-4">
                  <div className="min-w-0 flex-1 space-y-2">
                    <Skeleton className="h-4 w-40 rounded-none" />
                    <Skeleton className="h-3 w-full max-w-md rounded-none" />
                  </div>
                  <Skeleton className="h-5 w-9 shrink-0 rounded-full" />
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    )
  }

  if (loadError) {
    return (
      <div className={containerClass}>
        <div className="flex flex-col items-start gap-3 border border-border bg-muted/20 px-4 py-6">
          <SettingsError>We couldn&rsquo;t load your notification preferences.</SettingsError>
          <Button variant="outline" size="sm" onClick={() => void loadPreferences()}>
            Try again
          </Button>
        </div>
      </div>
    )
  }

  const enabledCount = EMAIL_NOTIFICATION_TYPES.filter((type) => emailTypeSettings[type.key] !== false).length
  const activityDisabled = isSaving || !emailEnabled

  return (
    <div className={containerClass}>
      <SettingsGroup title="Email">
        <SettingsToggle
          id="email-notifications"
          label="Email notifications"
          description="The master switch for every email Arc sends you from workspace activity. Turn it off to pause them all — in-app notifications keep coming."
          checked={emailEnabled}
          onCheckedChange={handleEmailChange}
          disabled={isSaving}
        />
      </SettingsGroup>

      <SettingsGroup
        title="Activity emails"
        action={
          <span className="text-xs tabular-nums text-muted-foreground">
            {emailEnabled ? `${enabledCount} of ${EMAIL_NOTIFICATION_TYPES.length} on` : 'Email off'}
          </span>
        }
      >
        {EMAIL_NOTIFICATION_TYPES.map((type) => (
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
