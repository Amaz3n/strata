import { connection } from "next/server"

import { PageLayout } from "@/components/layout/page-layout"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { getPlatformPayoutScheduleState, listPaymentLaunchGateStates, requirePaymentLaunchOwner } from "@/lib/services/payment-launch-readiness"

import { attestPaymentLaunchGateAction } from "./actions"

const LABELS = {
  provider_program: "Provider program approval",
  payments_legal: "Payments legal review",
  risk_reserves: "Risk, reserves, and return-loss policy",
  operations_runbook: "Operations ownership and incident runbook",
  production_qa: "Production-mode end-to-end QA",
} as const

export default async function PaymentLaunchPage() {
  await connection()
  await requirePaymentLaunchOwner()
  const [gates, payoutSchedule] = await Promise.all([listPaymentLaunchGateStates(), getPlatformPayoutScheduleState()])
  return (
    <PageLayout title="Payment launch gates" breadcrumbs={[{ label: "Admin", href: "/admin" }, { label: "Ops", href: "/admin/ops" }, { label: "Payment launch" }]}>
      <div className="mx-auto max-w-5xl space-y-6 p-4">
        <div className="border-l-2 border-primary pl-4">
          <p className="text-sm font-medium">No attestation is created by deploying code.</p>
          <p className="mt-1 text-sm leading-6 text-muted-foreground">
            Approve a gate only after the named owner has completed the work and supplied a durable case, document, test-run, or provider reference. Revocation immediately blocks new payment execution and vendor-transfer release.
          </p>
        </div>
        <section className="flex flex-wrap items-start justify-between gap-3 border p-4">
          <div>
            <h2 className="text-sm font-semibold">Stripe platform payout schedule</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Live interval: {payoutSchedule.interval}. Vendor funds can only be held safely when platform payouts are manual.
              {payoutSchedule.error ? ` ${payoutSchedule.error}` : ""}
            </p>
          </div>
          <Badge variant={payoutSchedule.ready ? "secondary" : "destructive"}>{payoutSchedule.ready ? "manual" : "blocked"}</Badge>
        </section>
        <div className="divide-y border">
          {gates.map((gate) => (
            <section key={gate.gateKey} className="space-y-4 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <h2 className="text-sm font-semibold">{LABELS[gate.gateKey]}</h2>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {gate.createdAt ? `Last attested ${new Date(gate.createdAt).toLocaleString()} · ${gate.evidenceReference}` : "No attestation recorded"}
                  </p>
                </div>
                <Badge variant={gate.decision === "approved" ? "secondary" : "destructive"}>{gate.decision}</Badge>
              </div>
              {gate.note ? <p className="text-xs leading-5 text-muted-foreground">{gate.note}</p> : null}
              <form action={attestPaymentLaunchGateAction} className="grid gap-2 md:grid-cols-[150px_1fr_2fr_auto]">
                <input type="hidden" name="gate_key" value={gate.gateKey} />
                <label className="sr-only" htmlFor={`decision-${gate.gateKey}`}>Decision</label>
                <select id={`decision-${gate.gateKey}`} name="decision" className="h-9 border bg-background px-3 text-sm" required>
                  <option value="approved">Approve</option>
                  <option value="revoked">Revoke</option>
                </select>
                <Input name="evidence_reference" minLength={3} maxLength={500} required placeholder="Provider case, legal memo, run ID, or document URL" />
                <Input name="note" minLength={20} maxLength={2000} required placeholder="What was verified, by whom, and any conditions" />
                <Button type="submit">Record</Button>
              </form>
            </section>
          ))}
        </div>
      </div>
    </PageLayout>
  )
}
