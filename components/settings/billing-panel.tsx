"use client"

import { type CSSProperties, useCallback, useEffect, useState, useTransition } from "react"

import { AlertTriangle, ArrowUpRight, Clock, ExternalLink, Shield } from "@/components/icons"
import { ArcMark } from "@/components/brand/arc-mark"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { InfoRow, SettingsError, SettingsGroup } from "@/components/settings/settings-section"
import {
  createBillingPortalSessionAction,
  createCheckoutSessionAction,
  getBillingPageDataAction,
} from "@/app/(app)/settings/actions"
import { unwrapAction } from "@/lib/action-result"
import {
  PRODUCT_TIER_BRAND_NAMES,
  normalizeProductTier,
  type ProductTier,
} from "@/lib/product-tier"
import { cn } from "@/lib/utils"

type BillingPayload = Awaited<ReturnType<typeof getBillingPageDataAction>>
type Billing = NonNullable<BillingPayload["billing"]>

const containerClass = "mx-auto w-full max-w-3xl space-y-8 px-5 py-6 lg:px-8 lg:py-8"

// The tier accent as an rgb triplet, referenced through a local --tier var so a
// single set on the root feeds `rgb(var(--tier))`. Values live in globals.css.
const TIER_ACCENT_VAR: Record<ProductTier, string> = {
  residential: "var(--tier-residential)",
  commercial: "var(--tier-commercial)",
  production: "var(--tier-production)",
}

const STATUS_CHIP: Record<string, { label: string; className: string }> = {
  active: { label: "Active", className: "border-success/30 bg-success/10 text-success" },
  trialing: { label: "Trial", className: "border-primary/30 bg-primary/10 text-primary" },
  past_due: { label: "Past due", className: "border-destructive/30 bg-destructive/10 text-destructive" },
  unpaid: { label: "Unpaid", className: "border-destructive/30 bg-destructive/10 text-destructive" },
  incomplete: { label: "Incomplete", className: "border-warning/30 bg-warning/10 text-warning" },
  incomplete_expired: { label: "Expired", className: "border-border bg-muted/40 text-muted-foreground" },
  paused: { label: "Paused", className: "border-warning/30 bg-warning/10 text-warning" },
  canceled: { label: "Canceled", className: "border-border bg-muted/40 text-muted-foreground" },
}

function titleCase(value: string) {
  return value
    .split("_")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ")
}

function statusChip(status: string | null | undefined) {
  if (!status) return { label: "Not active", className: "border-border bg-muted/40 text-muted-foreground" }
  return STATUS_CHIP[status] ?? { label: titleCase(status), className: "border-border bg-muted/40 text-muted-foreground" }
}

function formatMoney(cents: number, currency: string | null | undefined) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: (currency ?? "USD").toUpperCase(),
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(cents / 100)
}

function intervalSuffix(interval: string | null | undefined) {
  if (interval === "monthly" || interval === "month") return "/mo"
  if (interval === "yearly" || interval === "year" || interval === "annual") return "/yr"
  return interval ? `/${interval}` : ""
}

function intervalWord(interval: string | null | undefined) {
  if (interval === "monthly" || interval === "month") return "monthly"
  if (interval === "yearly" || interval === "year" || interval === "annual") return "annually"
  return interval ?? "monthly"
}

function formatDate(value: string | null | undefined) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  return date.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" })
}

function daysUntil(value: string | null | undefined) {
  if (!value) return null
  const time = new Date(value).getTime()
  if (Number.isNaN(time)) return null
  return Math.max(0, Math.ceil((time - Date.now()) / 86_400_000))
}

function StatusChip({ status }: { status: string | null | undefined }) {
  const { label, className } = statusChip(status)
  return (
    <span
      className={cn(
        "inline-flex items-center border px-2 py-0.5 text-[11px] font-semibold uppercase tracking-[0.08em]",
        className,
      )}
    >
      {label}
    </span>
  )
}

