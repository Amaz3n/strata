"use client"

import { useEffect, useMemo, useRef, useState, useTransition } from "react"
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js"
import { loadStripe } from "@stripe/stripe-js"
import { useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"

import {
  completeOrgFundingSetupAction,
  createOrgFundingSetupAction,
  decidePaymentControlChangeAction,
  updatePaymentRailPolicyAction,
} from "@/app/(app)/settings/payment-actions"
import { Building2, CheckCircle2, Circle, Clock, KeyRound, Lock, ShieldCheck, Users } from "@/components/icons"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { PaymentApproversGroup } from "@/components/settings/payment-approvers-group"
import { SettingsError, SettingsField, SettingsGroup, SettingsToggle } from "@/components/settings/settings-section"
import { unwrapAction } from "@/lib/action-result"
import type { PaymentRailSettings } from "@/lib/services/payment-rail-setup"
import { cn } from "@/lib/utils"

const COOLING_OPTIONS = [
  { value: "24", label: "24 hours" },
  { value: "48", label: "2 days" },
  { value: "72", label: "3 days (recommended)" },
  { value: "168", label: "7 days" },
]

function dollarsToCents(value: string) {
  const normalized = value.trim().replaceAll(",", "").replace("$", "")
  if (!normalized) return null
  const dollars = Number(normalized)
  return Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : null
}

function centsToDollars(value: number | null) {
  return value == null ? "" : (value / 100).toFixed(2)
}

/** A cap the user typed that we cannot turn into a positive amount. */
function isUnparseableCap(value: string) {
  return value.trim().length > 0 && dollarsToCents(value) == null
}

/**
 * Timestamps render date-only on the server and in the first client paint, then
 * upgrade to the reader's local time. Formatting a UTC instant during SSR would
 * hydrate against a different timezone.
 */
function LocalTime({ iso }: { iso: string }) {
  const [text, setText] = useState(() => iso.slice(0, 10))
  useEffect(() => {
    setText(new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }))
  }, [iso])
  return <>{text}</>
}

function fundingLabel(source: { bankName: string | null; last4: string | null }) {
  return `${source.bankName ?? "Bank account"}${source.last4 ? ` •••• ${source.last4}` : ""}`
}

function BankSetupForm({
  providerSetupId,
  coolingHours,
  onComplete,
  onCancel,
}: {
  providerSetupId: string
  coolingHours: number
  onComplete: (applyAfter: string) => void
  onCancel: () => void
}) {
  const stripe = useStripe()
  const elements = useElements()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!stripe || !elements || pending) return
    setPending(true)
    setError(null)
    const result = await stripe.confirmSetup({
      elements,
      confirmParams: { return_url: `${window.location.origin}/settings?tab=payments` },
      redirect: "if_required",
    })
    if (result.error) {
      setError(result.error.message ?? "Unable to verify the bank account")
      setPending(false)
      return
    }
    try {
      const completed = unwrapAction(await completeOrgFundingSetupAction(providerSetupId))
      onComplete(completed.applyAfter)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save the bank account")
      setPending(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-5">
      <PaymentElement options={{ layout: "tabs" }} />
      {error ? <SettingsError>{error}</SettingsError> : null}
      <div className="border-t border-border pt-4 text-xs leading-5 text-muted-foreground">
        <p className="flex items-start gap-2">
          <Users className="mt-0.5 size-3.5 shrink-0" />
          Two people have to approve this bank before it can fund anything, and you cannot approve your own.
        </p>
        <p className="mt-2 flex items-start gap-2">
          <Clock className="mt-0.5 size-3.5 shrink-0" />
          After the second approval it waits {COOLING_OPTIONS.find((option) => option.value === String(coolingHours))?.label ?? `${coolingHours} hours`} before it can be used.
        </p>
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onCancel} disabled={pending}>Cancel</Button>
        <Button type="submit" disabled={!stripe || pending}>{pending ? "Verifying…" : "Verify bank account"}</Button>
      </DialogFooter>
    </form>
  )
}

