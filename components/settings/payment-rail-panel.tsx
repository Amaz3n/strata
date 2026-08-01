"use client"

import { useEffect, useRef, useState, useTransition } from "react"
import { Elements, PaymentElement, useElements, useStripe } from "@stripe/react-stripe-js"
import { loadStripe } from "@stripe/stripe-js"
import { useRouter, useSearchParams } from "next/navigation"

import {
  completeOrgFundingSetupAction,
  createOrgFundingSetupAction,
  decidePaymentControlChangeAction,
  updatePaymentRailPolicyAction,
} from "@/app/(app)/settings/payment-actions"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { unwrapAction } from "@/lib/action-result"
import type { PaymentRailSettings } from "@/lib/services/payment-rail-setup"

function dollarsToCents(value: string) {
  const normalized = value.trim().replaceAll(",", "").replace("$", "")
  if (!normalized) return null
  const dollars = Number(normalized)
  return Number.isFinite(dollars) && dollars > 0 ? Math.round(dollars * 100) : null
}

function centsToDollars(value: number | null) {
  return value == null ? "" : (value / 100).toFixed(2)
}

function BankSetupForm({ providerSetupId, onComplete }: { providerSetupId: string; onComplete: (message: string) => void }) {
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
      onComplete(`Bank submitted for two-person approval. It becomes usable after ${new Date(completed.applyAfter).toLocaleString()}.`)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save the bank account")
      setPending(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4 border-t pt-4">
      <PaymentElement options={{ layout: "tabs" }} />
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <Button type="submit" disabled={!stripe || pending}>{pending ? "Verifying…" : "Verify bank account"}</Button>
    </form>
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
  const [message, setMessage] = useState<string | null>(null)
  const [setup, setSetup] = useState<{ providerSetupId: string; clientSecret: string } | null>(null)
  const settings = initialSettings
  const [enabled, setEnabled] = useState(settings?.policy.enabled ?? false)
  const [approvalMode, setApprovalMode] = useState<"sole" | "dual">(settings?.policy.approvalMode ?? "dual")
  const [coolingHours, setCoolingHours] = useState(String(settings?.policy.coolingHours ?? 72))
  const [perPayment, setPerPayment] = useState(centsToDollars(settings?.policy.perPaymentLimitCents ?? null))
  const [perRun, setPerRun] = useState(centsToDollars(settings?.policy.perRunLimitCents ?? null))
  const [daily, setDaily] = useState(centsToDollars(settings?.policy.dailyLimitCents ?? null))
  const stripePromise = publishableKey ? loadStripe(publishableKey) : null

  useEffect(() => {
    const providerSetupId = searchParams.get("setup_intent")
    if (!providerSetupId || completedRedirectRef.current === providerSetupId) return
    completedRedirectRef.current = providerSetupId
    startTransition(async () => {
      try {
        const completed = unwrapAction(await completeOrgFundingSetupAction(providerSetupId))
        setMessage(`Bank submitted for two-person approval. It becomes usable after ${new Date(completed.applyAfter).toLocaleString()}.`)
        router.replace("/settings?tab=payments", { scroll: false })
        router.refresh()
      } catch (cause) {
        setMessage(cause instanceof Error ? cause.message : "Unable to finish bank setup")
      }
    })
  }, [router, searchParams])

  const perform = (operation: () => Promise<{ success: boolean; error?: string }>, success: string) => {
    setMessage(null)
    startTransition(async () => {
      const result = await operation()
      if (!result.success) {
        setMessage(result.error ?? "Unable to update payment settings")
        return
      }
      setMessage(success)
      router.refresh()
    })
  }

  if (!settings) {
    return <div className="mx-auto w-full max-w-3xl px-5 py-10 text-sm text-muted-foreground">Payment setup is unavailable until the pending fintech migration is approved and applied.</div>
  }

  const savePolicy = () => perform(() => updatePaymentRailPolicyAction({
    enabled,
    approval_mode: approvalMode,
    control_change_cooling_hours: Number(coolingHours),
    per_payment_limit_cents: dollarsToCents(perPayment),
    per_run_limit_cents: dollarsToCents(perRun),
    daily_limit_cents: dollarsToCents(daily),
  }), "Payment controls saved")

  const startBankSetup = () => {
    if (!publishableKey) {
      setMessage("Stripe publishable key is not configured")
      return
    }
    startTransition(async () => {
      try {
        setSetup(unwrapAction(await createOrgFundingSetupAction()))
        setMessage(null)
      } catch (cause) {
        setMessage(cause instanceof Error ? cause.message : "Unable to start bank setup")
      }
    })
  }

  return (
    <div className="mx-auto w-full max-w-3xl space-y-8 px-5 py-6 lg:px-8 lg:py-8">
      <section className="space-y-4">
        <div><h2 className="text-base font-semibold">Vendor payments</h2><p className="mt-1 text-sm text-muted-foreground">Florida launch controls for ACH funding, maker-checker approval, and payment limits.</p></div>
        {message ? <div role="status" className="border bg-muted/40 px-3 py-2 text-sm">{message}</div> : null}
        <div className="space-y-4 border bg-card p-4">
          <div className="flex items-start gap-3"><Checkbox id="payments-enabled" checked={enabled} onCheckedChange={(value) => setEnabled(Boolean(value))} disabled={!settings.canManage} /><div><Label htmlFor="payments-enabled">Enable electronic vendor payments</Label><p className="mt-1 text-xs text-muted-foreground">Requires an approved funding bank and the protected execution feature flag.</p></div></div>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5"><Label htmlFor="approval-mode">Payment-run approvers</Label><Select value={approvalMode} onValueChange={(value) => setApprovalMode(value === "sole" ? "sole" : "dual")} disabled={!settings.canManage}><SelectTrigger id="approval-mode"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="sole">One independent approver</SelectItem><SelectItem value="dual">Two independent approvers</SelectItem></SelectContent></Select><p className="text-xs text-muted-foreground">The preparer never counts as an approver.</p></div>
            <div className="space-y-1.5"><Label htmlFor="cooling-hours">Bank-change cooling period (hours)</Label><Input id="cooling-hours" inputMode="numeric" value={coolingHours} onChange={(event) => setCoolingHours(event.target.value)} disabled={!settings.canManage} /></div>
            <div className="space-y-1.5"><Label htmlFor="per-payment">Per-payment limit</Label><Input id="per-payment" inputMode="decimal" placeholder="No limit" value={perPayment} onChange={(event) => setPerPayment(event.target.value)} disabled={!settings.canManage} /></div>
            <div className="space-y-1.5"><Label htmlFor="per-run">Per-run limit</Label><Input id="per-run" inputMode="decimal" placeholder="No limit" value={perRun} onChange={(event) => setPerRun(event.target.value)} disabled={!settings.canManage} /></div>
            <div className="space-y-1.5"><Label htmlFor="daily-limit">Daily limit</Label><Input id="daily-limit" inputMode="decimal" placeholder="No limit" value={daily} onChange={(event) => setDaily(event.target.value)} disabled={!settings.canManage} /></div>
          </div>
          {settings.canManage ? <Button onClick={savePolicy} disabled={pending}>Save controls</Button> : <p className="text-sm text-muted-foreground">You can view these controls but cannot change them.</p>}
        </div>
      </section>

      <section className="space-y-4">
        <div className="flex items-end justify-between gap-4"><div><h2 className="text-base font-semibold">Funding banks</h2><p className="mt-1 text-sm text-muted-foreground">Account details stay with Stripe. Arc stores only provider references and masked details.</p></div>{settings.canManage ? <Button variant="outline" onClick={startBankSetup} disabled={pending || Boolean(setup)}>Add bank</Button> : null}</div>
        {settings.fundingSources.length === 0 ? <div className="border px-4 py-8 text-center text-sm text-muted-foreground">No funding bank has been activated.</div> : <div className="divide-y border bg-card">{settings.fundingSources.map((source) => <div key={source.id} className="flex items-center justify-between gap-4 px-4 py-3"><div><p className="text-sm font-medium">{source.bankName ?? "Bank account"} {source.last4 ? `•••• ${source.last4}` : ""}</p><p className="mt-1 text-xs text-muted-foreground capitalize">{source.status.replaceAll("_", " ")} · {source.verificationStatus.replaceAll("_", " ")}</p></div><div className="text-xs text-muted-foreground">{source.isDefault ? "Default" : source.usableAfter ? `Available ${new Date(source.usableAfter).toLocaleDateString()}` : ""}</div></div>)}</div>}
        {setup && stripePromise ? <Elements stripe={stripePromise} options={{ clientSecret: setup.clientSecret }}><BankSetupForm providerSetupId={setup.providerSetupId} onComplete={(nextMessage) => { setSetup(null); setMessage(nextMessage); router.refresh() }} /></Elements> : null}
      </section>

      <section className="space-y-4">
        <div><h2 className="text-base font-semibold">Bank change approvals</h2><p className="mt-1 text-sm text-muted-foreground">Always two independent approvals plus the cooling period, regardless of the payment-run policy.</p></div>
        {settings.controlChanges.length === 0 ? <div className="border px-4 py-8 text-center text-sm text-muted-foreground">No bank changes are awaiting approval.</div> : <div className="divide-y border bg-card">{settings.controlChanges.map((change) => <div key={change.id} className="flex flex-wrap items-center justify-between gap-4 px-4 py-3"><div><p className="text-sm font-medium">{change.bankName ?? "Bank account"} {change.last4 ? `•••• ${change.last4}` : ""}</p><p className="mt-1 text-xs text-muted-foreground capitalize">{change.status.replaceAll("_", " ")} · {change.approvalCount}/{change.requiredApprovals} approvals · cooling until {new Date(change.applyAfter).toLocaleString()}</p></div>{change.status === "pending_approval" && change.canDecide ? <div className="flex gap-2"><Button size="sm" variant="outline" disabled={pending} onClick={() => perform(() => decidePaymentControlChangeAction({ changeRequestId: change.id, decision: "approved" }), "Bank approval recorded")}>Approve</Button><Button size="sm" variant="ghost" disabled={pending} onClick={() => perform(() => decidePaymentControlChangeAction({ changeRequestId: change.id, decision: "rejected", reason: "Rejected by payment reviewer" }), "Bank change rejected")}>Reject</Button></div> : null}</div>)}</div>}
      </section>
    </div>
  )
}