export function BillingPanel({ canManageBilling }: { canManageBilling: boolean }) {
  const [billing, setBilling] = useState<Billing | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [checkoutPending, startCheckout] = useTransition()
  const [portalPending, startPortal] = useTransition()

  const load = useCallback(() => {
    if (!canManageBilling) {
      setLoading(false)
      return
    }
    setLoading(true)
    setError(null)
    getBillingPageDataAction()
      .then((data) => setBilling(data?.billing ?? null))
      .catch((cause) => {
        console.error("Failed to load billing details", cause)
        setError("We couldn't load your billing details right now.")
      })
      .finally(() => setLoading(false))
  }, [canManageBilling])

  useEffect(() => {
    load()
  }, [load])

  const handleCheckout = (planCode: string | null) => {
    if (!planCode) return
    setActionError(null)
    startCheckout(async () => {
      try {
        const { url } = unwrapAction(await createCheckoutSessionAction(planCode))
        if (url) window.location.href = url
        else setActionError("Unable to start checkout. Please try again.")
      } catch (cause) {
        setActionError(cause instanceof Error ? cause.message : "Unable to start checkout.")
      }
    })
  }

  const handlePortal = () => {
    setActionError(null)
    startPortal(async () => {
      try {
        const { url } = unwrapAction(await createBillingPortalSessionAction())
        if (url) window.location.href = url
        else setActionError("Unable to open the billing portal.")
      } catch (cause) {
        setActionError(cause instanceof Error ? cause.message : "Unable to open the billing portal.")
      }
    })
  }

  if (!canManageBilling) {
    return (
      <div className={containerClass}>
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <Shield className="size-9 text-muted-foreground/40" />
          <p className="mt-4 max-w-sm text-sm text-muted-foreground">
            You don&apos;t have permission to view billing for this organization.
          </p>
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className={containerClass}>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3.5">
            <Skeleton className="size-11 rounded-none" />
            <div className="space-y-2">
              <Skeleton className="h-4 w-40" />
              <Skeleton className="h-3 w-56" />
            </div>
          </div>
          <div className="flex flex-col items-end gap-2">
            <Skeleton className="h-6 w-24" />
            <Skeleton className="h-4 w-16" />
          </div>
        </div>
        <div className="space-y-3">
          <Skeleton className="h-3 w-24" />
          {Array.from({ length: 4 }).map((_, index) => (
            <Skeleton key={index} className="h-9 w-full rounded-none" />
          ))}
        </div>
      </div>
    )
  }

  if (error) {
    return (
      <div className={containerClass}>
        <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
          <p className="max-w-sm text-sm text-destructive">{error}</p>
          <Button size="sm" variant="outline" onClick={load}>
            Try again
          </Button>
        </div>
      </div>
    )
  }

  const org = billing?.org ?? null
  const subscription = billing?.subscription ?? null
  const plan = billing?.plan ?? null

  const tier = normalizeProductTier(org?.product_tier)
  const productName = PRODUCT_TIER_BRAND_NAMES[tier]

  const status = subscription?.status ?? null
  const isActive = status === "active"
  const isTrialing = status === "trialing"
  const isPastDue = status === "past_due" || status === "unpaid"
  const isCanceled = status === "canceled"
  const needsActivation = !isActive && !isTrialing && !isPastDue

  const isInvoiced = subscription?.collection_method === "invoice"
  const netDays = subscription?.net_days ?? null
  const hasStripeCustomer = Boolean(subscription?.external_customer_id)

  const amountCents = plan?.amount_cents ?? null
  const currency = plan?.currency ?? "USD"
  const interval = plan?.interval ?? "monthly"
  const planLabel = plan?.name ?? productName
  const resolvedPlanCode = subscription?.plan_code ?? org?.billing_model ?? null
  const billingEmail = org?.billing_email ?? null

  const trialEnds = formatDate(subscription?.trial_ends_at)
  const trialDays = daysUntil(subscription?.trial_ends_at)
  const cancelDate = formatDate(subscription?.cancel_at)
  const periodEnd = formatDate(subscription?.current_period_end)

  const manageButton = hasStripeCustomer ? (
    <Button
      size="sm"
      variant="outline"
      className="gap-1.5"
      onClick={handlePortal}
      disabled={portalPending}
    >
      {portalPending ? "Opening…" : "Manage in Stripe"}
      <ExternalLink className="size-3.5" />
    </Button>
  ) : undefined

  return (
    <div className={containerClass} style={{ "--tier": TIER_ACCENT_VAR[tier] } as CSSProperties}>
      {/* Identity: the product an org runs, carried in its own brand key — the
          one place tier color appears; everything below stays neutral. Price and
          status live in the Subscription group, so they're not repeated here. */}
      <div className="flex min-w-0 items-center gap-3.5">
        <ArcMark tier={tier} className="h-11 w-12" />
        <h2 className="min-w-0 truncate text-base font-semibold leading-6 text-[rgb(var(--tier))]">
          {productName}
        </h2>
      </div>

      {/* Attention states — shown only when action is needed. */}
      {isTrialing && trialEnds ? (
        <div className="flex items-start gap-3 border border-border bg-muted/20 px-4 py-3 text-sm">
          <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-foreground">
              {trialDays === 0 ? "Your trial ends today" : `Your trial ends in ${trialDays} day${trialDays === 1 ? "" : "s"}`}
            </p>
            <p className="mt-0.5 text-muted-foreground">
              Add a payment method to keep {productName} active after {trialEnds}.
            </p>
          </div>
          {!isInvoiced ? (
            <Button size="sm" className="shrink-0 self-center" onClick={() => handleCheckout(resolvedPlanCode)} disabled={checkoutPending || !resolvedPlanCode}>
              {checkoutPending ? "Opening…" : "Add payment method"}
            </Button>
          ) : null}
        </div>
      ) : null}

      {isPastDue ? (
        <div className="flex items-start gap-3 border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm">
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
          <div className="min-w-0 flex-1">
            <p className="font-medium text-foreground">Payment past due</p>
            <p className="mt-0.5 text-muted-foreground">Update your billing details to keep {productName} active.</p>
          </div>
          {manageButton ? (
            <Button size="sm" variant="outline" className="shrink-0 self-center" onClick={handlePortal} disabled={portalPending}>
              {portalPending ? "Opening…" : "Update payment"}
            </Button>
          ) : null}
        </div>
      ) : null}

      {actionError ? (
        <div className="border border-destructive/30 bg-destructive/5 px-4 py-3 text-sm text-destructive">{actionError}</div>
      ) : null}

      {/* Activation — one assigned plan, no picker. Arc sets the price; the org
          activates it. Invoice-billed orgs settle off-platform instead. */}
      {needsActivation && !isInvoiced ? (
        <div className="flex flex-wrap items-center justify-between gap-4 border border-border bg-muted/20 px-4 py-4">
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">
              {isCanceled ? "Reactivate your subscription" : "Activate your subscription"}
            </p>
            <p className="mt-0.5 text-sm text-muted-foreground">
              {amountCents != null
                ? `Start ${productName} at ${formatMoney(amountCents, currency)}${intervalSuffix(interval)}. Secure checkout via Stripe.`
                : `Start ${productName}. Secure checkout via Stripe.`}
            </p>
          </div>
          <Button
            className="shrink-0 gap-1.5"
            onClick={() => handleCheckout(resolvedPlanCode)}
            disabled={checkoutPending || !resolvedPlanCode}
          >
            {checkoutPending ? "Redirecting…" : isCanceled ? "Reactivate" : "Activate subscription"}
            <ArrowUpRight className="size-4" />
          </Button>
        </div>
      ) : null}

      {needsActivation && isInvoiced ? (
        <div className="border border-border bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
          Your organization is billed by invoice{netDays != null ? ` (Net ${netDays})` : ""}. Contact Arc to activate or change your subscription.
        </div>
      ) : null}

      <SettingsGroup title="Subscription">
        <InfoRow label="Plan">{planLabel}</InfoRow>
        <InfoRow label="Price">
          {amountCents != null ? (
            <span className="tabular-nums">
              {formatMoney(amountCents, currency)} <span className="text-muted-foreground">· billed {intervalWord(interval)}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">Custom pricing</span>
          )}
        </InfoRow>
        <InfoRow label="Status">
          <StatusChip status={status} />
        </InfoRow>
        {cancelDate ? (
          <InfoRow label="Cancels on" hint="Access continues until this date.">
            <span className="tabular-nums">{cancelDate}</span>
          </InfoRow>
        ) : isTrialing && trialEnds ? (
          <InfoRow label="Trial ends">
            <span className="tabular-nums">{trialEnds}</span>
          </InfoRow>
        ) : periodEnd && (isActive || isPastDue) ? (
          <InfoRow label={isInvoiced ? "Next invoice" : "Next payment"}>
            <span className="tabular-nums">{periodEnd}</span>
          </InfoRow>
        ) : null}
      </SettingsGroup>

      <SettingsGroup title="Payment" action={isInvoiced ? undefined : manageButton}>
        <InfoRow label="Billing email" hint="Where receipts and invoices are sent.">
          {billingEmail ? billingEmail : <span className="text-muted-foreground">Not set — add one in Organization settings.</span>}
        </InfoRow>
        <InfoRow label="Payment method">
          {isInvoiced ? (
            <span>Invoiced{netDays != null ? ` · Net ${netDays}` : ""}</span>
          ) : hasStripeCustomer ? (
            <span>Card on file · managed in Stripe</span>
          ) : (
            <span className="text-muted-foreground">No payment method on file yet.</span>
          )}
        </InfoRow>
      </SettingsGroup>

      {billingEmail === null && !isInvoiced ? <SettingsError>Add a billing email so receipts reach the right place.</SettingsError> : null}

      <p className="text-xs leading-5 text-muted-foreground">
        {isInvoiced
          ? "Your organization is billed by invoice. Contact Arc for changes to your plan."
          : hasStripeCustomer
            ? "Manage payment methods, download invoices, and update billing details in the Stripe portal."
            : "Payments are processed securely by Stripe."}
      </p>
    </div>
  )
}