/**
 * The screen an org sees before it has ever saved payment settings. It asks for
 * one decision instead of a form: the caps, approvers, and cooling period all
 * have safe defaults and are tuned afterwards.
 */
function PaymentIntro({
  canManage,
  pending,
  onStart,
  error,
}: {
  canManage: boolean
  pending: boolean
  onStart: () => void
  error: string | null
}) {
  return (
    <div className="mx-auto w-full max-w-2xl px-5 py-12 lg:px-8">
      <div className="border-l-2 border-primary pl-4">
        <p className="microlabel">Vendor payments</p>
        <h2 className="mt-2 text-xl font-semibold tracking-tight">Pay your subs from Arc.</h2>
        <p className="mt-2 text-sm leading-6 text-muted-foreground">
          Arc already knows which bills are approved, released, and clear of holds. Turning this on lets you pay
          those bills by ACH instead of cutting checks — with the same approvals you already run.
        </p>
      </div>

      <div className="mt-8 divide-y divide-border border-t border-border">
        <div className="flex items-start gap-3 py-4">
          <Building2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">You connect one funding bank</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Account details go straight to Stripe. Arc stores a reference and the last four digits — never your account or routing number.
            </p>
          </div>
        </div>
        <div className="flex items-start gap-3 py-4">
          <Users className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">Your subs set up their own payout account</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              A Payments section appears in their sub portal as soon as you finish here. You never handle, see, or edit a vendor&apos;s bank details.
            </p>
          </div>
        </div>
        <div className="flex items-start gap-3 py-4">
          <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <div>
            <p className="text-sm font-medium">Nobody pays a run they prepared</p>
            <p className="mt-1 text-xs leading-5 text-muted-foreground">
              Every run needs an approver other than the person who built it, and every bank change needs two.
            </p>
          </div>
        </div>
      </div>

      {error ? <SettingsError className="mt-6">{error}</SettingsError> : null}

      {canManage ? (
        <div className="mt-8">
          <Button onClick={onStart} disabled={pending}>{pending ? "Setting up…" : "Set up vendor payments"}</Button>
          <p className="mt-3 text-xs leading-5 text-muted-foreground">
            No money moves yet. You pick limits and approvers next, and switching payments on is a separate step.
          </p>
        </div>
      ) : (
        <div className="mt-8 flex items-start gap-2 text-xs leading-5 text-muted-foreground">
          <Lock className="mt-0.5 size-3.5 shrink-0" />
          Setting up vendor payments needs the payment-administration permission. Ask an organization admin to start it.
        </div>
      )}
    </div>
  )
}

function Step({
  state,
  title,
  detail,
  action,
}: {
  state: "done" | "current" | "waiting"
  title: string
  detail: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-4 py-4">
      <div className="flex min-w-0 items-start gap-3">
        {state === "done" ? (
          <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-success" />
        ) : (
          <Circle className={cn("mt-0.5 size-4 shrink-0", state === "current" ? "fill-current text-primary" : "text-muted-foreground/50")} />
        )}
        <div className="min-w-0">
          <p className={cn("text-sm leading-5", state === "waiting" ? "text-muted-foreground" : "font-medium text-foreground")}>{title}</p>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">{detail}</p>
        </div>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  )
}

