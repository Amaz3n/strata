'use client'

import { useState, useEffect } from 'react'
import { Switch } from '@/components/ui/switch'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { useUser } from '@/lib/auth/client'
import { toast } from 'sonner'
import { getNotificationPreferencesAction, updateNotificationPreferencesAction } from '@/app/settings/actions'

export function NotificationPreferences() {
  const [emailEnabled, setEmailEnabled] = useState(true)
  const [isLoading, setIsLoading] = useState(false)
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false)
  const { user } = useUser()

  // Load current preferences
  useEffect(() => {
    if (!user) return

    const loadPreferences = async () => {
      try {
        const prefs = await getNotificationPreferencesAction()
        setEmailEnabled(prefs.email_enabled)
      } catch (error) {
        console.error('Failed to load notification preferences:', error)
        toast.error('Failed to load preferences')
      }
    }

    loadPreferences()
  }, [user])

  // Track changes
  useEffect(() => {
    setHasUnsavedChanges(true)
  }, [emailEnabled])

  const handleSave = async () => {
    if (!user) return

    setIsLoading(true)
    try {
      await updateNotificationPreferencesAction(emailEnabled)
      setHasUnsavedChanges(false)
      toast.success('Notification preferences saved')
    } catch (error) {
      console.error('Failed to save notification preferences:', error)
      toast.error('Failed to save preferences')
    } finally {
      setIsLoading(false)
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
            disabled={!hasUnsavedChanges || isLoading}
          >
            {isLoading ? 'Saving...' : 'Save Preferences'}
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}
