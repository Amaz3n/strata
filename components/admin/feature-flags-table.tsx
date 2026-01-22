"use client"

import { useState, useTransition } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Settings, Loader2 } from "@/components/icons"
import { getFeatureFlags, toggleFeatureFlag } from "@/app/(app)/admin/features/actions"
import { useToast } from "@/hooks/use-toast"

interface FeatureFlag {
  id: string
  orgId: string
  flagKey: string
  enabled: boolean
  config: Record<string, any>
  expiresAt: string | null
  orgName: string
}

export function FeatureFlagsTable() {
  const [featureFlags, setFeatureFlags] = useState<FeatureFlag[]>([])
  const [loading, setLoading] = useState(true)
  const [toggling, setToggling] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()

  // Load feature flags on mount
  useState(() => {
    getFeatureFlags().then(flags => {
      setFeatureFlags(flags)
      setLoading(false)
    }).catch(error => {
      console.error('Failed to load feature flags:', error)
      setLoading(false)
    })
  })

  const handleToggle = (flagId: string, orgId: string, flagKey: string, enabled: boolean) => {
    setToggling(flagId)
    startTransition(async () => {
      try {
        await toggleFeatureFlag(flagId, orgId, flagKey, !enabled)
        setFeatureFlags(flags =>
          flags.map(flag =>
            flag.id === flagId ? { ...flag, enabled: !enabled } : flag
          )
        )
        toast({
          title: "Feature flag updated",
          description: `${flagKey} ${!enabled ? 'enabled' : 'disabled'} for ${featureFlags.find(f => f.id === flagId)?.orgName}`,
        })
      } catch (error) {
        toast({
          title: "Error",
          description: "Failed to update feature flag",
          variant: "destructive",
        })
      } finally {
        setToggling(null)
      }
    })
  }

  if (loading) {
    return (
      <div className="space-y-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div className="space-y-2">
                  <div className="h-4 w-32 bg-muted animate-pulse rounded" />
                  <div className="h-3 w-48 bg-muted animate-pulse rounded" />
                </div>
                <div className="h-6 w-12 bg-muted animate-pulse rounded" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    )
  }

  // Group by organization
  const groupedFlags = featureFlags.reduce((acc, flag) => {
    if (!acc[flag.orgId]) {
      acc[flag.orgId] = {
        orgName: flag.orgName,
        flags: []
      }
    }
    acc[flag.orgId].flags.push(flag)
    return acc
  }, {} as Record<string, { orgName: string; flags: FeatureFlag[] }>)

  return (
    <div className="space-y-6">
      {Object.entries(groupedFlags).map(([orgId, { orgName, flags }]) => (
        <Card key={orgId}>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <Settings className="h-5 w-5" />
              {orgName}
            </CardTitle>
            <CardDescription>
              Feature flags for this organization
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="space-y-4">
              {flags.map((flag) => (
                <div key={flag.id} className="flex items-center justify-between p-3 border rounded-lg">
                  <div className="space-y-1">
                    <div className="font-medium">{flag.flagKey}</div>
                    <div className="text-sm text-muted-foreground">
                      {getFeatureDescription(flag.flagKey)}
                    </div>
                    {flag.expiresAt && (
                      <Badge variant="outline" className="text-xs">
                        Expires: {new Date(flag.expiresAt).toLocaleDateString()}
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-3">
                    <Badge variant={flag.enabled ? "default" : "secondary"}>
                      {flag.enabled ? "Enabled" : "Disabled"}
                    </Badge>
                    <Switch
                      checked={flag.enabled}
                      onCheckedChange={() => handleToggle(flag.id, flag.orgId, flag.flagKey, flag.enabled)}
                      disabled={toggling === flag.id}
                    />
                    {toggling === flag.id && <Loader2 className="h-4 w-4 animate-spin" />}
                  </div>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      ))}

      {Object.keys(groupedFlags).length === 0 && (
        <Card>
          <CardContent className="p-8 text-center">
            <Settings className="h-12 w-12 mx-auto text-muted-foreground mb-4" />
            <h3 className="text-lg font-medium mb-2">No Feature Flags</h3>
            <p className="text-muted-foreground">
              No feature flags have been configured yet.
            </p>
          </CardContent>
        </Card>
      )}
    </div>
  )
}

function getFeatureDescription(flagKey: string): string {
  const descriptions: Record<string, string> = {
    'advanced_reporting': 'Access to advanced analytics and custom reports',
    'api_access': 'Programmatic API access for integrations',
    'beta_features': 'Access to beta and experimental features',
    'custom_branding': 'Custom branding and white-labeling options',
    'export_data': 'Ability to export data in various formats',
    'multi_org': 'Support for multiple organizations per user',
    'premium_support': 'Priority support and dedicated account manager',
    'unlimited_projects': 'Remove project limits for this organization',
  }

  return descriptions[flagKey] || 'Custom feature flag'
}