export function PaymentRailPanel({
  initialSettings,
  publishableKey,
}: {
  initialSettings: PaymentRailSettings | null
  publishableKey: string | null
}) {
  const router = useRouter()
  const searchParams = useSearchParams()
  const completedRedirectRef = useRef<string | null>(null)
  const [pending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [setup, setSetup] = useState<{ providerSetupId: string; clientSecret: string } | null>(null)
  const [rejecting, setRejecting] = useState<{ id: string; label: string } | null>(null)
  const [rejectReason, setRejectReason] = useState("")
  const settings = initialSettings
  const [coolingHours, setCoolingHours] = useState(String(settings?.policy.coolingHours ?? 72))
  const [perPayment, setPerPayment] = useState(centsToDollars(settings?.policy.perPaymentLimitCents ?? null))
  const [perRun, setPerRun] = useState(centsToDollars(settings?.policy.perRunLimitCents ?? null))
  const [daily, setDaily] = useState(centsToDollars(settings?.policy.dailyLimitCents ?? null))
  const stripePromise = useMemo(() => (publishableKey ? loadStripe(publishableKey) : null), [publishableKey])

  useEffect(() => {
    const providerSetupId = searchParams.get("setup_intent")
    if (!providerSetupId || completedRedirectRef.current === providerSetupId) return
    completedRedirectRef.current = providerSetupId
    startTransition(async () => {
      try {
        const completed = unwrapAction(await completeOrgFundingSetupAction(providerSetupId))
        toast.success("Bank sent for approval", {
          description: `Usable after ${new Date(completed.applyAfter).toLocaleString()}.`,
        })
        router.replace("/settings?tab=payments", { scroll: false })
        router.refresh()
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Unable to finish bank setup")
      }
    })
  }, [router, searchParams])

  const perform = (operation: () => Promise<{ success: boolean; error?: string }>, success: string, description?: string) => {
    setError(null)
    startTransition(async () => {
      const result = await operation()
      if (!result.success) {
        setError(result.error ?? "Unable to update payment settings")
        return
      }
      toast.success(success, description ? { description } : undefined)
      router.refresh()
    })
  }

  if (!settings) {
    return (
      <div className="mx-auto w-full max-w-2xl px-5 py-16 text-center lg:px-8">
        <Building2 className="mx-auto size-5 text-muted-foreground" />
        <p className="mt-3 text-sm font-medium">Vendor payments are unavailable</p>
        <p className="mx-auto mt-2 max-w-md text-xs leading-5 text-muted-foreground">
          This organization does not have the payment rail provisioned yet, or your role cannot view payment settings.
        </p>
      </div>
    )
  }

  const startPayments = () => perform(
    () => updatePaymentRailPolicyAction({ approval_mode: "dual", control_change_cooling_hours: 72 }),
    "Vendor payments set up",
    "Your subs can now start payout verification from their portal.",
  )

  if (!settings.policy.configured) {
    return <PaymentIntro canManage={settings.canManage} pending={pending} onStart={startPayments} error={error} />
  }

  const now = Date.now()
  const hasFunding = settings.fundingSources.length > 0
  const activeFunding = settings.fundingSources.find(
    (source) => source.status === "active" && (!source.usableAfter || new Date(source.usableAfter).getTime() <= now),
  )
  const pendingChange = settings.controlChanges[0] ?? null
  const decidableChanges = settings.controlChanges.filter((change) => change.status === "pending_approval" && change.canDecide)
  const enabled = settings.policy.enabled

  const policyDirty =
    Number(coolingHours) !== settings.policy.coolingHours ||
    dollarsToCents(perPayment) !== settings.policy.perPaymentLimitCents ||
    dollarsToCents(perRun) !== settings.policy.perRunLimitCents ||
    dollarsToCents(daily) !== settings.policy.dailyLimitCents

  const perPaymentCents = dollarsToCents(perPayment)
  const perRunCents = dollarsToCents(perRun)
  const capError = [perPayment, perRun, daily].some(isUnparseableCap)
    ? "Enter a cap as a dollar amount above zero, or clear it to allow any amount."
    : perPaymentCents && perRunCents && perRunCents < perPaymentCents
      ? "The run cap has to be at least as large as the single-payment cap."
      : null

  const savePolicy = () => {
    if (capError) return
    perform(() => updatePaymentRailPolicyAction({
      control_change_cooling_hours: Number(coolingHours),
      per_payment_limit_cents: perPaymentCents,
      per_run_limit_cents: perRunCents,
      daily_limit_cents: dollarsToCents(daily),
    }), "Payment controls saved")
  }

  const startBankSetup = () => {
    if (!publishableKey) {
      setError("Stripe is not configured for this environment yet.")
      return
    }
    setError(null)
    startTransition(async () => {
      try {
        setSetup(unwrapAction(await createOrgFundingSetupAction()))
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "Unable to start bank setup")
      }
    })
  }

  const submitRejection = () => {
    if (!rejecting || rejectReason.trim().length < 8) return
    const target = rejecting
    setRejecting(null)
    setRejectReason("")
    perform(
      () => decidePaymentControlChangeAction({ changeRequestId: target.id, decision: "rejected", reason: rejectReason.trim() }),
      "Bank change rejected",
    )
  }

  const fundingStep = hasFunding
    ? { state: "done" as const, detail: activeFunding ? `${fundingLabel(activeFunding)} is funding your payments.` : `${fundingLabel(settings.fundingSources[0])} is on file.` }
    : { state: "current" as const, detail: "Stripe collects the account details. Arc only keeps a reference and the last four digits." }

  const reviewStep = activeFunding
    ? { state: "done" as const, detail: "Approved and past its cooling period." }
    : !hasFunding
      ? { state: "waiting" as const, detail: "Starts once a bank is on file." }
      : pendingChange?.status === "cooling_off"
        ? { state: "current" as const, detail: <>Approved. It can fund payments after <LocalTime iso={pendingChange.applyAfter} />.</> }
        : pendingChange
          ? {
              state: "current" as const,
              detail: `Waiting on ${Math.max(pendingChange.requiredApprovals - pendingChange.approvalCount, 1)} more approval from someone other than whoever added the bank.`,
            }
          : { state: "current" as const, detail: "Waiting on review." }

  return (
    <div className="mx-auto w-full max-w-4xl space-y-10 px-5 py-8 lg:px-8 lg:py-10">
      {error ? <SettingsError>{error}</SettingsError> : null}

      <SettingsGroup title="Vendor payments">
        <SettingsToggle
          id="payments-enabled"
          label="Electronic vendor payments"
          description={enabled
            ? "Approved payment runs can debit your funding bank. Approvals and caps still apply to every run."
            : activeFunding
              ? "Off. Runs can be prepared but nothing debits your account until you switch this on."
              : "Available once a funding bank is approved and past its cooling period."}
          checked={enabled}
          disabled={!settings.canManage || pending || (!enabled && !activeFunding)}
          onCheckedChange={(next) => {
            if (!next && !window.confirm("Turn off electronic vendor payments? Runs in flight keep settling, but no new run can be created.")) return
            perform(
              () => updatePaymentRailPolicyAction({ enabled: next }),
              next ? "Electronic payments turned on" : "Electronic payments turned off",
            )
          }}
        />
        {!enabled ? (
          <>
            <Step
              state={fundingStep.state}
              title="Connect your funding bank"
              detail={fundingStep.detail}
              action={!hasFunding && settings.canManage ? (
                <Button size="sm" onClick={startBankSetup} disabled={pending}>Connect bank</Button>
              ) : null}
            />
            <Step
              state={reviewStep.state}
              title="Second approval and cooling period"
              detail={reviewStep.detail}
            />
          </>
        ) : null}
        {!settings.canManage ? (
          <div className="flex items-start gap-2 py-4 text-xs leading-5 text-muted-foreground">
            <Lock className="mt-0.5 size-3.5 shrink-0" />
            You can see how payments are configured but cannot change them.
          </div>
        ) : null}
      </SettingsGroup>

      {settings.controlChanges.length > 0 ? (
        <SettingsGroup
          title={decidableChanges.length > 0 ? "Waiting on you" : "Bank changes in review"}
          description="Every funding-bank change needs two approvals and a cooling period, whatever your payment-run policy says."
        >
          {settings.controlChanges.map((change) => (
            <div key={change.id} className="flex flex-wrap items-center justify-between gap-4 py-4">
              <div className="min-w-0">
                <p className="text-sm font-medium">{fundingLabel(change)}</p>
                <p className="mt-1 text-xs leading-5 text-muted-foreground">
                  {change.status === "cooling_off" ? (
                    <>Approved — usable after <LocalTime iso={change.applyAfter} />.</>
                  ) : (
                    <>{change.approvalCount} of {change.requiredApprovals} approvals. Cooling period starts once it clears.</>
                  )}
                </p>
              </div>
              {change.status === "pending_approval" && change.canDecide ? (
                <div className="flex items-center gap-2">
                  <Button size="sm" variant="ghost" disabled={pending} onClick={() => { setRejecting({ id: change.id, label: fundingLabel(change) }); setRejectReason("") }}>
                    Reject
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => perform(() => decidePaymentControlChangeAction({ changeRequestId: change.id, decision: "approved" }), "Bank approval recorded")}
                  >
                    Approve
                  </Button>
                </div>
              ) : change.status === "pending_approval" && !settings.canApprove ? (
                <p className="text-xs text-muted-foreground">Needs a payment approver</p>
              ) : change.status === "pending_approval" ? (
                <p className="text-xs text-muted-foreground">You added this bank</p>
              ) : null}
            </div>
          ))}
          {decidableChanges.length > 0 ? (
            <div className="flex items-start gap-2 py-4 text-xs leading-5 text-muted-foreground">
              <KeyRound className="mt-0.5 size-3.5 shrink-0" />
              Approving asks for a fresh two-factor check. If yours is older than ten minutes you will be asked to confirm it again.
            </div>
          ) : null}
        </SettingsGroup>
      ) : null}

      <SettingsGroup
        title="Funding bank"
        description="Account details stay with Stripe. Arc keeps a provider reference and the last four digits."
        action={hasFunding && settings.canManage ? (
          <Button size="sm" variant="outline" onClick={startBankSetup} disabled={pending}>Add bank</Button>
        ) : null}
      >
        {hasFunding ? (
          // One child so the group's own hairline divider never doubles up with
          // the default bank's own border.
          <div>
            {settings.fundingSources.map((source) => (
              <div
                key={source.id}
                className={cn(
                  "flex items-center justify-between gap-4",
                  source.isDefault
                    ? "my-3 border border-success bg-success/5 p-4 first:mt-0"
                    : "border-t border-border py-4 first:border-t-0",
                )}
              >
                <div className="flex min-w-0 items-center gap-3">
                  <Building2 className={cn("size-4 shrink-0", source.isDefault ? "text-success" : "text-muted-foreground")} />
                  <div className="min-w-0">
                    <p className="truncate text-sm font-medium">{fundingLabel(source)}</p>
                    <p className="mt-1 text-xs leading-5 text-muted-foreground">
                      {source.status === "active" && source.usableAfter && new Date(source.usableAfter).getTime() > now ? (
                        <>Approved — usable after <LocalTime iso={source.usableAfter} />.</>
                      ) : source.status === "active" ? (
                        source.isDefault ? "Funding your payments." : "Approved and available."
                      ) : source.status === "pending_approval" ? (
                        "Waiting on a second approval."
                      ) : source.status === "cooling_off" ? (
                        "Approved, finishing its cooling period."
                      ) : (
                        `${source.status.replaceAll("_", " ")} · ${source.verificationStatus.replaceAll("_", " ")}`
                      )}
                    </p>
                  </div>
                </div>
                {source.isDefault ? (
                  <span className="shrink-0 border border-success/40 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-success">
                    Default
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        ) : (
          <div className="flex items-center gap-3 py-5 text-sm text-muted-foreground">
            <Building2 className="size-4" /> No funding bank connected yet.
          </div>
        )}
      </SettingsGroup>

      <SettingsGroup
        title="Controls"
        description="These apply to every electronic payment run. Caps are checked when a run is built and again when it is submitted."
      >
        <SettingsField
          label="Bank-change cooling period"
          htmlFor="cooling-hours"
          hint="How long an approved funding-bank change waits before it can move money. This is your window to catch a fraudulent change."
        >
          <Select value={coolingHours} onValueChange={setCoolingHours} disabled={!settings.canManage}>
            <SelectTrigger id="cooling-hours" className="max-w-sm"><SelectValue /></SelectTrigger>
            <SelectContent>
              {COOLING_OPTIONS.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </SettingsField>

        <SettingsField label="Single payment cap" htmlFor="per-payment" hint="Blocks any one vendor payment above this amount.">
          <div className="flex max-w-sm items-center gap-2">
            <span className="text-sm text-muted-foreground">$</span>
            <Input id="per-payment" inputMode="decimal" placeholder="No cap" value={perPayment} onChange={(event) => setPerPayment(event.target.value)} disabled={!settings.canManage} className="tabular-nums" />
          </div>
        </SettingsField>

        <SettingsField label="Run cap" htmlFor="per-run" hint="Blocks a whole run, including fees, above this amount.">
          <div className="flex max-w-sm items-center gap-2">
            <span className="text-sm text-muted-foreground">$</span>
            <Input id="per-run" inputMode="decimal" placeholder="No cap" value={perRun} onChange={(event) => setPerRun(event.target.value)} disabled={!settings.canManage} className="tabular-nums" />
          </div>
        </SettingsField>

        <SettingsField label="Daily cap" htmlFor="daily-limit" hint="Blocks anything that would push a single day's total above this amount.">
          <div className="flex max-w-sm items-center gap-2">
            <span className="text-sm text-muted-foreground">$</span>
            <Input id="daily-limit" inputMode="decimal" placeholder="No cap" value={daily} onChange={(event) => setDaily(event.target.value)} disabled={!settings.canManage} className="tabular-nums" />
          </div>
        </SettingsField>

        {capError ? <SettingsError className="py-3">{capError}</SettingsError> : null}

        {settings.canManage ? (
          <div className="flex items-center justify-end gap-3 py-4">
            {policyDirty && !capError ? <span className="text-xs text-muted-foreground">Unsaved changes</span> : null}
            <Button onClick={savePolicy} disabled={pending || !policyDirty || Boolean(capError)}>Save controls</Button>
          </div>
        ) : null}
      </SettingsGroup>

      <PaymentApproversGroup
        approvers={settings.approvals.approvers}
        candidates={settings.approvals.candidates}
        approvalMode={settings.policy.approvalMode}
        canManage={settings.canManage}
      />

      <Dialog open={Boolean(setup)} onOpenChange={(open) => { if (!open) setSetup(null) }}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Connect a funding bank</DialogTitle>
            <DialogDescription>
              Arc never receives your account or routing number — Stripe collects and verifies them directly.
            </DialogDescription>
          </DialogHeader>
          {setup && stripePromise ? (
            <Elements stripe={stripePromise} options={{ clientSecret: setup.clientSecret }}>
              <BankSetupForm
                providerSetupId={setup.providerSetupId}
                coolingHours={settings.policy.coolingHours}
                onCancel={() => setSetup(null)}
                onComplete={(applyAfter) => {
                  setSetup(null)
                  toast.success("Bank sent for approval", { description: `Usable after ${new Date(applyAfter).toLocaleString()}.` })
                  router.refresh()
                }}
              />
            </Elements>
          ) : null}
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(rejecting)} onOpenChange={(open) => { if (!open) { setRejecting(null); setRejectReason("") } }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reject this bank change</DialogTitle>
            <DialogDescription>
              {rejecting?.label} will not be able to fund payments. The reason is recorded as approval evidence and cannot be edited later.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={rejectReason}
            onChange={(event) => setRejectReason(event.target.value)}
            placeholder="Why are you rejecting this bank?"
            rows={3}
            autoFocus
          />
          {rejectReason.trim().length > 0 && rejectReason.trim().length < 8 ? (
            <SettingsError>Give a reason of at least eight characters.</SettingsError>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => { setRejecting(null); setRejectReason("") }}>Cancel</Button>
            <Button variant="destructive" onClick={submitRejection} disabled={pending || rejectReason.trim().length < 8}>Reject bank</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
