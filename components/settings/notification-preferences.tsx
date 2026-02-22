'use client'

import { useState, useEffect } from 'react'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useUser } from '@/lib/auth/client'
import { toast } from 'sonner'
import { getNotificationPreferencesAction, updateNotificationPreferencesAction } from '@/app/(app)/settings/actions'

export function NotificationPreferences() {
  const [emailEnabled, setEmailEnabled] = useState(true)
  const [weeklySnapshotEnabled, setWeeklySnapshotEnabled] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isSaving, setIsSaving] = useState(false)
  const [initialPrefs, setInitialPrefs] = useState<{
    emailEnabled: boolean
    weeklySnapshotEnabled: boolean
  } | null>(null)
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
        setInitialPrefs({
          emailEnabled: nextEmailEnabled,
          weeklySnapshotEnabled: nextWeeklySnapshotEnabled,
        })
      } catch (error) {
        console.error('Failed to load notification preferences:', error)
        toast.error('Failed to load preferences')
      } finally {
        setIsLoading(false)
      }
    }

    loadPreferences()
  }, [user])

  const hasUnsavedChanges = Boolean(
    initialPrefs &&
    (emailEnabled !== initialPrefs.emailEnabled || weeklySnapshotEnabled !== initialPrefs.weeklySnapshotEnabled),
  )

  const handleSave = async () => {
    if (!user) return

    setIsSaving(true)
    try {
      await updateNotificationPreferencesAction({
        emailEnabled,
        weeklySnapshotEnabled,
      })
      setInitialPrefs({
        emailEnabled,
        weeklySnapshotEnabled,
      })
      toast.success('Notification preferences saved')
    } catch (error) {
      console.error('Failed to save notification preferences:', error)
      toast.error('Failed to save preferences')
    } finally {
      setIsSaving(false)
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Notifications</CardTitle>
        <CardDescription>Configure how you receive updates and alerts</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Email Notifications */}
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="email-notifications" className="text-base">
              Email Notifications
            </Label>
            <p className="text-sm text-muted-foreground">
              Receive email updates for tasks, daily logs, schedule changes, and other important events
            </p>
          </div>
          <Switch
            id="email-notifications"
            checked={emailEnabled}
            onCheckedChange={setEmailEnabled}
            disabled={isLoading || isSaving}
          />
        </div>

        {/* Weekly Snapshot */}
        <div className="flex items-center justify-between">
          <div className="space-y-0.5">
            <Label htmlFor="weekly-snapshot" className="text-base">
              Weekly Executive Snapshot
            </Label>
            <p className="text-sm text-muted-foreground">
              Receive the Friday financial and project health snapshot email with portfolio risk, cash exposure, and priority decisions.
            </p>
          </div>
          <Switch
            id="weekly-snapshot"
            checked={weeklySnapshotEnabled}
            onCheckedChange={setWeeklySnapshotEnabled}
            disabled={isLoading || isSaving || !emailEnabled}
          />
        </div>

        {/* Future: In-App Notifications */}
        <div className="flex items-center justify-between opacity-50">
          <div className="space-y-0.5">
            <Label htmlFor="in-app-notifications" className="text-base">
              In-App Notifications
            </Label>
            <p className="text-sm text-muted-foreground">
              Show toast notifications in the app (always enabled)
            </p>
          </div>
          <Switch
            id="in-app-notifications"
            checked={true}
            disabled
          />
        </div>

        {/* Future: Push Notifications */}
        <div className="flex items-center justify-between opacity-50">
          <div className="space-y-0.5">
            <Label htmlFor="push-notifications" className="text-base">
              Push Notifications
            </Label>
            <p className="text-sm text-muted-foreground">
              Receive push notifications on your mobile devices (coming soon)
            </p>
          </div>
          <Switch
            id="push-notifications"
            checked={false}
            disabled
          />
        </div>

        {/* Save Button */}
        <div className="flex justify-end pt-4 border-t">
          <Button
            onClick={handleSave}
            disabled={!hasUnsavedChanges || isLoading || isSaving}
          >
            {isSaving ? 'Saving...' : 'Save Preferences'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
