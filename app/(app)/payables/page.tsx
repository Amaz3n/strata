import { PageLayout } from "@/components/layout/page-layout"
import { requireOrgContext } from "@/lib/services/context"
import { loadOrgPayablesDesk } from "@/lib/services/org-payables"
import { getPaymentApprovalRouting } from "@/lib/services/payment-approvers"
import { isVendorPayoutSetupOpen } from "@/lib/services/payment-rail-setup"

import { PayablesDesk } from "./payables-desk"
import { DeskScopeFilters } from "@/components/production/desk-scope-filters"
import { resolveProductionDeskScope } from "@/lib/services/production-desk-scope"
import { listBlockedPaymentRuns } from "@/lib/services/payment-risk"
import { hasAnyPermission } from "@/lib/services/permissions"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { redirect } from "next/navigation"


export default async function PayablesPage({ searchParams }: { searchParams: Promise<{ community?: string; tab?: string; q?: string; page?: string; pageSize?: string; run?: string; bill?: string }> }) {
  const params = await searchParams
  const [scope, { orgId, userId }] = await Promise.all([
    resolveProductionDeskScope({ communityId: params.community }),
    requireOrgContext(),
  ])
  // Approval emails link to a run, but a run has no surface of its own — it
  // resolves to the payables it pays. Opening the first one puts the approver on
  // the review, which shows the whole frozen set anyway.
  if (params.run && !params.bill) {
    const { data: firstItem } = await createServiceSupabaseClient()
      .from("payment_run_items")
      .select("bill_id")
      .eq("org_id", orgId)
      .eq("run_id", params.run)
      .order("created_at")
      .limit(1)
      .maybeSingle()
    const target = new URLSearchParams()
    if (params.community) target.set("community", params.community)
    if (firstItem?.bill_id) {
      target.set("tab", "inflight")
      target.set("bill", firstItem.bill_id)
    }
    redirect(target.size > 0 ? `/payables?${target.toString()}` : "/payables")
  }
  // Every tab switch re-runs this page, so nothing here waits on anything it does
  // not need. The desk query does not depend on the rail being open, and the two
  // rail-dependent reads are the only pair that has to follow it.
  const [data, railOpen] = await Promise.all([
    loadOrgPayablesDesk(scope.projectIds, {
      tab: params.tab,
      search: params.q,
      page: Number(params.page) || 1,
      pageSize: Number(params.pageSize) || 50,
      billId: params.bill,
    }),
    // Approval routing and risk blocks only mean something once the builder has
    // a rail to release money on.
    isVendorPayoutSetupOpen(orgId),
  ])
  // Whether the viewer may see the risk queue is a permission fact checked up
  // front, not an error swallowed after the fact — a real failure loading the
  // queue should surface, never render as "no blocked runs".
  const mayViewRiskQueue = railOpen && (await hasAnyPermission(["payment.approve_run", "payment.reconcile"]))
  const [routing, blockedRuns] = railOpen
    ? await Promise.all([
        getPaymentApprovalRouting(orgId).catch(() => null),
        // Empty on a normal day, which is the point — it renders nothing then.
        mayViewRiskQueue ? listBlockedPaymentRuns() : Promise.resolve([]),
      ])
    : [null, []]

  return (
    <PageLayout title="Payables" fullBleed>
      <DeskScopeFilters communities={scope.communities} communityId={scope.communityId} className="border-b px-4 py-2.5 sm:px-6" />
      <PayablesDesk
        data={data}
        railOpen={railOpen}
        blockedRuns={blockedRuns}
        viewerMayApproveRuns={Boolean(routing?.viewerMayApprove)}
        approvalViewer={{ userId, approvers: routing?.approvers ?? [] }}
      />
    </PageLayout>
  )
}
