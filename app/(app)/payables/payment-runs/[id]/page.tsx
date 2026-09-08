import { PageLoadingSkeleton } from "@/components/layout/page-loading-skeleton"
import { Suspense } from "react"
import Link from "next/link"
import { notFound } from "next/navigation"
import { connection } from "next/server"

import { AccountingSyncBadge } from "@/components/accounting/accounting-sync-badge"
import { PageLayout } from "@/components/layout/page-layout"
import { PaymentRunActionsPanel } from "@/components/payables/payment-run-actions-panel"
import { Badge } from "@/components/ui/badge"
import { requireAnyPermissionGuard } from "@/lib/auth/guards"
import { DISBURSEMENT_STAGES } from "@/lib/payments/disbursement-stage"
import { getProjectPosture, normalizeProductTier } from "@/lib/product-tier"
import { requireOrgContext } from "@/lib/services/context"
import { listPaymentRuns } from "@/lib/services/payment-runs"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { terminology } from "@/lib/terminology"

function money(cents: number) { return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100) }
function Evidence({ value }: { value: unknown }) { return <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words bg-muted/20 p-3 font-mono text-[11px] leading-5 text-muted-foreground">{JSON.stringify(value ?? {}, null, 2)}</pre> }

async function PaymentRunDetailPageContent({ params }: { params: Promise<{ id: string }> }) {
  await connection()
  await requireAnyPermissionGuard(["payment.release", "payment.approve_run", "payment.reconcile", "payment.manage_rail"])
  const { id } = await params
  const run = (await listPaymentRuns(undefined, null, id))[0]
  if (!run) notFound()
  const { orgId } = await requireOrgContext()
  const supabase = createServiceSupabaseClient()
  const [{ data: org }, { data: project }] = await Promise.all([
    supabase.from("orgs").select("product_tier").eq("id", orgId).maybeSingle(),
    run.items[0]?.projectId ? supabase.from("projects").select("property_type").eq("org_id", orgId).eq("id", run.items[0].projectId).maybeSingle() : Promise.resolve({ data: null }),
  ])
  const terms = terminology(getProjectPosture(project?.property_type, normalizeProductTier(org?.product_tier)))
  const paymentCount = run.items.filter((item) => item.paymentId).length
  return <PageLayout title="Payment run" breadcrumbs={[{ label: "Payables", href: "/payables" }, { label: run.id.slice(0, 8) }]}>
    <main className="mx-auto max-w-6xl space-y-4 p-4 sm:p-6">
      <section className="grid border sm:grid-cols-2 lg:grid-cols-5">
        <div className="border-b p-3 lg:border-b-0 lg:border-r"><p className="microlabel">Status</p><p className="mt-1 capitalize">{run.status.replaceAll("_", " ")}</p></div>
        <div className="border-b p-3 lg:border-b-0 lg:border-r"><p className="microlabel">Payments</p><p className="mt-1 tabular-nums">{run.payment_count}</p></div>
        <div className="border-b p-3 lg:border-b-0 lg:border-r"><p className="microlabel">Approvals</p><p className="mt-1 tabular-nums">{run.approvals.filter((approval) => approval.decision === "approved").length}/{run.required_approvals}</p></div>
        <div className="border-b p-3 lg:border-b-0 lg:border-r"><p className="microlabel">Release</p><p className="mt-1">{run.scheduled_for ? new Date(`${run.scheduled_for}T00:00:00Z`).toLocaleDateString() : "On approval"}</p></div>
        <div className="p-3"><p className="microlabel">Builder debit</p><p className="mt-1 font-mono font-semibold tabular-nums">{money(run.total_debit_cents)}</p></div>
      </section>

      <PaymentRunActionsPanel run={{ id: run.id, status: run.status, content_hash: run.content_hash, can_approve: run.can_approve && run.status === "pending_approval", can_cancel: run.can_cancel, paymentCount }} />

      <section className="border"><div className="border-b px-4 py-3"><h2 className="text-sm font-semibold">Money movement by {terms.vendor.toLowerCase()}</h2><p className="mt-0.5 text-xs text-muted-foreground">Each row distinguishes a builder debit from money actually reaching the {terms.vendor.toLowerCase()}.</p></div>
        <div className="divide-y">{run.items.length === 0 ? <div className="p-10 text-center"><p className="text-sm font-medium">No payment items</p><p className="mt-1 text-xs text-muted-foreground">This run has no frozen payable items.</p></div> : run.items.map((item) => <article key={item.id} className="p-4">
          <div className="flex flex-wrap items-start justify-between gap-3"><div><h3 className="text-sm font-medium">{item.billNumber} · {item.vendorName}</h3><p className="text-xs text-muted-foreground">{item.projectName}</p></div><div className="flex flex-wrap items-center justify-end gap-3"><div className="flex items-center gap-1.5"><span className="microlabel">Bill</span><AccountingSyncBadge status={item.billSync?.status ?? "not_synced"} externalId={item.billSync?.externalId} error={item.billSync?.error} provider={item.billSync?.provider} syncedAt={item.billSync?.syncedAt}/></div><div className="flex items-center gap-1.5"><span className="microlabel">Payment</span><AccountingSyncBadge status={item.paymentSync?.status ?? "not_synced"} externalId={item.paymentSync?.externalId} error={item.paymentSync?.error} provider={item.paymentSync?.provider} syncedAt={item.paymentSync?.syncedAt}/></div><span className="font-mono text-sm tabular-nums">{money(item.vendorAmountCents)}</span></div></div>
          <ol className="mt-4 grid grid-cols-5 gap-px bg-border" aria-label={`Disbursement stage: ${item.stage}`}>{DISBURSEMENT_STAGES.map((stage, index) => <li key={stage} className={`min-w-0 bg-background px-2 py-2 text-[11px] ${index <= item.stageIndex && !item.failureReason ? "text-foreground" : "text-muted-foreground"}`}><span className={`mb-1 block h-1 ${index <= item.stageIndex && !item.failureReason ? "bg-primary" : "bg-muted"}`}/>{stage}</li>)}</ol>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs"><Badge variant="outline" className="rounded-none">{item.stage}</Badge>{item.failureReason ? <span className="text-destructive">{item.failureReason}</span> : null}{item.disbursement?.id ? <Link className="ml-auto underline underline-offset-2" href={`/payables/reconciliation?disbursement=${item.disbursement.id}`}>Open reconciliation exception</Link> : null}</div>
          {item.commitmentContextChanged ? <p className="mt-2 border-l-2 border-warning pl-2 text-xs text-muted-foreground">Commitment context changed since submission — informational only</p> : null}
          <details className="mt-3 border"><summary className="cursor-pointer px-3 py-2 text-xs font-medium">Frozen payable evidence</summary><div className="grid border-t md:grid-cols-2"><div className="border-b md:border-b-0 md:border-r"><p className="microlabel px-3 pt-3">Holds</p><Evidence value={item.holdSnapshot}/></div><div><p className="microlabel px-3 pt-3">Waiver</p><Evidence value={item.waiverSnapshot}/></div></div><div className="border-t px-3 py-2 text-xs"><span className="text-muted-foreground">Payees: </span>{item.payees.map((payee) => `${payee.name} · ${payee.method.toUpperCase()} · ${money(payee.amountCents)}`).join(", ")}</div></details>
        </article>)}</div>
      </section>

      <div className="grid gap-4 lg:grid-cols-2"><section className="border"><h2 className="border-b px-4 py-3 text-sm font-semibold">Immutable approvals</h2>{run.approvals.length ? <div className="divide-y">{run.approvals.map((approval) => <div key={approval.id} className="px-4 py-3 text-xs"><div className="flex justify-between gap-3"><span className="capitalize">{approval.decision}</span><time className="text-muted-foreground">{new Date(approval.created_at).toLocaleString()}</time></div>{approval.reason ? <p className="mt-1 text-muted-foreground">{approval.reason}</p> : null}<p className="mt-1 font-mono text-[10px] text-muted-foreground">{approval.approver_id}</p></div>)}</div> : <p className="p-4 text-xs text-muted-foreground">No decisions recorded yet.</p>}</section>
        <section className="border"><h2 className="border-b px-4 py-3 text-sm font-semibold">Risk decisions and fee quote</h2><div className="p-4"><p className="text-xs">Provider fees <span className="float-right font-mono">{money(run.processor_fee_cents)}</span></p><p className="mt-2 text-xs">Arc fees <span className="float-right font-mono">{money(run.platform_fee_cents)}</span></p></div>{run.riskReviews.length ? <div className="divide-y border-t">{run.riskReviews.map((risk) => <div key={risk.id} className="px-4 py-3 text-xs"><span className="capitalize">{risk.reviewType} · {risk.decision}</span><time className="float-right text-muted-foreground">{new Date(risk.reviewedAt).toLocaleString()}</time><Evidence value={risk.signals}/></div>)}</div> : <p className="border-t p-4 text-xs text-muted-foreground">No risk review was required.</p>}<details className="border-t"><summary className="cursor-pointer px-4 py-3 text-xs font-medium">Frozen control snapshot</summary><Evidence value={run.controlSnapshot}/></details></section></div>
      {run.details_truncated ? <p className="text-xs text-warning">Showing the first 1,000 items. Reconciliation remains authoritative for the complete run.</p> : null}
    </main>
  </PageLayout>
}

export default function PaymentRunDetailPage(props: Parameters<typeof PaymentRunDetailPageContent>[0]) {
  return (
    <Suspense fallback={<PageLoadingSkeleton />}>
      <PaymentRunDetailPageContent {...props} />
    </Suspense>
  )
}
