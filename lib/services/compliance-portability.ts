import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"

import { recordEvent } from "@/lib/services/events"
import { downloadFilesObject, uploadFilesObject } from "@/lib/storage/files-storage"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * Carrying a certificate between the builders a vendor works for.
 *
 * A subcontractor working for four builders on Arc uploads the same ACORD 25
 * four times, and re-uploads it four times a year. Nothing about that is a
 * feature of construction; it is a feature of every builder keeping compliance
 * in a private silo. Arc already knows these are the same person — the vendor
 * signs in with one identity across orgs, and shares a payout identity — so the
 * certificate can travel with them.
 *
 * Three rules make this safe to ship:
 *
 *   1. **The vendor consents, per builder, per document.** Nothing is copied
 *      automatically and no builder can browse another builder's compliance.
 *      The only actor who can move a document is the vendor it belongs to.
 *   2. **The receiving builder reviews it themselves.** A share produces an
 *      ordinary `pending_review` document in the receiving org, checked against
 *      that org's own requirements. Approval never travels.
 *   3. **The copy is a copy.** The file is duplicated into the receiving org's
 *      storage path, so revoking access in one org cannot pull a document out
 *      from under another, and neither org's RLS ever has to reach across.
 */

export interface PortableComplianceDocument {
  sourceDocumentId: string
  sourceOrgId: string
  sourceOrgName: string
  documentTypeCode: string
  documentTypeName: string
  /** The matching active type in the receiving org, when one exists. */
  targetDocumentTypeId: string | null
  carrierName: string | null
  policyNumber: string | null
  coverageAmountCents: number | null
  effectiveDate: string | null
  expiryDate: string | null
  additionalInsured: boolean
  primaryNoncontributory: boolean
  waiverOfSubrogation: boolean
  fileName: string | null
  /** True once this document has already been shared into the receiving org. */
  alreadyShared: boolean
}

/**
 * The companies, across every org, that belong to this person.
 *
 * The email MUST come from a signed-in `external_identities` session, never
 * from the contact row a portal token points at. A builder controls the
 * contacts in their own org: given a contact email they typed themselves, this
 * lookup would happily return another builder's certificates for that vendor.
 * Requiring the session means the caller has actually authenticated as the
 * vendor, which is the only thing that makes cross-org reads safe.
 */
async function findCompaniesForIdentity(
  supabase: SupabaseClient,
  contactEmail: string,
): Promise<Array<{ orgId: string; companyId: string }>> {
  const email = contactEmail.trim().toLowerCase()
  if (!email) return []

  const [{ data: contacts }, { data: companies }] = await Promise.all([
    supabase.from("contacts").select("org_id, primary_company_id").eq("email", email),
    supabase.from("companies").select("id, org_id").eq("email", email),
  ])

  const pairs = new Map<string, { orgId: string; companyId: string }>()
  for (const contact of contacts ?? []) {
    if (!contact.primary_company_id) continue
    pairs.set(`${contact.org_id}:${contact.primary_company_id}`, {
      orgId: contact.org_id,
      companyId: contact.primary_company_id,
    })
  }
  for (const company of companies ?? []) {
    pairs.set(`${company.org_id}:${company.id}`, { orgId: company.org_id, companyId: company.id })
  }
  return Array.from(pairs.values())
}

/**
 * Documents this vendor has already given another builder that could answer a
 * requirement here.
 *
 * Only approved, unexpired, unrevoked documents travel: a certificate another
 * builder rejected is not evidence, and offering an expired one would just move
 * the problem.
 */
