import "server-only"
import { z } from "zod"
import { recordAudit } from "@/lib/services/audit"
import { requireBooksAuthorization } from "@/lib/services/books/access"
import { booksDigest } from "@/lib/services/books/hash"
import { companyOwnership } from "@/lib/services/books/legal-entities"
import { buildFilingFile, buildPackageSnapshot, packageSnapshotSchema, validateFilingFile } from "@/lib/services/books/vendor-1099-filing-rules"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { getVendor1099Report } from "@/lib/services/reports/vendor-1099"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

const PACKAGE_COLUMNS = "id,legal_entity_id,tax_year,form_type,status,threshold_cents,policy_source,snapshot,digest,payee_count,total_cents,prepared_by,prepared_at,reviewed_by,reviewed_at,review_notes,submitted_by,submitted_at,partner,partner_reference,outcome_by,outcome_at,outcome_notes,closed_by,closed_at,close_reason,supersedes_id"
const year = z.number().int().min(2000).max(2200)

async function access(permission: "books.read" | "books.tax") {
  const context = await requireOrgContext()
  await requireBooksAuthorization({ permission, userId: context.userId, orgId: context.orgId, supabase: context.supabase, resourceType: "books_1099_package", resourceId: context.orgId, logDecision: true })
  return context
}

async function record(orgId: string, actorId: string, packageId: string, eventType: string, payload: Record<string, unknown>) {
  await Promise.all([
    recordEvent({ orgId, actorId, eventType, entityType: "books_1099_package", entityId: packageId, payload }),
    recordAudit({ orgId, actorId, action: "update", entityType: "books_1099_package", entityId: packageId, after: payload, source: "books.tax" }),
  ])
}

/** What one paying company would file today, from current payments and identities. */
async function currentSnapshot(orgId: string, taxYear: number, legalEntityId: string) {
  const service = createServiceSupabaseClient()
  const [report, payer] = await Promise.all([
    getVendor1099Report({ year: taxYear, orgId, legalEntityId }),
    service.from("books_legal_entities").select("id,name,legal_name,payer_tin_last4,payer_address").eq("org_id", orgId).eq("id", legalEntityId).maybeSingle(),
  ])
  if (payer.error) throw new Error(`Failed to load the paying company: ${payer.error.message}`)
  if (!payer.data) throw new Error("Company not found")
  const payeeIds = report.rows.filter((row) => row.meets_threshold).map((row) => row.company_id)
  const addresses = new Map<string, unknown>()
  for (let offset = 0; offset < payeeIds.length; offset += 200) {
    const { data, error } = await service.from("companies").select("id,address").eq("org_id", orgId).in("id", payeeIds.slice(offset, offset + 200))
    if (error) throw new Error(`Failed to load vendor addresses: ${error.message}`)
    for (const row of data ?? []) addresses.set(row.id, row.address)
  }
  const { data: policy, error: policyError } = await service.from("tax_policy_versions").select("source_url").eq("tax_year", taxYear).eq("form_type", "1099-NEC").eq("jurisdiction", "US")
    .or(`org_id.eq.${orgId},org_id.is.null`).order("org_id", { ascending: true, nullsFirst: false }).limit(1).maybeSingle()
  if (policyError) throw new Error(`Failed to load the 1099 policy: ${policyError.message}`)
  const built = buildPackageSnapshot({ taxYear, thresholdCents: report.threshold_cents, rows: report.rows, addresses,
    payer: { legalEntityId, name: payer.data.legal_name ?? payer.data.name, tinLast4: payer.data.payer_tin_last4, address: payer.data.payer_address } })
  return { built, policySource: policy?.source_url ?? "Approved 1099-NEC policy" }
}

const packageRow = z.object({ id: z.string().uuid(), legal_entity_id: z.string().uuid(), tax_year: z.number(), status: z.string(), snapshot: z.unknown(), digest: z.string(), supersedes_id: z.string().uuid().nullable() }).passthrough()
async function loadPackage(orgId: string, id: string) {
  const { data, error } = await createServiceSupabaseClient().from("books_1099_packages").select(PACKAGE_COLUMNS).eq("org_id", orgId).eq("id", z.string().uuid().parse(id)).maybeSingle()
  if (error) throw new Error(`Failed to load the 1099 package: ${error.message}`)
  if (!data) throw new Error("1099 package not found")
  return packageRow.parse(data)
}

/**
 * Each paying company's packages for a year, and whether it could be prepared
 * now. Payees show the last four of their taxpayer ID only.
 */
