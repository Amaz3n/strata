import { notFound } from "next/navigation"

import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { getCompanyComplianceStatusWithClient } from "@/lib/services/compliance-documents"
import { getComplianceRulesWithClient } from "@/lib/services/compliance"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import type { ComplianceDocumentType } from "@/lib/types"
import { ComplianceClient } from "./compliance-client"

interface Props {
  params: Promise<{ token: string }>
}

export const revalidate = 0

export default async function SubPortalCompliancePage({ params }: Props) {
  const { token } = await params

  let access
  try {
    access = await assertPortalActionAccess(token, { portalType: "sub", requireCompany: true })
  } catch {
    notFound()
  }
  if (!access.company_id) notFound()

  const supabase = createServiceSupabaseClient()
  const [status, documentTypesResult, rules] = await Promise.all([
    getCompanyComplianceStatusWithClient(supabase, access.org_id, access.company_id),
    supabase
      .from("compliance_document_types")
      .select("*")
      .eq("org_id", access.org_id)
      .eq("is_active", true)
      .order("is_system", { ascending: false })
      .order("name", { ascending: true }),
    getComplianceRulesWithClient(supabase, access.org_id),
  ])

  const documentTypes: ComplianceDocumentType[] = (documentTypesResult.data ?? []).map((row) => ({
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
  }))

  return (
    <>
      <PortalPageHeader
        title="Compliance"
        description="The insurance and paperwork this builder needs on file for your company."
      />
      <ComplianceClient
        status={status}
        documentTypes={documentTypes}
        token={token}
        canUpload={access.permissions.can_upload_compliance_docs ?? true}
        blocksPayment={rules.block_payment_on_missing_docs ?? true}
      />
    </>
  )
}
