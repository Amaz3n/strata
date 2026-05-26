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
import { Card, CardContent } from "@/components/ui/card"
import type { StripeConnectedAccount } from "@/lib/services/stripe-connected-accounts"
import { cn } from "@/lib/utils"

interface Props {
  connection: StripeConnectedAccount | null
  canManage?: boolean
  onConnectionChange?: (connection: StripeConnectedAccount | null) => void
}

function statusLabel(connection: StripeConnectedAccount | null) {
  if (!connection) return "Not connected"
  const responsibilities = connection.metadata?.stripe_responsibilities as Record<string, unknown> | undefined
  if (
    connection.charges_enabled &&
    connection.payouts_enabled &&
    (responsibilities?.fees_payer !== "account" || responsibilities?.losses_payments !== "stripe")
  ) {
    return "Reconnect required"
  }
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
  const [showAdvanced, setShowAdvanced] = useState(false)

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
  const responsibilities = connection?.metadata?.stripe_responsibilities as Record<string, unknown> | undefined
  const hasProtectedResponsibility = responsibilities?.fees_payer === "account" && responsibilities?.losses_payments === "stripe"
  const isReady = Boolean(connection?.charges_enabled && connection?.payouts_enabled && hasProtectedResponsibility)

  return (
    <Card className="overflow-hidden rounded-none border-0 py-0 shadow-none">
      <CardContent className="flex flex-col gap-4 p-4">
        <div className="flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
          <div className="flex min-w-0 items-start gap-3">
            <div className="flex size-12 shrink-0 items-center justify-center border border-border/70 bg-background p-1.5">
              <img src="/stripe.svg" alt="" className="w-10 object-contain" />
            </div>
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <h3 className="truncate text-sm font-semibold">Stripe Payouts</h3>
                <Badge variant={isReady ? "default" : "outline"} className="gap-1">
                  {isReady ? <CheckCircle2 className="size-3" /> : <AlertCircle className="size-3" />}
                  {statusLabel(connection)}
                </Badge>
              </div>
              <p className="mt-1 text-sm text-muted-foreground">Route invoice payments to your bank account.</p>
              {connection && (
                <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 text-xs text-muted-foreground">
                  <span>Charges: {connection.charges_enabled ? "enabled" : "pending"}</span>
                  <span>Payouts: {connection.payouts_enabled ? "enabled" : "pending"}</span>
                  {connection.dashboard_type && <span>Dashboard: {connection.dashboard_type}</span>}
                </div>
              )}
            </div>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2 md:justify-end">
            {!connection ? (
              <Button onClick={handleStartOnboarding} disabled={!canManage || isStarting} size="sm">
                {isStarting ? "Starting..." : "Connect"}
              </Button>
            ) : (
              <>
                <Button onClick={handleStartOnboarding} disabled={!canManage || isStarting} variant={isReady ? "outline" : "default"} size="sm">
                  {connection.status === "active" ? "Update" : isStarting ? "Opening..." : "Resume"}
                </Button>
                {connection.dashboard_type === "express" && (
                  <Button variant="ghost" size="sm" onClick={handleOpenDashboard} disabled={isOpeningDashboard}>
                    Dashboard
                    <ArrowUpRight className="ml-1 size-3.5" />
                  </Button>
                )}
                <Button variant="ghost" size="sm" onClick={handleRefresh} disabled={!canManage || isRefreshing}>
                  <RefreshCw className={cn("mr-1 size-3.5", isRefreshing && "animate-spin")} />
                  Sync
                </Button>
              </>
            )}
          </div>
        </div>

        {!connection ? (
          !canManage && <p className="text-xs text-muted-foreground">Org admin access required to connect Stripe.</p>
        ) : (
          <div className="flex flex-col gap-3 border-t border-border/60 pt-4">
            {currentlyDue.length > 0 && (
              <div className="border border-border/70 bg-muted/20 p-3">
                <div className="flex items-start gap-3">
                  <AlertCircle className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <div>
                    <h5 className="text-sm font-semibold">Missing information</h5>
                    <p className="mt-1 text-sm text-muted-foreground">Stripe needs more details before online payments are fully active.</p>
                    <ul className="mt-2 flex flex-wrap gap-2">
                      {currentlyDue.slice(0, 3).map((item) => (
                        <li key={item} className="text-xs capitalize text-muted-foreground">
                          {item.replaceAll("_", " ")}
                        </li>
                      ))}
                      {currentlyDue.length > 3 && (
                        <li className="text-xs text-muted-foreground">+ {currentlyDue.length - 3} more</li>
                      )}
                    </ul>
                  </div>
                </div>
              </div>
            )}

            {!hasProtectedResponsibility && (
              <div className="border border-amber-300/70 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/20 dark:text-amber-200">
                Reconnect Stripe before accepting invoice payments. The previous connection used platform-side fee or loss responsibility.
              </div>
            )}

            <Button variant="ghost" size="sm" onClick={() => setShowAdvanced(!showAdvanced)} className="w-fit px-0 text-xs text-muted-foreground">
              {showAdvanced ? "Hide details" : "Show details"}
            </Button>

            {showAdvanced && (
              <div className="grid gap-2 border border-border/70 bg-muted/20 p-3 font-mono text-[10px] text-muted-foreground md:grid-cols-2">
                <div className="flex justify-between">
                  <span>ACCOUNT ID</span>
                  <span className="text-foreground">{connection.stripe_account_id}</span>
                </div>
                <div className="flex justify-between">
                  <span>CHARGES ENABLED</span>
                  <span className="text-foreground">
                    {connection.charges_enabled ? "YES" : "NO"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>PAYOUTS ENABLED</span>
                  <span className="text-foreground">
                    {connection.payouts_enabled ? "YES" : "NO"}
                  </span>
                </div>
                {connection.disabled_reason && (
                  <div className="flex justify-between">
                    <span>REASON</span>
                    <span className="text-destructive uppercase">{connection.disabled_reason}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="border border-destructive/20 bg-destructive/[0.03] p-3 text-xs text-destructive">
            {error}
          </div>
        )}
      </CardContent>
    </Card>
  )
}
