import { notFound } from "next/navigation"

import { validatePortalToken, loadSubPortalData, recordPortalAccess } from "@/lib/services/portal-access"
import { hasExternalPortalGrantForToken } from "@/lib/services/external-portal-auth"
import { getCompanyComplianceStatusWithClient } from "@/lib/services/compliance-documents"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { PortalAccountGate } from "@/components/portal/account/portal-account-gate"
import { SubPortalClient } from "./sub-portal-client"
import { SubPortalSetupRequired } from "./sub-portal-setup-required"
import type { ComplianceDocumentType } from "@/lib/types"

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

  if (access.require_account) {
    const hasAccountAccess = await hasExternalPortalGrantForToken({
      orgId: access.org_id,
      tokenId: access.id,
      tokenType: "portal",
    })
    if (!hasAccountAccess) {
      return (
        <PortalAccountGate
          token={token}
          tokenType="portal"
          orgName="the builder"
          projectName="this project"
        />
      )
    }
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

  const supabase = createServiceSupabaseClient()

  // Load portal data and compliance data in parallel
  const [data, complianceStatus, documentTypesResult] = await Promise.all([
    loadSubPortalData({
      orgId: access.org_id,
      projectId: access.project_id,
      companyId: access.company_id,
      permissions: access.permissions,
      scopedRfiId: access.scoped_rfi_id ?? null,
    }),
    getCompanyComplianceStatusWithClient(supabase, access.org_id, access.company_id),
    supabase
      .from("compliance_document_types")
      .select("*")
      .eq("org_id", access.org_id)
      .eq("is_active", true)
      .order("is_system", { ascending: false })
      .order("name", { ascending: true }),
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

  await recordPortalAccess(access.id)

  return (
    <SubPortalClient
      data={data}
      token={token}
      canMessage={access.permissions.can_message}
      canSubmitInvoices={access.permissions.can_submit_invoices ?? true}
      canDownloadFiles={access.permissions.can_download_files}
      canUploadComplianceDocs={access.permissions.can_upload_compliance_docs ?? true}
      pinRequired={access.pin_required}
      complianceDocumentTypes={complianceDocumentTypes}
    />
  )
}
