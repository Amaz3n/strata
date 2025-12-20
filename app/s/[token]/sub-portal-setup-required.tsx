"use client"

import { AlertTriangle, Building2, Settings } from "lucide-react"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"

interface SubPortalSetupRequiredProps {
  tokenId: string
  hasCompanyId: boolean
  portalType: string
}

export function SubPortalSetupRequired({
  tokenId,
  hasCompanyId,
  portalType,
}: SubPortalSetupRequiredProps) {
  return (
    <div className="min-h-screen flex items-center justify-center p-4 bg-gradient-to-b from-background to-muted">
      <Card className="w-full max-w-md">
        <CardHeader className="text-center">
          <div className="mx-auto mb-4 h-12 w-12 rounded-full bg-warning/20 flex items-center justify-center">
            <AlertTriangle className="h-6 w-6 text-warning" />
          </div>
          <CardTitle>Sub Portal Setup Required</CardTitle>
          <CardDescription>
            This portal link needs to be configured for subcontractor access
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="rounded-lg border bg-muted/50 p-4 space-y-3">
            <p className="text-sm font-medium">Missing configuration:</p>
            <ul className="text-sm text-muted-foreground space-y-2">
              {portalType !== "sub" && (
                <li className="flex items-center gap-2">
                  <Settings className="h-4 w-4 text-destructive" />
                  <span>
                    Portal type is &quot;{portalType || "client"}&quot; (needs to be &quot;sub&quot;)
                  </span>
                </li>
              )}
              {!hasCompanyId && (
                <li className="flex items-center gap-2">
                  <Building2 className="h-4 w-4 text-destructive" />
                  <span>No company assigned to this portal link</span>
                </li>
              )}
            </ul>
          </div>

          <div className="rounded-lg border p-4 space-y-2">
            <p className="text-sm font-medium">To fix this:</p>
            <ol className="text-sm text-muted-foreground space-y-1 list-decimal list-inside">
              <li>Go to the project&apos;s sharing settings</li>
              <li>Create a new sub portal link</li>
              <li>Select the company/subcontractor</li>
              <li>Share the new link with the sub</li>
            </ol>
          </div>

          <div className="pt-2 border-t">
            <p className="text-xs text-muted-foreground text-center">
              Token ID: {tokenId.slice(0, 8)}...
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  )
}
