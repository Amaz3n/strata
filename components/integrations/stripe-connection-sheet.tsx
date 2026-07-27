"use client"

import { useState, useTransition } from "react"
import { ArrowUpRight, RefreshCcw } from "lucide-react"
import { toast } from "sonner"

import {
  createStripeConnectedAccountOnboardingLinkAction,
  createStripeDashboardLoginLinkAction,
  refreshStripeConnectedAccountAction,
} from "@/app/(app)/settings/integrations/actions"
import { unwrapAction, type ActionResult } from "@/lib/action-result"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import type { StripeConnectedAccount } from "@/lib/services/stripe-connected-accounts"
import { ConnectionStatusBadge, type ConnectionTone } from "@/components/integrations/connection-status"

interface Props {
  connection: StripeConnectedAccount | null
  open: boolean
  onOpenChange: (open: boolean) => void
  canManage: boolean
  onChanged: (connection: StripeConnectedAccount | null) => void
}

/**
 * Stripe accounts onboarded before Arc moved fee and loss responsibility to the
 * connected account must be reconnected before they can take invoice payments.
 */
export function hasProtectedStripeResponsibility(connection: StripeConnectedAccount | null): boolean {
  const responsibilities = connection?.metadata?.stripe_responsibilities as Record<string, unknown> | undefined
  return responsibilities?.fees_payer === "account" && responsibilities?.losses_payments === "stripe"
}

export function stripeStatus(connection: StripeConnectedAccount | null): { tone: ConnectionTone; label: string } {
  if (!connection) return { tone: "idle", label: "Not connected" }
  if (connection.charges_enabled && connection.payouts_enabled && !hasProtectedStripeResponsibility(connection)) {
    return { tone: "warn", label: "Reconnect required" }
  }
  switch (connection.status) {
    case "active":
      return { tone: "ok", label: "Ready" }
    case "onboarding":
      return { tone: "warn", label: "Onboarding" }
    case "restricted":
      return { tone: "warn", label: "Needs attention" }
    case "error":
      return { tone: "error", label: "Error" }
    case "disconnected":
      return { tone: "idle", label: "Disconnected" }
    default:
      return { tone: "idle", label: "Pending" }
  }
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="truncate text-xs tabular-nums">{value}</span>
    </div>
  )
}

export function StripeConnectionSheet({ connection, open, onOpenChange, canManage, onChanged }: Props) {
  const [isStarting, startOnboarding] = useTransition()
  const [isRefreshing, startRefreshing] = useTransition()
  const [isOpeningDashboard, startDashboard] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const status = stripeStatus(connection)
  const currentlyDue = connection?.requirements_currently_due ?? []
  const needsReconnect = Boolean(connection) && !hasProtectedStripeResponsibility(connection)

  const openHostedFlow = (create: () => Promise<ActionResult<{ url: string }>>, failure: string) => {
    setError(null)
    return async () => {
      try {
        const { url } = unwrapAction(await create())
        if (url) {
          window.location.href = url
          return
        }
        setError(failure)
      } catch (err) {
        setError(err instanceof Error ? err.message : failure)
      }
    }
  }

  const handleOnboarding = () =>
    startOnboarding(openHostedFlow(createStripeConnectedAccountOnboardingLinkAction, "Unable to start Stripe onboarding."))

  const handleDashboard = () => startDashboard(openHostedFlow(createStripeDashboardLoginLinkAction, "Unable to open the Stripe dashboard."))

  const handleRefresh = () =>
    startRefreshing(async () => {
      setError(null)
      try {
        onChanged(unwrapAction(await refreshStripeConnectedAccountAction()))
        toast.success("Stripe status refreshed")
      } catch (err) {
        setError(err instanceof Error ? err.message : "Unable to refresh Stripe status.")
      }
    })

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="flex flex-col gap-0 p-0 sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] sm:max-w-lg"
      >
        <SheetHeader className="space-y-0 border-b border-border px-5 py-4">
          <div className="flex items-start gap-3">
            <div className="flex size-9 shrink-0 items-center justify-center border border-border bg-background p-1.5">
              <img src="/stripe.svg" alt="" className="size-full object-contain" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5">
                <SheetTitle className="truncate text-sm font-medium">Stripe</SheetTitle>
                <ConnectionStatusBadge tone={status.tone} label={status.label} />
              </div>
              <SheetDescription className="mt-0.5 text-xs">Card and ACH payments on client invoices.</SheetDescription>
            </div>
          </div>
        </SheetHeader>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="space-y-6 px-5 py-5">
            {connection ? (
              <div className="divide-y divide-border">
                <Fact label="Account" value={connection.stripe_account_id} />
                <Fact label="Charges" value={connection.charges_enabled ? "Enabled" : "Pending"} />
                <Fact label="Payouts" value={connection.payouts_enabled ? "Enabled" : "Pending"} />
                {connection.dashboard_type ? <Fact label="Dashboard" value={connection.dashboard_type} /> : null}
                {connection.disabled_reason ? <Fact label="Disabled reason" value={connection.disabled_reason} /> : null}
              </div>
            ) : (
              <p className="text-sm text-muted-foreground">
                Connect Stripe to let clients pay invoices by card or bank transfer. Payouts land in your own bank account; Arc never
                holds the funds.
              </p>
            )}

            {needsReconnect ? (
              <div className="border border-warning/20 bg-warning/[0.06] p-3">
                <p className="text-xs font-medium text-warning">Reconnect required</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  This account was onboarded with platform-side fee or loss responsibility. Reconnect before accepting invoice
                  payments.
                </p>
              </div>
            ) : null}

            {currentlyDue.length > 0 ? (
              <div className="border border-border bg-muted/30 p-3">
                <p className="text-xs font-medium">Stripe needs more information</p>
                <ul className="mt-2 space-y-0.5">
                  {currentlyDue.slice(0, 4).map((item) => (
                    <li key={item} className="text-xs capitalize text-muted-foreground">
                      {item.replaceAll("_", " ").replaceAll(".", " · ")}
                    </li>
                  ))}
                  {currentlyDue.length > 4 ? (
                    <li className="text-xs text-muted-foreground">+ {currentlyDue.length - 4} more</li>
                  ) : null}
                </ul>
              </div>
            ) : null}

            {error ? <div className="border border-destructive/20 bg-destructive/[0.04] p-3 text-xs text-destructive">{error}</div> : null}

            {!canManage ? <p className="text-xs text-muted-foreground">Organization admin access is required to change this connection.</p> : null}
          </div>
        </div>

        <div className="flex shrink-0 flex-wrap items-center gap-2 border-t border-border px-5 py-3">
          <Button size="sm" disabled={!canManage || isStarting} onClick={handleOnboarding}>
            {isStarting ? "Opening…" : !connection ? "Connect Stripe" : connection.status === "active" ? "Update details" : "Resume onboarding"}
          </Button>
          {connection ? (
            <>
              <Button size="sm" variant="outline" disabled={!canManage || isRefreshing} onClick={handleRefresh}>
                <RefreshCcw className="mr-1.5 size-3.5" />
                {isRefreshing ? "Refreshing…" : "Refresh"}
              </Button>
              {connection.dashboard_type === "express" ? (
                <Button size="sm" variant="ghost" disabled={isOpeningDashboard} onClick={handleDashboard}>
                  Stripe dashboard
                  <ArrowUpRight className="ml-1 size-3.5" />
                </Button>
              ) : null}
            </>
          ) : null}
        </div>
      </SheetContent>
    </Sheet>
  )
}