export async function listPortableComplianceDocuments(params: {
  targetOrgId: string
  targetCompanyId: string
  /** From a verified external-identity session. Never a contact row. */
  identityEmail: string | null
}): Promise<PortableComplianceDocument[]> {
  if (!params.identityEmail) return []
  const supabase = createServiceSupabaseClient()

  const identityCompanies = await findCompaniesForIdentity(supabase, params.identityEmail)
  const foreign = identityCompanies.filter((pair) => pair.orgId !== params.targetOrgId)
  if (foreign.length === 0) return []

  const today = new Date().toISOString().slice(0, 10)
  const [{ data: documents }, { data: targetTypes }, { data: shares }] = await Promise.all([
    supabase
      .from("compliance_documents")
      .select(
        `
        id, org_id, company_id, status, expiry_date, effective_date, policy_number,
        coverage_amount_cents, carrier_name, additional_insured, primary_noncontributory,
        waiver_of_subrogation, revoked_at, superseded_by_id,
        compliance_document_types (code, name),
        files (file_name),
        orgs (name)
      `,
      )
      .in("company_id", foreign.map((pair) => pair.companyId))
      .eq("status", "approved")
      .is("revoked_at", null)
      .is("superseded_by_id", null),
    supabase
      .from("compliance_document_types")
      .select("id, code")
      .eq("org_id", params.targetOrgId)
      .eq("is_active", true),
    supabase
      .from("vendor_document_shares")
      .select("source_document_id")
      .eq("target_org_id", params.targetOrgId),
  ])

  const foreignOrgByCompany = new Map(foreign.map((pair) => [pair.companyId, pair.orgId]))
  const targetTypeByCode = new Map(
    (targetTypes ?? []).map((type: any) => [String(type.code), String(type.id)]),
  )
  const sharedSourceIds = new Set((shares ?? []).map((share: any) => share.source_document_id))

  return (documents ?? [])
    .filter((row: any) => foreignOrgByCompany.get(row.company_id) === row.org_id)
    .filter((row: any) => !row.expiry_date || row.expiry_date >= today)
    .map((row: any) => {
      const type = Array.isArray(row.compliance_document_types)
        ? row.compliance_document_types[0]
        : row.compliance_document_types
      const file = Array.isArray(row.files) ? row.files[0] : row.files
      const org = Array.isArray(row.orgs) ? row.orgs[0] : row.orgs
      return {
        sourceDocumentId: row.id as string,
        sourceOrgId: row.org_id as string,
        sourceOrgName: org?.name ?? "Another builder",
        documentTypeCode: type?.code ?? "",
        documentTypeName: type?.name ?? "Compliance document",
        targetDocumentTypeId: targetTypeByCode.get(type?.code ?? "") ?? null,
        carrierName: row.carrier_name ?? null,
        policyNumber: row.policy_number ?? null,
        coverageAmountCents: row.coverage_amount_cents ?? null,
        effectiveDate: row.effective_date ?? null,
        expiryDate: row.expiry_date ?? null,
        additionalInsured: Boolean(row.additional_insured),
        primaryNoncontributory: Boolean(row.primary_noncontributory),
        waiverOfSubrogation: Boolean(row.waiver_of_subrogation),
        fileName: file?.file_name ?? null,
        alreadyShared: sharedSourceIds.has(row.id),
      }
    })
    // A document type this builder does not ask for is noise to the vendor.
    .filter((document) => document.targetDocumentTypeId !== null)
}

/**
 * Copy one document the vendor has consented to share into the receiving org.
 *
 * The receiving builder gets a `pending_review` document like any other: their
 * requirements, their reviewer, their decision. Endorsement flags travel as the
 * vendor stated them originally, which the reviewer can correct while deciding.
 */