export async function getVendor1099Packages(taxYear: number) {
  const context = await access("books.read")
  const parsedYear = year.parse(taxYear)
  const service = createServiceSupabaseClient()
  const [companies, packages] = await Promise.all([
    service.from("books_legal_entities").select("id,name,legal_name,is_primary,payer_tin_last4,payer_address").eq("org_id", context.orgId).eq("status", "active").order("is_primary", { ascending: false }).order("name"),
    service.from("books_1099_packages").select(PACKAGE_COLUMNS).eq("org_id", context.orgId).eq("tax_year", parsedYear).order("prepared_at", { ascending: false }).limit(100),
  ])
  if (companies.error || packages.error) throw new Error(`Failed to load 1099 packages: ${(companies.error ?? packages.error)?.message}`)
  return {
    taxYear: parsedYear, userId: context.userId,
    companies: (companies.data ?? []).map((company) => ({ id: company.id, name: company.legal_name ?? company.name, isPrimary: company.is_primary, payerTinLast4: company.payer_tin_last4, hasAddress: Boolean(company.payer_address) })),
    packages: (packages.data ?? []).map((row) => ({ ...row, snapshot: packageSnapshotSchema.parse(row.snapshot) })),
  }
}

/** The paying company's own taxpayer ID (kept in Vault) and the address printed on its 1099s. */
export async function setPayerTaxIdentity(input: { legalEntityId: string; tin: string; address: { street1: string; city: string; state: string; postal_code: string } }) {
  const context = await access("books.tax")
  const parsed = z.object({ legalEntityId: z.string().uuid(), tin: z.string().transform((value) => value.replace(/\D/g, "")).pipe(z.string().regex(/^\d{9}$/, "A US taxpayer ID must contain exactly nine digits")),
    address: z.object({ street1: z.string().trim().min(1).max(200), city: z.string().trim().min(1).max(100), state: z.string().trim().regex(/^[A-Za-z]{2}$/, "Use the two-letter state"), postal_code: z.string().trim().regex(/^\d{5}(-?\d{4})?$/, "Use a five or nine digit ZIP") }) }).parse(input)
  const service = createServiceSupabaseClient()
  const { data, error } = await service.rpc("store_legal_entity_payer_tin_atomic", { p_org_id: context.orgId, p_legal_entity_id: parsed.legalEntityId, p_tin: parsed.tin, p_actor_id: context.userId })
  if (error) throw new Error(`Failed to secure the company's taxpayer ID: ${error.message}`)
  const { error: addressError } = await service.from("books_legal_entities").update({ payer_address: { ...parsed.address, state: parsed.address.state.toUpperCase() } }).eq("org_id", context.orgId).eq("id", parsed.legalEntityId)
  if (addressError) throw new Error(`Failed to save the company's address: ${addressError.message}`)
  await record(context.orgId, context.userId, parsed.legalEntityId, "books_payer_tax_identity_secured", { legal_entity_id: parsed.legalEntityId, tin_last4: String(data) })
  return { last4: String(data) }
}

/**
 * Freeze what one paying company files for a year. Refused, with every reason,
 * while any reportable vendor is blocked; a correction names the live package.
 */
export async function prepare1099Package(input: { taxYear: number; legalEntityId?: string | null; idempotencyKey: string; supersedesId?: string | null }) {
  const context = await access("books.tax")
  const parsed = z.object({ taxYear: year, legalEntityId: z.string().uuid().nullish(), idempotencyKey: z.string().min(10).max(200), supersedesId: z.string().uuid().nullish() }).parse(input)
  const legalEntityId = parsed.legalEntityId ?? (await companyOwnership(context.orgId))(null)
  const { built, policySource } = await currentSnapshot(context.orgId, parsed.taxYear, legalEntityId)
  if ("problems" in built) throw new Error(`This package cannot be prepared yet: ${built.problems.join("; ")}`)
  const snapshot = built.snapshot
  const service = createServiceSupabaseClient()
  const { data: existing } = await service.from("books_1099_packages").select("id").eq("org_id", context.orgId).eq("idempotency_key", parsed.idempotencyKey).maybeSingle()
  if (existing) return { id: existing.id }
  const { data, error } = await service.from("books_1099_packages").insert({
    org_id: context.orgId, legal_entity_id: legalEntityId, tax_year: parsed.taxYear, threshold_cents: snapshot.threshold_cents, policy_source: policySource,
    snapshot, digest: booksDigest(snapshot), payee_count: snapshot.payees.length, total_cents: snapshot.payees.reduce((sum, payee) => sum + payee.amount_cents, 0),
    prepared_by: context.userId, supersedes_id: parsed.supersedesId ?? null, idempotency_key: parsed.idempotencyKey,
  }).select("id").single()
  if (error) throw new Error(/one_draft/.test(error.message) ? "A package for this company and year is already prepared and waiting for review" : `Failed to prepare the 1099 package: ${error.message}`)
  await record(context.orgId, context.userId, data.id, "books_1099_package_prepared", { tax_year: parsed.taxYear, legal_entity_id: legalEntityId, payee_count: snapshot.payees.length, supersedes_id: parsed.supersedesId ?? null })
  return { id: z.string().uuid().parse(data.id) }
}

