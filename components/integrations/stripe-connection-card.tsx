'use client'

import { useState, useTransition } from "react"
import { AlertCircle, ArrowUpRight, CheckCircle2, RefreshCw } from "lucide-react"

import {
  createStripeConnectedAccountOnboardingLinkAction,
  createStripeDashboardLoginLinkAction,
  refreshStripeConnectedAccountAction,
} from "@/app/(app)/settings/integrations/actions"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import type { StripeConnectedAccount } from "@/lib/services/stripe-connected-accounts"

interface Props {
  connection: StripeConnectedAccount | null
  canManage?: boolean
  onConnectionChange?: (connection: StripeConnectedAccount | null) => void
}

function statusLabel(connection: StripeConnectedAccount | null) {
  if (!connection) return "Not connected"
  switch (connection.status) {
    case "active":
      return "Ready"
    case "onboarding":
      return "Onboarding"
    case "restricted":
      return "Needs attention"
    case "disconnected":
      return "Disconnected"
    case "error":
      return "Error"
    default:
      return "Pending"
  }
}

export function StripeConnectionCard({ connection, canManage = false, onConnectionChange }: Props) {
  const [error, setError] = useState<string | null>(null)
  const [isStarting, startStarting] = useTransition()
  const [isRefreshing, startRefreshing] = useTransition()
  const [isOpeningDashboard, startOpeningDashboard] = useTransition()

  const handleStartOnboarding = () => {
    setError(null)
    startStarting(async () => {
      try {
        const result = await createStripeConnectedAccountOnboardingLinkAction()
        if (result?.url) {
          window.location.href = result.url
          return
        }
        setError("Unable to start Stripe onboarding.")
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to start Stripe onboarding.")
      }
    })
  }

  const handleRefresh = () => {
    setError(null)
    startRefreshing(async () => {
      try {
        const refreshed = await refreshStripeConnectedAccountAction()
        onConnectionChange?.(refreshed)
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to refresh Stripe status.")
      }
    })
  }

  const handleOpenDashboard = () => {
    setError(null)
    startOpeningDashboard(async () => {
      try {
        const result = await createStripeDashboardLoginLinkAction()
        if (result?.url) {
          window.location.href = result.url
          return
        }
        setError("Unable to open Stripe dashboard.")
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to open Stripe dashboard.")
      }
    })
  }

  const currentlyDue = connection?.requirements_currently_due ?? []
  const isReady = Boolean(connection?.charges_enabled && connection?.payouts_enabled)

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[#635BFF]">
              <span className="text-sm font-bold text-white">S</span>
            </div>
            <div>
              <CardTitle className="text-lg">Stripe payouts</CardTitle>
              <CardDescription>Route invoice payments to this organization's bank account</CardDescription>
            </div>
          </div>
          <Badge variant={isReady ? "default" : "outline"}>
            {isReady ? <CheckCircle2 className="mr-1 h-3 w-3" /> : <AlertCircle className="mr-1 h-3 w-3" />}
            {statusLabel(connection)}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {!connection ? (
          <div className="space-y-4">
            <div className="rounded-lg bg-muted/50 p-4">
              <h4 className="font-medium">What this enables:</h4>
              <ul className="mt-2 space-y-1 text-sm text-muted-foreground">
                <li>• Invoice links can collect card and ACH payments</li>
                <li>• Funds route to your organization instead of Arc</li>
                <li>• Stripe handles payout onboarding and verification</li>
              </ul>
            </div>
            <div className="flex flex-wrap gap-3">
              <Button onClick={handleStartOnboarding} disabled={!canManage || isStarting}>
                {isStarting ? "Starting..." : "Connect Stripe"}
              </Button>
              {!canManage && <span className="text-xs text-muted-foreground">Org admin access is required to connect payouts.</span>}
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            <div className="rounded-lg border border-border/70 bg-muted/20 p-4 text-sm text-muted-foreground">
              <div>Connected account: <span className="font-mono text-foreground">{connection.stripe_account_id}</span></div>
              <div>Charges enabled: {connection.charges_enabled ? "Yes" : "No"}</div>
              <div>Payouts enabled: {connection.payouts_enabled ? "Yes" : "No"}</div>
              {connection.disabled_reason && <div>Disabled reason: {connection.disabled_reason}</div>}
            </div>

            {currentlyDue.length > 0 && (
              <div className="rounded-lg border border-amber-300/60 bg-amber-50/60 p-4 text-sm text-amber-900">
                <div className="font-medium">Stripe still needs a few details before online payments are fully live.</div>
                <ul className="mt-2 space-y-1">
                  {currentlyDue.slice(0, 5).map((item) => (
                    <li key={item}>• {item.replaceAll("_", " ")}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="flex flex-wrap gap-3">
              <Button onClick={handleStartOnboarding} disabled={!canManage || isStarting}>
                {connection.status === "active"
                  ? "Update Stripe details"
                  : isStarting
                    ? "Opening..."
                    : "Resume onboarding"}
              </Button>
              <Button variant="outline" onClick={handleRefresh} disabled={!canManage || isRefreshing}>
                <RefreshCw className={`mr-2 h-4 w-4 ${isRefreshing ? "animate-spin" : ""}`} />
                Refresh status
              </Button>
              {connection.dashboard_type === "express" && (
                <Button variant="outline" onClick={handleOpenDashboard} disabled={!canManage || isOpeningDashboard}>
                  <ArrowUpRight className="mr-2 h-4 w-4" />
                  Open Stripe dashboard
                </Button>
              )}
            </div>
          </div>
        )}

        {error && <div className="text-sm text-destructive">{error}</div>}
      </CardContent>
    </Card>
  )
}