export async function shareComplianceDocumentToOrg(params: {
  sourceDocumentId: string
  targetOrgId: string
  targetCompanyId: string
  /** From a verified external-identity session. Never a contact row. */
  identityEmail: string
  externalIdentityId: string
  portalTokenId: string | null
}): Promise<{ documentId: string }> {
  const supabase = createServiceSupabaseClient()

  const identityCompanies = await findCompaniesForIdentity(supabase, params.identityEmail)
  const reachable = new Set(identityCompanies.map((pair) => `${pair.orgId}:${pair.companyId}`))

  const { data: source, error: sourceError } = await supabase
    .from("compliance_documents")
    .select(
      `
      *,
      compliance_document_types (code, name),
      files (id, file_name, storage_path, mime_type, size_bytes)
    `,
    )
    .eq("id", params.sourceDocumentId)
    .maybeSingle()

  if (sourceError || !source) throw new Error("That document is no longer available")
  // The vendor may only move a document belonging to a company they themselves
  // can reach. Without this the id alone would be a capability.
  if (!reachable.has(`${source.org_id}:${source.company_id}`)) {
    throw new Error("That document does not belong to your company")
  }
  if (source.org_id === params.targetOrgId) {
    throw new Error("That document is already filed with this builder")
  }
  if (source.status !== "approved" || source.revoked_at) {
    throw new Error("Only an approved document can be shared")
  }

  const sourceType = Array.isArray(source.compliance_document_types)
    ? source.compliance_document_types[0]
    : source.compliance_document_types
  const sourceFile = Array.isArray(source.files) ? source.files[0] : source.files
  if (!sourceFile?.storage_path) throw new Error("That document has no file attached")

  const { data: targetType } = await supabase
    .from("compliance_document_types")
    .select("id, name")
    .eq("org_id", params.targetOrgId)
    .eq("code", sourceType?.code ?? "")
    .eq("is_active", true)
    .maybeSingle()

  if (!targetType) throw new Error("This builder does not ask for that document")

  // A real copy, not a cross-org pointer: each org owns its own object, so
  // access ending in one org can never pull a document out of another.
  const bytes = await downloadFilesObject({
    supabase,
    orgId: source.org_id,
    path: sourceFile.storage_path,
  })
  const safeName = (sourceFile.file_name ?? "compliance-document.pdf").replace(/[^\w.\-]+/g, "_")
  const { storagePath } = await uploadFilesObject({
    supabase,
    orgId: params.targetOrgId,
    path: `${params.targetOrgId}/compliance/${params.targetCompanyId}/${Date.now()}_${safeName}`,
    bytes,
    contentType: sourceFile.mime_type ?? "application/pdf",
  })

  const { data: newFile, error: fileError } = await supabase
    .from("files")
    .insert({
      org_id: params.targetOrgId,
      file_name: sourceFile.file_name ?? safeName,
      storage_path: storagePath,
      mime_type: sourceFile.mime_type ?? "application/pdf",
      size_bytes: bytes.byteLength,
      visibility: "private",
      source: "portal",
      metadata: {
        uploaded_via_portal: true,
        portal_token_id: params.portalTokenId,
        company_id: params.targetCompanyId,
        file_type: "compliance_document",
        shared_from_org_id: source.org_id,
      },
    })
    .select("id")
    .single()

  if (fileError || !newFile) throw new Error("Could not file the shared document")

  const { data: requirement } = await supabase
    .from("company_compliance_requirements")
    .select("id")
    .eq("org_id", params.targetOrgId)
    .eq("company_id", params.targetCompanyId)
    .eq("document_type_id", targetType.id)
    .maybeSingle()

  const { data: created, error: createError } = await supabase
    .from("compliance_documents")
    .insert({
      org_id: params.targetOrgId,
      company_id: params.targetCompanyId,
      document_type_id: targetType.id,
      requirement_id: requirement?.id ?? null,
      file_id: newFile.id,
      status: "pending_review",
      submitted_via_portal: true,
      portal_token_id: params.portalTokenId,
      effective_date: source.effective_date,
      expiry_date: source.expiry_date,
      policy_number: source.policy_number,
      coverage_amount_cents: source.coverage_amount_cents,
      carrier_name: source.carrier_name,
      additional_insured: source.additional_insured,
      primary_noncontributory: source.primary_noncontributory,
      waiver_of_subrogation: source.waiver_of_subrogation,
      license_number: source.license_number,
      license_jurisdiction: source.license_jurisdiction,
      license_classification: source.license_classification,
    })
    .select("id")
    .single()

  if (createError || !created) throw new Error("Could not file the shared document")

  await supabase
    .from("compliance_documents")
    .update({ superseded_by_id: created.id })
    .eq("org_id", params.targetOrgId)
    .eq("company_id", params.targetCompanyId)
    .eq("document_type_id", targetType.id)
    .neq("id", created.id)
    .is("superseded_by_id", null)

  await supabase.from("vendor_document_shares").insert({
    source_org_id: source.org_id,
    source_document_id: source.id,
    target_org_id: params.targetOrgId,
    target_document_id: created.id,
    external_identity_id: params.externalIdentityId,
    shared_by_contact_email: params.identityEmail.trim().toLowerCase(),
    portal_token_id: params.portalTokenId,
  })

  const { data: company } = await supabase
    .from("companies")
    .select("name")
    .eq("org_id", params.targetOrgId)
    .eq("id", params.targetCompanyId)
    .maybeSingle()

  await recordEvent({
    orgId: params.targetOrgId,
    eventType: "compliance_document_submitted",
    entityType: "compliance_document",
    entityId: created.id,
    channel: "notification",
    payload: {
      company_id: params.targetCompanyId,
      company_name: company?.name ?? null,
      document_name: targetType.name,
      document_type_id: targetType.id,
      shared_from_another_builder: true,
    },
  }).catch(() => null)

  return { documentId: created.id }
}