/** A second member approves what was prepared, only while payments still agree. */
export async function approve1099Package(input: { id: string; notes: string }) {
  const context = await access("books.tax")
  const parsed = z.object({ id: z.string().uuid(), notes: z.string().trim().min(10).max(2000) }).parse(input)
  const pkg = await loadPackage(context.orgId, parsed.id)
  const { built } = await currentSnapshot(context.orgId, pkg.tax_year, pkg.legal_entity_id)
  const current = "snapshot" in built ? booksDigest(built.snapshot) : null
  if (current !== pkg.digest) throw new Error("Payments or vendor details changed after this package was prepared. Withdraw it and prepare it again.")
  const { error } = await createServiceSupabaseClient().rpc("approve_books_1099_package", { p_org_id: context.orgId, p_package_id: parsed.id, p_actor_id: context.userId, p_notes: parsed.notes, p_current_digest: current })
  if (error) throw new Error(/someone other than/.test(error.message) ? "A 1099 package is approved by someone other than the person who prepared it" : `Failed to approve the 1099 package: ${error.message}`)
  await record(context.orgId, context.userId, parsed.id, "books_1099_package_approved", { supersedes_id: pkg.supersedes_id })
  return { id: parsed.id }
}

async function updatePackage(orgId: string, id: string, patch: Record<string, unknown>) {
  const { error } = await createServiceSupabaseClient().from("books_1099_packages").update(patch).eq("org_id", orgId).eq("id", id)
  if (error) throw new Error(error.message.match(/A 1099 package cannot move from \w+ to \w+/)?.[0] ?? `Failed to update the 1099 package: ${error.message}`)
}

/** Take back a package not yet filed. */
export async function withdraw1099Package(input: { id: string; reason: string }) {
  const context = await access("books.tax")
  const parsed = z.object({ id: z.string().uuid(), reason: z.string().trim().min(10).max(2000) }).parse(input)
  await loadPackage(context.orgId, parsed.id)
  await updatePackage(context.orgId, parsed.id, { status: "withdrawn", closed_by: context.userId, closed_at: new Date().toISOString(), close_reason: parsed.reason })
  await record(context.orgId, context.userId, parsed.id, "books_1099_package_withdrawn", { reason: parsed.reason })
  return { id: parsed.id }
}

/** The approved file was handed to a filing partner (again, after a rejection). */
export async function record1099Submission(input: { id: string; partner: string; reference?: string | null }) {
  const context = await access("books.tax")
  const parsed = z.object({ id: z.string().uuid(), partner: z.string().trim().min(2).max(120), reference: z.string().trim().max(200).nullish() }).parse(input)
  await loadPackage(context.orgId, parsed.id)
  await updatePackage(context.orgId, parsed.id, { status: "submitted", submitted_by: context.userId, submitted_at: new Date().toISOString(), partner: parsed.partner, partner_reference: parsed.reference ?? null })
  await record(context.orgId, context.userId, parsed.id, "books_1099_package_submitted", { partner: parsed.partner, reference: parsed.reference ?? null })
  return { id: parsed.id }
}

/** What the partner (or the IRS through it) said about the submission. */
export async function record1099Outcome(input: { id: string; outcome: "accepted" | "rejected"; notes: string }) {
  const context = await access("books.tax")
  const parsed = z.object({ id: z.string().uuid(), outcome: z.enum(["accepted", "rejected"]), notes: z.string().trim().min(3).max(2000) }).parse(input)
  await loadPackage(context.orgId, parsed.id)
  await updatePackage(context.orgId, parsed.id, { status: parsed.outcome, outcome_by: context.userId, outcome_at: new Date().toISOString(), outcome_notes: parsed.notes })
  await record(context.orgId, context.userId, parsed.id, `books_1099_package_${parsed.outcome}`, { notes: parsed.notes })
  return { id: parsed.id }
}

/**
 * The filing-partner import file of an approved package, with full taxpayer IDs
 * read from Vault for this download only. Checked against the import format and
 * the approved totals before it is returned; every download is on record.
 */
export async function build1099FilingFile(id: string) {
  const context = await access("books.tax")
  const pkg = await loadPackage(context.orgId, id)
  const snapshot = packageSnapshotSchema.parse(pkg.snapshot)
  const { data, error } = await createServiceSupabaseClient().rpc("books_1099_filing_identities", { p_org_id: context.orgId, p_package_id: pkg.id })
  if (error) throw new Error(error.message.includes("Only an approved") ? "Only an approved 1099 package has a filing file" : `Failed to read taxpayer IDs: ${error.message}`)
  const identities = z.object({ payer: z.string().nullable(), payees: z.record(z.string()) }).parse(data)
  const content = buildFilingFile(snapshot, identities)
  const checked = validateFilingFile(content, snapshot)
  await record(context.orgId, context.userId, pkg.id, "books_1099_filing_file_downloaded", { rows: checked.rows, total_cents: checked.totalCents })
  return { filename: `1099-NEC-${pkg.tax_year}-${snapshot.payer.name.replace(/[^A-Za-z0-9]+/g, "-")}.csv`, content }
}
