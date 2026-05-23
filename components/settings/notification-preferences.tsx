'use client'

import { useState, useEffect } from 'react'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { useUser } from '@/lib/auth/client'
import { toast } from 'sonner'
import { getNotificationPreferencesAction, updateNotificationPreferencesAction } from '@/app/(app)/settings/actions'
import { cn } from '@/lib/utils'
import {
  EMAIL_NOTIFICATION_TYPES,
  type EmailNotificationType,
  type EmailNotificationTypeSettings,
} from '@/lib/types/notifications'

const DEFAULT_EMAIL_TYPE_SETTINGS = Object.fromEntries(
  EMAIL_NOTIFICATION_TYPES.map((type) => [type.key, true]),
) as EmailNotificationTypeSettings

export function NotificationPreferences() {
  const [emailEnabled, setEmailEnabled] = useState(true)
  const [weeklySnapshotEnabled, setWeeklySnapshotEnabled] = useState(false)
  const [emailTypeSettings, setEmailTypeSettings] = useState<EmailNotificationTypeSettings>(DEFAULT_EMAIL_TYPE_SETTINGS)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const { user } = useUser()

  // Load current preferences
  useEffect(() => {
    if (!user) return

    const loadPreferences = async () => {
      setIsLoading(true)
      try {
        const prefs = await getNotificationPreferencesAction()
        const nextEmailEnabled = prefs.email_enabled !== false
        const nextWeeklySnapshotEnabled = prefs.weekly_snapshot_enabled === true
        const nextEmailTypeSettings = {
          ...DEFAULT_EMAIL_TYPE_SETTINGS,
          ...(prefs.email_type_settings ?? {}),
        } as EmailNotificationTypeSettings
        setEmailEnabled(nextEmailEnabled)
        setWeeklySnapshotEnabled(nextWeeklySnapshotEnabled)
        setEmailTypeSettings(nextEmailTypeSettings)
      } catch (error) {
        console.error('Failed to load notification preferences:', error)
        toast.error('Failed to load preferences')
      } finally {
        setIsLoading(false)
      }
    }

    loadPreferences()
  }, [user])

  const savePreferences = async (nextPrefs: {
    emailEnabled: boolean
    weeklySnapshotEnabled: boolean
    emailTypeSettings: EmailNotificationTypeSettings
  }) => {
    if (!user) return

    setIsSaving(true)
    try {
      await updateNotificationPreferencesAction(nextPrefs)
      toast.success('Notification preferences saved')
    } catch (error) {
      console.error('Failed to save notification preferences:', error)
      toast.error('Failed to save preferences')
    } finally {
      setIsSaving(false)
    }
  }

  const handleEmailChange = (checked: boolean) => {
    const nextWeeklySnapshotEnabled = checked ? weeklySnapshotEnabled : false
    setEmailEnabled(checked)
    setWeeklySnapshotEnabled(nextWeeklySnapshotEnabled)
    void savePreferences({
      emailEnabled: checked,
      weeklySnapshotEnabled: nextWeeklySnapshotEnabled,
      emailTypeSettings,
    })
  }

  const handleWeeklySnapshotChange = (checked: boolean) => {
    setWeeklySnapshotEnabled(checked)
    void savePreferences({
      emailEnabled,
      weeklySnapshotEnabled: checked,
      emailTypeSettings,
    })
  }

  const handleEmailTypeChange = (key: EmailNotificationType, checked: boolean) => {
    const nextEmailTypeSettings = {
      ...emailTypeSettings,
      [key]: checked,
    }
    setEmailTypeSettings(nextEmailTypeSettings)
    void savePreferences({
      emailEnabled,
      weeklySnapshotEnabled,
      emailTypeSettings: nextEmailTypeSettings,
    })
  }

  const categoryRows = EMAIL_NOTIFICATION_TYPES.map((type) => ({
    id: `email-type-${type.key}`,
    label: type.label,
    description: type.description,
    checked: emailTypeSettings[type.key] !== false,
    onCheckedChange: (checked: boolean) => handleEmailTypeChange(type.key, checked),
    disabled: isLoading || isSaving || !emailEnabled,
    muted: !emailEnabled,
    note: !emailEnabled ? 'Requires email notifications.' : null,
  }))

  return (
    <div className="w-full max-w-3xl overflow-hidden border border-border/80 bg-background/75 shadow-sm">
      <div className="divide-y divide-border/70">
        <div className="px-4 py-4 lg:px-5">
          <div className="min-w-0">
            <div className="flex min-h-5 items-center justify-between gap-4">
              <Label htmlFor="email-notifications" className="min-w-0 truncate text-sm font-medium leading-5">
                Email notifications
              </Label>
              <Switch
                id="email-notifications"
                checked={emailEnabled}
                onCheckedChange={handleEmailChange}
                disabled={isLoading || isSaving}
                className="shrink-0"
              />
            </div>
            <p className="mt-1 max-w-2xl text-sm leading-5 text-muted-foreground">
              Master control for all emails Arc sends to you from workspace activity.
            </p>
          </div>
        </div>

        <div className={cn(!emailEnabled && 'bg-muted/20 text-muted-foreground')}>
          <div className="px-4 py-3 lg:px-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Activity emails</p>
          </div>
          <div className="divide-y divide-border/70 border-t border-border/70">
            {categoryRows.map((row) => (
              <div
                key={row.id}
                className="px-6 py-4 lg:px-8"
              >
                <div className="min-w-0">
                  <div className="flex min-h-5 items-center justify-between gap-4">
                    <Label htmlFor={row.id} className="min-w-0 truncate text-sm font-medium leading-5">
                      {row.label}
                    </Label>
                    <Switch
                      id={row.id}
                      checked={row.checked}
                      onCheckedChange={row.onCheckedChange}
                      disabled={row.disabled}
                      className="shrink-0"
                    />
                  </div>
                  <p className="mt-1 max-w-2xl text-sm leading-5 text-muted-foreground">{row.description}</p>
                  {row.note ? <p className="mt-1 text-xs text-muted-foreground">{row.note}</p> : null}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div
          className={cn(
            'px-4 py-4 lg:px-5',
            !emailEnabled && 'bg-muted/20 text-muted-foreground',
          )}
        >
          <div className="min-w-0">
            <div className="flex min-h-5 items-center justify-between gap-4">
              <Label htmlFor="weekly-snapshot" className="min-w-0 truncate text-sm font-medium leading-5">
                Weekly executive snapshot
              </Label>
              <Switch
                id="weekly-snapshot"
                checked={weeklySnapshotEnabled}
                onCheckedChange={handleWeeklySnapshotChange}
                disabled={isLoading || isSaving || !emailEnabled}
                className="shrink-0"
              />
            </div>
            <p className="mt-1 max-w-2xl text-sm leading-5 text-muted-foreground">
              Friday portfolio health, financial risk, cash exposure, and priority decisions.
            </p>
            {!emailEnabled ? <p className="mt-1 text-xs text-muted-foreground">Requires email notifications.</p> : null}
          </div>
        </div>
      </div>
    </div>
  )
}
