'use client'

import { useState, useEffect } from 'react'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { useUser } from '@/lib/auth/client'
import { toast } from 'sonner'
import { getNotificationPreferencesAction, updateNotificationPreferencesAction } from '@/app/(app)/settings/actions'
import { cn } from '@/lib/utils'

export function NotificationPreferences() {
  const [emailEnabled, setEmailEnabled] = useState(true)
  const [weeklySnapshotEnabled, setWeeklySnapshotEnabled] = useState(false)
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
        setEmailEnabled(nextEmailEnabled)
        setWeeklySnapshotEnabled(nextWeeklySnapshotEnabled)
      } catch (error) {
        console.error('Failed to load notification preferences:', error)
        toast.error('Failed to load preferences')
      } finally {
        setIsLoading(false)
      }
    }

    loadPreferences()
  }, [user])

  const savePreferences = async (nextPrefs: { emailEnabled: boolean; weeklySnapshotEnabled: boolean }) => {
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
    })
  }

  const handleWeeklySnapshotChange = (checked: boolean) => {
    setWeeklySnapshotEnabled(checked)
    void savePreferences({
      emailEnabled,
      weeklySnapshotEnabled: checked,
    })
  }

  const rows = [
    {
      id: 'email-notifications',
      label: 'Email notifications',
      description: 'Tasks, daily logs, schedule changes, and important workspace updates.',
      checked: emailEnabled,
      onCheckedChange: handleEmailChange,
      disabled: isLoading || isSaving,
      muted: false,
    },
    {
      id: 'weekly-snapshot',
      label: 'Weekly executive snapshot',
      description: 'Friday portfolio health, financial risk, cash exposure, and priority decisions.',
      checked: weeklySnapshotEnabled,
      onCheckedChange: handleWeeklySnapshotChange,
      disabled: isLoading || isSaving || !emailEnabled,
      muted: !emailEnabled,
      note: !emailEnabled ? 'Requires email notifications.' : null,
    },
  ]

  return (
    <div className="overflow-hidden border border-border/80 bg-background/75 shadow-sm">
      <div className="divide-y divide-border/70">
        {rows.map((row) => (
          <div
            key={row.id}
            className={cn(
              'px-4 py-4 lg:px-5',
              row.muted && 'bg-muted/20 text-muted-foreground',
            )}
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
  )
}
