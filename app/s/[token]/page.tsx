import { notFound } from "next/navigation"

import {
  isPortalPinVerified,
  loadSubPortalData,
  recordPortalAccess,
  validatePortalToken,
} from "@/lib/services/portal-access"
import {
  getExternalPortalGateContext,
  getExternalPortalWorkspaceContext,
  hasExternalPortalGrantForToken,
} from "@/lib/services/external-portal-auth"
import { getCompanyComplianceStatusWithClient } from "@/lib/services/compliance-documents"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { PortalAccountGate } from "@/components/portal/account/portal-account-gate"
import { PortalPinGate } from "@/components/portal/portal-pin-gate"
import { SubPortalClient } from "./sub-portal-client"
import { SubPortalSetupRequired } from "./sub-portal-setup-required"
import type { ComplianceDocumentType } from "@/lib/types"
import { getLatestPrequalificationWithClient } from "@/lib/services/prequalification"

interface SubPortalPageProps {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function SubPortalPage({ params }: SubPortalPageProps) {
  const { token } = await params
  const access = await validatePortalToken(token)

  if (!access) {
    notFound()
  }

  // Check if this token is properly configured for sub portal
  // Tokens need portal_type = 'sub' and company_id to be set
  if (access.portal_type !== "sub" || !access.company_id) {
    return (
      <SubPortalSetupRequired
        tokenId={access.id}
        hasCompanyId={!!access.company_id}
        portalType={access.portal_type}
      />
    )
  }

  const workspace = await getExternalPortalWorkspaceContext({ orgId: access.org_id })

  if (access.require_account) {
    const hasAccountAccess = await hasExternalPortalGrantForToken({
      orgId: access.org_id,
      tokenId: access.id,
      tokenType: "portal",
    })
    if (!hasAccountAccess) {
      const gateContext = await getExternalPortalGateContext({ token, tokenType: "portal" })
      return (
        <PortalAccountGate
          token={token}
          tokenType="portal"
          orgName={gateContext?.orgName ?? "the builder"}
          projectName={gateContext?.projectName ?? "this project"}
          defaultMode={gateContext?.defaultMode}
          initialEmail={gateContext?.expectedEmail ?? ""}
          suggestedFullName={gateContext?.suggestedFullName ?? ""}
          emailLocked={gateContext?.emailLocked}
          hasExistingAccount={gateContext?.hasExistingAccount}
        />
      )
    }
  }

  if (access.pin_required && !(await isPortalPinVerified(token))) {
    const gateContext = await getExternalPortalGateContext({ token, tokenType: "portal" })
    return (
      <PortalPinGate
        token={token}
        projectName={gateContext?.projectName ?? "Sub portal"}
        orgName={gateContext?.orgName ?? "Arc"}
      />
    )
  }

  try {
    await recordPortalAccess(access.id)
  } catch {
    notFound()
  }

  const supabase = createServiceSupabaseClient()

  // Load portal data and compliance data in parallel
  const [data, complianceStatus, documentTypesResult, prequalification] = await Promise.all([
    loadSubPortalData({
      orgId: access.org_id,
      projectId: access.project_id,
      companyId: access.company_id,
      permissions: access.permissions,
      scopedRfiId: access.scoped_rfi_id ?? null,
      portalToken: token,
    }),
    getCompanyComplianceStatusWithClient(supabase, access.org_id, access.company_id),
    supabase
      .from("compliance_document_types")
      .select("*")
      .eq("org_id", access.org_id)
      .eq("is_active", true)
      .order("is_system", { ascending: false })
      .order("name", { ascending: true }),
    getLatestPrequalificationWithClient(supabase, access.org_id, access.company_id),
  ])

  // Add compliance status to data
  data.complianceStatus = complianceStatus

  const complianceDocumentTypes: ComplianceDocumentType[] = (documentTypesResult.data ?? []).map(
    (row) => ({
      id: row.id,
      org_id: row.org_id,
      name: row.name,
      code: row.code,
      description: row.description ?? undefined,
      has_expiry: row.has_expiry,
      expiry_warning_days: row.expiry_warning_days,
      is_system: row.is_system,
      is_active: row.is_active,
      created_at: row.created_at,
    })
  )

  const gateContext = workspace ? null : await getExternalPortalGateContext({ token, tokenType: "portal" })

  return (
    <SubPortalClient
      data={data}
      token={token}
      canSubmitInvoices={access.permissions.can_submit_invoices ?? true}
      canSubmitTime={access.permissions.can_submit_time ?? true}
      canSubmitExpenses={access.permissions.can_submit_expenses ?? true}
      canSubmitDailyLogs={access.permissions.can_submit_daily_logs ?? false}
      canDownloadFiles={access.permissions.can_download_files}
      canUploadComplianceDocs={access.permissions.can_upload_compliance_docs ?? true}
      canUploadSubtierWaivers={access.permissions.can_upload_subtier_waivers ?? true}
      canWorkPunchItems={access.permissions.can_view_punch_items ?? false}
      pinRequired={access.pin_required}
      complianceDocumentTypes={complianceDocumentTypes}
      workspace={workspace}
      inviteEmail={gateContext?.expectedEmail ?? ""}
      suggestedFullName={gateContext?.suggestedFullName ?? ""}
      prequalification={prequalification}
    />
  )
}
