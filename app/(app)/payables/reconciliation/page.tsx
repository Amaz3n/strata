import { connection } from "next/server"

import { PageLayout } from "@/components/layout/page-layout"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { requirePermissionGuard } from "@/lib/auth/guards"
import { listOpenPaymentReconciliationExceptions, listPaymentReconciliations } from "@/lib/services/payment-reconciliation"
import { reconcileVendorPaymentsAction, resolveVendorPaymentExceptionAction } from "./actions"

function money(cents: number) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100)
}

export default async function PaymentReconciliationPage() {
  await connection()
  await requirePermissionGuard("payment.reconcile")
  const [runs, exceptions] = await Promise.all([
    listPaymentReconciliations(),
    listOpenPaymentReconciliationExceptions(),
  ])
  return (
    <PageLayout title="Vendor payment reconciliation" breadcrumbs={[{ label: "Payables", href: "/payables" }, { label: "Reconciliation" }]}>
      <div className="mx-auto max-w-6xl space-y-6 p-4">
        <div className="flex items-start justify-between gap-4 border-b pb-4">
          <div>
            <h2 className="text-lg font-semibold">Exception queue</h2>
            <p className="mt-1 text-sm text-muted-foreground">Compare Arc’s payable ledger with the payment provider and document every resolution.</p>
          </div>
          <form action={reconcileVendorPaymentsAction}><Button type="submit" variant="outline">Reconcile last 24 hours</Button></form>
        </div>

        {exceptions.length === 0 ? <p className="border p-6 text-sm text-muted-foreground">No open vendor-payment exceptions.</p> : (
          <div className="divide-y border">
            {exceptions.map((item) => (
              <article key={item.id} className="space-y-3 p-4">
                <div className="flex flex-wrap items-baseline justify-between gap-3">
                  <div><span className="font-medium">{item.status.replaceAll("_", " ")}</span><span className="ml-2 text-xs text-muted-foreground">{item.providerReference ?? item.disbursementId ?? "No provider reference"}</span></div>
                  <div className="font-mono text-sm tabular-nums">Expected {money(item.expectedCents)} · Provider {money(item.providerCents)} · Difference {money(item.differenceCents)}</div>
                </div>
                <form action={resolveVendorPaymentExceptionAction} className="grid gap-2 md:grid-cols-[160px_1fr_1fr_auto]">
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
          <div className="divide-y border">
            {runs.slice(0, 20).map((run) => (
              <div key={run.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                <span>{run.provider} · {new Date(run.createdAt).toLocaleString()}</span>
                <span className="text-muted-foreground">{run.status} · {run.exceptionCount} exception{run.exceptionCount === 1 ? "" : "s"} · {money(run.differenceCents)} difference</span>
              </div>
            ))}
          </div>
        </section>
      </div>
    </PageLayout>
  )
}
