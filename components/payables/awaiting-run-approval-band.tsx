import Link from "next/link"

import { formatMoneyFromCents } from "@/components/financials/workspace/workspace-helpers"
import type { PaymentRunListRow } from "@/lib/services/payment-runs"

export function AwaitingRunApprovalBand({ runs }: { runs: PaymentRunListRow[] }) {
  if (runs.length === 0) return null
  return <section className="border-b border-primary/30 bg-primary/5" aria-label="Payment runs awaiting your approval">
    <div className="px-4 py-2 text-xs font-medium text-primary sm:px-6">Awaiting your approval</div>
    <div className="divide-y divide-primary/15 border-t border-primary/15">{runs.map((run) => <Link key={run.id} href={`/payables/payment-runs/${run.id}`} className="grid grid-cols-[minmax(0,1fr)_auto] gap-4 px-4 py-2.5 text-xs hover:bg-primary/10 sm:px-6"><span>{run.payment_count} {run.payment_count === 1 ? "vendor payment" : "vendor payments"} · {run.approvals.filter((approval) => approval.decision === "approved").length}/{run.required_approvals} approvals</span><span className="font-mono tabular-nums">{formatMoneyFromCents(run.total_debit_cents)}</span></Link>)}</div>
  </section>
}
