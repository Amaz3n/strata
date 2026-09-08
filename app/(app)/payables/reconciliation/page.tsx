import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"
import { connection } from "next/server"

import { PageLayout } from "@/components/layout/page-layout"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { requirePermissionGuard } from "@/lib/auth/guards"
import { listOpenPaymentReconciliationExceptions, listPaymentReconciliations } from "@/lib/services/payment-reconciliation"
import { listReleaseBlockedIncidents } from "@/lib/services/payment-runs"
import { reconcileVendorPaymentsAction, resolveVendorPaymentExceptionAction } from "./actions"
import { cancelPaymentRunAction, retryPaymentRunReleaseAction } from "../payment-runs/actions"

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)
}

async function PaymentReconciliationPageContent() {
  await connection()
  await requirePermissionGuard("payment.reconcile")
  const [runs, exceptions, blockedReleases] = await Promise.all([
    listPaymentReconciliations(),
    listOpenPaymentReconciliationExceptions(),
    listReleaseBlockedIncidents(),
  ])
  const recentRuns = runs.slice(0, 20)
  return (
    <PageLayout title="Vendor payment reconciliation" breadcrumbs={[{ label: "Payables", href: "/payables" }, { label: "Reconciliation" }]}>
      <div className="mx-auto max-w-6xl space-y-6 p-4">
        <div className="flex items-start justify-between gap-4 border-b pb-4">
          <div>
            <h2 className="text-lg font-semibold">Exception queue</h2>
            <p className="mt-1 text-sm text-muted-foreground">Compare Arc’s payable ledger with the payment provider and document every resolution.</p>
          </div>
          <form action={async () => { "use server"; await reconcileVendorPaymentsAction() }}><Button type="submit" variant="outline">Reconcile last 24 hours</Button></form>
        </div>

        <section>
          <h2 className="mb-3 text-sm font-semibold">Blocked releases</h2>
          {blockedReleases.items.length === 0 ? <p className="border p-6 text-sm text-muted-foreground">No payment releases are blocked after retry exhaustion.</p> : <div className="divide-y border">{blockedReleases.items.map((incident) => <article key={incident.id} className="space-y-3 p-4"><div><p className="font-medium">Run {incident.runId.slice(0, 8)}</p><p className="text-xs text-destructive">{incident.detail}</p></div><div className="flex flex-wrap gap-2"><form action={async (formData) => { "use server"; await retryPaymentRunReleaseAction(formData) }}><input type="hidden" name="run_id" value={incident.runId} /><Button type="submit" variant="outline">Retry release</Button></form><form action={async (formData) => { "use server"; await cancelPaymentRunAction(formData) }} className="flex gap-2"><input type="hidden" name="run_id" value={incident.runId} /><Input name="reason" minLength={8} maxLength={500} required placeholder="Cancellation reason" /><Button type="submit" variant="destructive">Cancel run</Button></form></div></article>)}</div>}
          {blockedReleases.truncation.truncated ? <p className="mt-2 text-xs text-muted-foreground">Showing the first {blockedReleases.truncation.cap} blocked releases.</p> : null}
        </section>

        {exceptions.length === 0 ? <p className="border p-6 text-sm text-muted-foreground">No open vendor-payment exceptions.</p> : (
          <div className="divide-y border">
            {exceptions.map((item) => (
              <article key={item.id} className="space-y-3 p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <div><span className="font-medium">{item.status.replaceAll("_", " ")}</span><span className="ml-2 text-xs text-muted-foreground">{item.providerReference ?? item.disbursementId ?? "No provider reference"}</span></div>
                  <div className="font-mono text-sm tabular-nums">Expected {money(item.expectedCents)} · Provider {money(item.providerCents)} · Difference {money(item.differenceCents)}</div>
                </div>
                <form action={async (formData) => { "use server"; await resolveVendorPaymentExceptionAction(formData) }} className="grid gap-2 md:grid-cols-[160px_1fr_1fr_auto]">
                  <input type="hidden" name="item_id" value={item.id} />
                  <label className="sr-only" htmlFor={`evidence-source-${item.id}`}>Evidence source</label>
                  <select id={`evidence-source-${item.id}`} name="evidence_source" required className="h-9 border bg-background px-3 text-sm">
                    <option value="provider">Provider</option>
                    <option value="bank">Bank</option>
                    <option value="accounting">Accounting</option>
                    <option value="ledger">Arc ledger</option>
                    <option value="other">Other</option>
                  </select>
                  <Input name="reference" minLength={3} maxLength={200} required placeholder="Evidence URL, statement, case, or transaction ID" />
                  <Input name="note" minLength={20} maxLength={1000} required placeholder="What you verified and the corrective action taken" />
                  <Button type="submit">Resolve</Button>
                </form>
              </article>
            ))}
          </div>
        )}

        <section>
          <h2 className="mb-3 text-sm font-semibold">Recent reconciliations</h2>
          {recentRuns.length === 0 ? (
            <p className="border p-6 text-sm text-muted-foreground">
              No reconciliation has run yet. The daily sweep compares each closed 24-hour period against the payment provider; use “Reconcile last 24 hours” to run one now.
            </p>
          ) : (
            <div className="divide-y border">
              {recentRuns.map((run) => (
                <div key={run.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                  <span>{run.provider} · {new Date(run.createdAt).toLocaleString()}</span>
                  <span className={run.status === "exceptions" ? "text-warning" : run.status === "failed" ? "text-destructive" : "text-muted-foreground"}>
                    {run.status} · {run.exceptionCount} exception{run.exceptionCount === 1 ? "" : "s"} · <span className="tabular-nums">{money(run.differenceCents)}</span> difference
                  </span>
                </div>
              ))}
            </div>
          )}
          {runs.length > recentRuns.length ? (
            <p className="mt-2 text-xs text-muted-foreground">Showing the {recentRuns.length} most recent of {runs.length} runs.</p>
          ) : null}
        </section>
      </div>
    </PageLayout>
  )
}

export default function PaymentReconciliationPage() {
  return (
    <Suspense fallback={<PageLoadingSkeleton />}>
      <PaymentReconciliationPageContent />
    </Suspense>
  )
}
