import { notFound } from "next/navigation"

import { PortalPageHeader } from "@/components/portal/shell/portal-page-header"
import { getCompanyComplianceStatusWithClient } from "@/lib/services/compliance-documents"
import { getComplianceRulesWithClient } from "@/lib/services/compliance"
import { listPortableComplianceDocuments } from "@/lib/services/compliance-portability"
import { getCurrentExternalPortalSession } from "@/lib/services/external-portal-auth"
import { assertPortalActionAccess } from "@/lib/services/portal-access"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import type { ComplianceDocumentType } from "@/lib/types"
import { ComplianceClient } from "./compliance-client"
import { PortableDocuments } from "./portable-documents"

interface Props {
  params: Promise<{ token: string }>
}


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

  // Documents from other builders are offered only to a signed-in vendor
  // account, keyed on that account's own verified email. The token's bound
  // contact email is a field the builder controls, so it can never be the key
  // to another org's records — see `shareComplianceDocumentAction`.
  const session = await getCurrentExternalPortalSession()

  const [status, documentTypesResult, rules, portable] = await Promise.all([
    // Scoped to the job this link is for: an owner mandating higher limits on
    // one project is exactly what the vendor needs to be told, and it is what
    // the payment gate will read. An account-level link carries no project and
    // asks the standing question instead.
    getCompanyComplianceStatusWithClient(supabase, access.org_id, access.company_id, {
      projectIds: access.project_id ? [access.project_id] : [],
    }),
    supabase
      .from("compliance_document_types")
      .select("*")
      .eq("org_id", access.org_id)
      .eq("is_active", true)
      .order("is_system", { ascending: false })
      .order("name", { ascending: true }),
    getComplianceRulesWithClient(supabase, access.org_id),
    // Never a reason to fail the page: this is a convenience, and a vendor who
    // works with one builder simply has nothing to carry across.
    listPortableComplianceDocuments({
      targetOrgId: access.org_id,
      targetCompanyId: access.company_id,
      identityEmail: session?.identity.email ?? null,
    }).catch(() => []),
  ])

  const documentTypes: ComplianceDocumentType[] = (documentTypesResult.data ?? []).map((row) => ({
    id: row.id,
    org_id: row.org_id,
    name: row.name,
    code: row.code,
    kind: row.kind ?? "other",
    description: row.description ?? undefined,
    has_expiry: row.has_expiry,
    expiry_warning_days: row.expiry_warning_days,
    is_system: row.is_system,
    is_active: row.is_active,
    created_at: row.created_at,
  }))

  const canUpload = access.permissions.can_upload_compliance_docs ?? true

  return (
    <>
      <PortalPageHeader
        title="Compliance"
        description="The insurance and paperwork this builder needs on file for your company."
      />
      {canUpload && portable.length > 0 ? (
        <div className="mb-6">
          <PortableDocuments token={token} documents={portable} />
        </div>
      ) : null}
      <ComplianceClient
        status={status}
        documentTypes={documentTypes}
        token={token}
        canUpload={canUpload}
        blocksPayment={rules.block_payment_on_missing_docs ?? true}
      />
    </>
  )
}
