import { PortalActionInbox, sortPortalActions, type PortalAction } from "@/components/portal/action-inbox"
import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { getCompanyComplianceStatusWithClient } from "@/lib/services/compliance-documents"
import { getLatestPrequalificationWithClient } from "@/lib/services/prequalification"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * Home for a company-scoped link — a vendor the builder is onboarding who is
 * not on a job yet. There is no contract, no schedule and no invoice history to
 * show, so this is the onboarding checklist and nothing else.
 */
export async function VendorAccountHome({
  token,
  orgId,
  companyId,
}: {
  token: string
  orgId: string
  companyId: string
}) {
  const supabase = createServiceSupabaseClient()
  const [company, complianceStatus, prequalification] = await Promise.all([
    supabase.from("companies").select("name").eq("org_id", orgId).eq("id", companyId).maybeSingle(),
    getCompanyComplianceStatusWithClient(supabase, orgId, companyId),
    getLatestPrequalificationWithClient(supabase, orgId, companyId),
  ])

  const root = `/s/${token}`
  const actions: PortalAction[] = []

  if (prequalification?.status === "requested") {
    actions.push({
      id: "prequalification",
      tone: "warning",
      label: "Complete your prequalification",
      detail: "The builder needs your company information before awarding work",
      href: `${root}/prequalification`,
    })
  }
  if (prequalification?.status === "under_review" || prequalification?.status === "submitted") {
    actions.push({
      id: "prequalification-review",
      tone: "info",
      label: "Prequalification submitted",
      detail: "The builder is reviewing your submission",
      href: `${root}/prequalification`,
    })
  }

  const blockers =
    complianceStatus.missing.length +
    complianceStatus.expired.length +
    complianceStatus.deficiencies.length
  if (blockers > 0) {
    actions.push({
      id: "compliance",
      tone: "critical",
      label: `${blockers} compliance document${blockers === 1 ? "" : "s"} need attention`,
      detail: "Missing or expired documents hold up new work and payment",
      href: `${root}/compliance`,
    })
  }
  if (complianceStatus.expiring_soon.length > 0) {
    actions.push({
      id: "compliance-expiring",
      tone: "warning",
      label: `${complianceStatus.expiring_soon.length} document${complianceStatus.expiring_soon.length === 1 ? "" : "s"} expiring soon`,
      href: `${root}/compliance`,
    })
  }

  return (
    <>
      <PortalPageHeader
        title={company.data?.name ?? "Your company"}
        description="Vendor account"
      />

      <div className="space-y-6">
        <PortalActionInbox actions={sortPortalActions(actions)} />

        <section className="border border-border bg-card px-4 py-3">
          <p className="text-sm text-muted-foreground">
            This is your account with the builder. Once you are awarded work on a project, that
            project will get its own link with contracts, invoices and day-to-day requests.
          </p>
        </section>
      </div>
    </>
  )
}
