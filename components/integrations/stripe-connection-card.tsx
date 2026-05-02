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
import { cn } from "@/lib/utils"

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
  const isReady = Boolean(connection?.charges_enabled && connection?.payouts_enabled)

  return (
    <Card className="overflow-hidden border-border/80 shadow-sm transition-all hover:border-border/100 hover:shadow-md">
      <div className="h-2 bg-[#635BFF]" />
      <CardHeader className="pb-4">
        <div className="flex items-start justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#635BFF] text-white shadow-sm">
              <svg viewBox="0 0 40 40" className="h-7 w-7 fill-current">
                <path d="M20 0c-11.046 0-20 8.954-20 20s8.954 20 20 20 20-8.954 20-20-8.954-20-20-20zm0 37c-9.389 0-17-7.611-17-17s7.611-17 17-17 17 7.611 17 17-7.611 17-17 17zm7.5-22.5c0-.828-.672-1.5-1.5-1.5h-12c-.828 0-1.5.672-1.5 1.5s.672 1.5 1.5 1.5h12c.828 0 1.5-.672 1.5-1.5zm0 5c0-.828-.672-1.5-1.5-1.5h-12c-.828 0-1.5.672-1.5 1.5s.672 1.5 1.5 1.5h12c.828 0 1.5-.672 1.5-1.5zm0 5c0-.828-.672-1.5-1.5-1.5h-12c-.828 0-1.5.672-1.5 1.5s.672 1.5 1.5 1.5h12c.828 0 1.5-.672 1.5-1.5z" opacity=".2"/>
                <path d="M26.4 15.5c-.2-1.2-1.3-2.2-2.7-2.2h-7.4c-1.4 0-2.5 1.1-2.5 2.5 0 .2 0 .4.1.5l1.6 6.8c.2 1.2 1.3 2.2 2.7 2.2h7.4c1.4 0 2.5-1.1 2.5-2.5 0-.2 0-.4-.1-.5l-1.6-6.8z" fill="none" stroke="currentColor" strokeWidth="2.5"/>
              </svg>
            </div>
            <div>
              <CardTitle className="text-xl">Stripe Payouts</CardTitle>
              <CardDescription className="text-sm">Route invoice payments to your bank account</CardDescription>
            </div>
          </div>
          <Badge 
            variant={isReady ? "default" : "outline"}
            className={cn(
              "px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wider",
              isReady ? "bg-emerald-500/10 text-emerald-600 border-emerald-500/20 hover:bg-emerald-500/20" : ""
            )}
          >
            {isReady ? <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" /> : <AlertCircle className="mr-1.5 h-3.5 w-3.5" />}
            {statusLabel(connection)}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="space-y-6">
        {!connection ? (
          <div className="space-y-6">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="rounded-xl border border-border/50 bg-muted/30 p-4 transition-colors hover:bg-muted/50">
                <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <CheckCircle2 className="h-4 w-4" />
                </div>
                <h4 className="text-sm font-semibold">Automatic Payments</h4>
                <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                  Collect Card and ACH payments directly on your invoices.
                </p>
              </div>
              <div className="rounded-xl border border-border/50 bg-muted/30 p-4 transition-colors hover:bg-muted/50">
                <div className="mb-2 flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 text-primary">
                  <RefreshCw className="h-4 w-4" />
                </div>
                <h4 className="text-sm font-semibold">Direct Payouts</h4>
                <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                  Funds route directly to your bank account via Stripe.
                </p>
              </div>
            </div>
            
            <div className="flex items-center gap-4 pt-2">
              <Button onClick={handleStartOnboarding} disabled={!canManage || isStarting} className="h-11 px-8 font-medium bg-[#635BFF] hover:bg-[#5249db]">
                {isStarting ? "Starting..." : "Connect Stripe Account"}
              </Button>
              {!canManage && (
                <p className="text-xs text-muted-foreground italic">
                  * Org admin access required
                </p>
              )}
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/[0.03] p-5">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-xs font-medium uppercase tracking-wider text-emerald-600/80">Account Status</p>
                  <p className="mt-1 text-sm font-medium text-foreground">
                    {isReady ? "Payments and payouts are fully enabled." : "Account requires attention to enable payments."}
                  </p>
                </div>
                {connection.dashboard_type === "express" && (
                  <Button variant="ghost" size="sm" onClick={handleOpenDashboard} disabled={isOpeningDashboard} className="text-emerald-600 hover:bg-emerald-500/10 hover:text-emerald-700">
                    <ArrowUpRight className="mr-2 h-4 w-4" />
                    Stripe Dashboard
                  </Button>
                )}
              </div>
            </div>

            {currentlyDue.length > 0 && (
              <div className="rounded-xl border border-amber-500/20 bg-amber-500/[0.03] p-5">
                <div className="flex items-start gap-3">
                  <AlertCircle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" />
                  <div>
                    <h5 className="text-sm font-semibold text-amber-900">Missing Information</h5>
                    <p className="mt-1 text-sm text-amber-800/80 leading-relaxed">
                      Stripe needs more details before online payments are fully active.
                    </p>
                    <ul className="mt-3 space-y-1.5">
                      {currentlyDue.slice(0, 3).map((item) => (
                        <li key={item} className="flex items-center gap-2 text-xs text-amber-800/70 capitalize">
                          <div className="h-1.5 w-1.5 rounded-full bg-amber-400" />
                          {item.replaceAll("_", " ")}
                        </li>
                      ))}
                      {currentlyDue.length > 3 && (
                        <li className="text-xs text-amber-800/50 pl-3.5">+ {currentlyDue.length - 3} more items</li>
                      )}
                    </ul>
                  </div>
                </div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-3 pt-2">
              <Button onClick={handleStartOnboarding} disabled={!canManage || isStarting} variant={isReady ? "outline" : "default"} className={cn("h-10 px-6", !isReady && "bg-[#635BFF] hover:bg-[#5249db]")}>
                {connection.status === "active"
                  ? "Update Details"
                  : isStarting
                    ? "Opening..."
                    : "Resume Onboarding"}
              </Button>
              <Button variant="ghost" size="sm" onClick={handleRefresh} disabled={!canManage || isRefreshing} className="text-muted-foreground hover:text-foreground">
                <RefreshCw className={cn("mr-2 h-4 w-4", isRefreshing && "animate-spin")} />
                Sync Status
              </Button>
              
              <div className="ml-auto">
                <Button 
                  variant="ghost" 
                  size="sm" 
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="text-[10px] uppercase tracking-widest text-muted-foreground/60 hover:text-muted-foreground"
                >
                  {showAdvanced ? "Hide Details" : "Show Details"}
                </Button>
              </div>
            </div>

            {showAdvanced && (
              <div className="mt-4 rounded-lg bg-muted/40 p-4 font-mono text-[10px] text-muted-foreground/80 space-y-1 border border-border/40">
                <div className="flex justify-between">
                  <span>ACCOUNT ID</span>
                  <span className="text-foreground">{connection.stripe_account_id}</span>
                </div>
                <div className="flex justify-between">
                  <span>CHARGES ENABLED</span>
                  <span className={connection.charges_enabled ? "text-emerald-600" : "text-amber-600"}>
                    {connection.charges_enabled ? "YES" : "NO"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span>PAYOUTS ENABLED</span>
                  <span className={connection.payouts_enabled ? "text-emerald-600" : "text-amber-600"}>
                    {connection.payouts_enabled ? "YES" : "NO"}
                  </span>
                </div>
                {connection.disabled_reason && (
                  <div className="flex justify-between border-t border-border/40 pt-1 mt-1">
                    <span>REASON</span>
                    <span className="text-destructive uppercase">{connection.disabled_reason}</span>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {error && (
          <div className="rounded-lg border border-destructive/20 bg-destructive/[0.03] p-3 text-xs text-destructive">
            {error}
          </div>
        )}
      </CardContent>
    </Card>
  )
}

