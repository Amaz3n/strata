import "server-only"
import { createHash } from "node:crypto"
import { z } from "zod"
import type { SupabaseClient } from "@supabase/supabase-js"
import { normalizeSha256, parseAgreementSigners, type AgreementSigner } from "@/lib/cutover/records"
import { normalizeKey } from "@/lib/services/import-parsers"
import { recordAudit } from "@/lib/services/audit"
import { getProjectReadScopeForUser, requireAuthorization } from "@/lib/services/authorization"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import { downloadFilesObject } from "@/lib/storage/files-storage"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import { attachAgreementEvidenceSchema, acceptAgreementEvidenceSchema } from "@/lib/validation/cutover"
import { chunks, freshCopies, refuseChangedRows, resolveCutoverHomes, settleRow, todayUtc, type CutoverImportContext, type CutoverStagedRow } from "@/lib/services/cutover/homes"

/** Evidence the review queue shows at once; past it the page says how many more wait. */
const QUEUE_CAP = 200
const CANDIDATE_FILES_PER_HOME = 20

const contractSchema = z.object({ id: z.string().uuid(), project_id: z.string().uuid(), number: z.string().nullable(), total_cents: z.number().int().nullable(), signed_at: z.string().nullable() })
const evidenceSchema = z.object({ id: z.string().uuid(), contract_id: z.string().uuid(), project_id: z.string().uuid(), status: z.enum(["evidence_missing", "executed_file", "accepted"]) })
const fileSchema = z.object({ id: z.string().uuid(), file_name: z.string(), checksum: z.string().nullable(), project_id: z.string().uuid().nullable() })
const signersSchema = z.array(z.object({ name: z.string().min(1), email: z.string().email().nullable() })).min(1)

async function readIn<Row>(label: string, ids: readonly string[], read: (group: string[]) => PromiseLike<{ data: unknown; error: { message: string } | null }>, schema: z.ZodType<Row>) {
  const results = await Promise.all(chunks(ids).map((group) => read(group)))
  return results.flatMap((result) => { if (result.error) throw new Error(`${label}: ${result.error.message}`); return z.array(schema).parse(result.data ?? []) })
}

/**
 * Staging checks for a "Signed agreements" file. Each row names the home Open
 * WIP brought over; the agreement on it must be that import's, its total and
 * date must agree with what Open WIP recorded, and an executed copy is matched
 * by its SHA-256 among the org's files (uploaded through Documents first). A
 * row with no executed copy is a warning: the agreement stays evidence-missing
 * and waits for review.
 */
export async function validateAgreementRows<Row extends CutoverStagedRow>(rows: Row[], context: CutoverImportContext): Promise<Row[]> {
  const homes = await resolveCutoverHomes(rows, context)
  const projectIds = [...new Set([...homes.values()].map((home) => home.projectId))]
  const contracts = await readIn("Failed to read purchase agreements", projectIds, (group) => context.supabase.from("contracts").select("id,project_id,number,total_cents,signed_at")
    .eq("org_id", context.orgId).eq("contract_type", "purchase_agreement").eq("status", "active").in("project_id", group), contractSchema)
  const evidence = await readIn("Failed to read imported agreement evidence", contracts.map((contract) => contract.id), (group) => context.supabase.from("imported_agreement_evidence")
    .select("id,contract_id,project_id,status").eq("org_id", context.orgId).in("contract_id", group), evidenceSchema)
  const hashes = [...new Set(rows.flatMap((row) => { const hash = normalizeSha256(row.parsed.executed_sha256); return hash ? [hash] : [] }))]
  const names = [...new Set(rows.flatMap((row) => (typeof row.parsed.executed_file === "string" && row.parsed.executed_file ? [row.parsed.executed_file] : [])))]
  const [byHash, byName] = await Promise.all([
    readIn("Failed to read executed files", hashes, (group) => context.supabase.from("files").select("id,file_name,checksum,project_id").eq("org_id", context.orgId).is("archived_at", null).in("checksum", group), fileSchema),
    readIn("Failed to read executed files", names, (group) => context.supabase.from("files").select("id,file_name,checksum,project_id").eq("org_id", context.orgId).is("archived_at", null).in("file_name", group), fileSchema),
  ])
  const contractsByProject = new Map<string, z.infer<typeof contractSchema>[]>()
  for (const contract of contracts) contractsByProject.set(contract.project_id, [...(contractsByProject.get(contract.project_id) ?? []), contract])
  const evidenceByContract = new Map(evidence.map((row) => [row.contract_id, row]))

  for (const row of rows) {
    const home = homes.get(row.id)
    if (!home) { settleRow(row); continue }
    const add = (level: "error" | "warning", code: string, message: string, column?: string) => { row.issues.push({ level, code, message, column }) }
    const parsed = row.parsed
    const agreements = contractsByProject.get(home.projectId) ?? []
    if (agreements.length !== 1) {
      add("error", agreements.length ? "multiple_agreements" : "no_agreement", agreements.length ? "The home has more than one active purchase agreement; reconcile it first" : "The home has no active purchase agreement", "lot_number")
      settleRow(row); continue
    }
    const contract = agreements[0]
    const record = evidenceByContract.get(contract.id)
    if (!record) { add("error", "agreement_not_imported", "This agreement was signed in Arc and carries its own executed record", "lot_number"); settleRow(row); continue }
    parsed.contract_id = contract.id
    parsed.evidence_id = record.id
    if (record.status !== "evidence_missing") add("warning", "already_evidenced", "This agreement's evidence is already on file; it is matched and left as it is")
    if (typeof parsed.sale_price_cents === "number" && parsed.sale_price_cents !== contract.total_cents) add("error", "agreement_total_mismatch", `Open WIP recorded this agreement at ${contract.total_cents ?? 0} cents`, "sale_price_cents")
    const recordedDate = contract.signed_at ? contract.signed_at.slice(0, 10) : null
    if (typeof parsed.signed_date === "string" && recordedDate && parsed.signed_date !== recordedDate) add("error", "signed_date_mismatch", `Open WIP recorded this agreement as signed on ${recordedDate}`, "signed_date")
    if (typeof parsed.signed_date === "string" && parsed.signed_date > todayUtc()) add("error", "signed_in_future", "An executed agreement cannot be signed in the future", "signed_date")
    if (typeof parsed.deposit_cents === "number" && parsed.deposit_cents < 0) add("error", "negative_deposit", "Deposits received cannot be negative", "deposit_cents")
    const signers = parseAgreementSigners(parsed.signers)
    if (!signers) add("error", "invalid_signers", "Write signers as Name <email>, separated by semicolons", "signers")
    else parsed.signers_json = JSON.stringify(signers)

    const fileName = typeof parsed.executed_file === "string" && parsed.executed_file ? parsed.executed_file : null
    const rawHash = typeof parsed.executed_sha256 === "string" && parsed.executed_sha256 ? parsed.executed_sha256 : null
    if (!fileName && !rawHash) {
      if (record.status === "evidence_missing") add("warning", "evidence_missing", "No executed copy: the agreement waits for review, and closing stays blocked until someone attaches the file or accepts it with a reason")
      settleRow(row); continue
    }
    const hash = normalizeSha256(rawHash)
    if (!fileName || !rawHash) add("error", "file_and_hash_required", "Give both the executed file's name and its SHA-256", fileName ? "executed_sha256" : "executed_file")
    else if (!hash) add("error", "invalid_sha256", "The SHA-256 must be 64 hexadecimal characters", "executed_sha256")
    else {
      const candidates = byHash.filter((file) => file.checksum === hash && (file.project_id === null || file.project_id === home.projectId))
      const file = candidates.find((item) => normalizeKey(item.file_name) === normalizeKey(fileName)) ?? candidates[0]
      if (!file) {
        const named = byName.some((item) => normalizeKey(item.file_name) === normalizeKey(fileName))
        add("error", named ? "executed_file_hash_mismatch" : "executed_file_not_found", named ? `A file named ${fileName} is in Documents, but its SHA-256 differs from this row's` : `Upload ${fileName} to Documents before importing; no file with this SHA-256 is on file for the home`, named ? "executed_sha256" : "executed_file")
      } else {
        if (normalizeKey(file.file_name) !== normalizeKey(fileName)) add("warning", "executed_file_renamed", `Matched by SHA-256 to ${file.file_name}`, "executed_file")
        parsed.file_id = file.id
        parsed.file_sha256 = hash
      }
    }
    if (signers && signers.length === 0) add("error", "signers_required", "Name who signed the executed copy", "signers")
    const signedOn = typeof parsed.signed_date === "string" ? parsed.signed_date : recordedDate
    if (!signedOn) add("error", "signed_date_required", "Give the date the agreement was signed", "signed_date")
    else parsed.signed_on = signedOn
    settleRow(row)
  }
  return rows
}

interface EvidenceWrite { evidenceId: string; contractId: string; projectId: string; fileId: string; expectedSha256: string | null; signers: AgreementSigner[]; signedOn: string; provenance: Record<string, unknown> }

const storedFileSchema = z.object({ id: z.string().uuid(), storage_path: z.string(), checksum: z.string().nullable(), project_id: z.string().uuid().nullable() })

/**
 * The SHA-256 of the executed copy's bytes as they sit in storage, computed
 * here. `files.checksum` is only a lookup hint: on the direct-upload path the
 * browser supplies it, so it is never the hash an agreement is bound by. A
 * file whose recorded checksum disagrees with its bytes is refused outright.
 */
async function verifyStoredSha256(supabase: SupabaseClient, orgId: string, fileId: string, expected: string | null) {
  const { data, error } = await supabase.from("files").select("id,storage_path,checksum,project_id").eq("org_id", orgId).eq("id", fileId).is("archived_at", null).maybeSingle()
  if (error) throw new Error(`Failed to read the executed copy: ${error.message}`)
  if (!data) throw new Error("The executed copy is no longer in Documents")
  const file = storedFileSchema.parse(data)
  let bytes: Buffer
  try {
    bytes = await downloadFilesObject({ supabase, orgId, path: file.storage_path })
  } catch (cause) {
    throw new Error(`The executed copy could not be read from storage to verify its SHA-256 (${cause instanceof Error ? cause.message : String(cause)}). Nothing was bound.`)
  }
  const sha256 = createHash("sha256").update(bytes).digest("hex")
  const recorded = normalizeSha256(file.checksum)
  if (recorded && recorded !== sha256) throw new Error("The executed copy's stored bytes do not match the checksum recorded at upload; upload it again through Documents")
  if (expected && expected !== sha256) throw new Error("The executed copy's stored bytes do not match the SHA-256 the source recorded")
  return sha256
}

/** Binds an executed copy: its bytes are hashed here, then a signed Documents row for the agreement, then the evidence row's one transition. */
async function bindExecutedCopy(supabase: SupabaseClient, orgId: string, actorId: string, write: EvidenceWrite, extra: Record<string, unknown>) {
  const sha256 = await verifyStoredSha256(supabase, orgId, write.fileId, write.expectedSha256)
  const { data: document, error: documentError } = await supabase.from("documents").insert({
    org_id: orgId, project_id: write.projectId, document_type: "contract", title: "Executed purchase agreement (imported)", status: "signed",
    source_file_id: write.fileId, executed_file_id: write.fileId, source_entity_type: "contract", source_entity_id: write.contractId, created_by: actorId,
    metadata: { imported_agreement: true, sha256, sha256_source: "server_read", signers: write.signers, signed_on: write.signedOn, ...write.provenance },
  }).select("id").single()
  if (documentError || !document) throw new Error(`Failed to record the executed copy: ${documentError?.message ?? "no row returned"}`)
  const { data: saved, error } = await supabase.from("imported_agreement_evidence").update({
    status: "executed_file", document_id: document.id, file_id: write.fileId, file_sha256: sha256, file_sha256_verified_at: new Date().toISOString(), signers: write.signers, signed_on: write.signedOn, ...extra,
  }).eq("org_id", orgId).eq("id", write.evidenceId).eq("status", "evidence_missing").select("id").maybeSingle()
  if (error || !saved) {
    await supabase.from("documents").delete().eq("org_id", orgId).eq("id", document.id)
    throw new Error(`Failed to bind the executed copy: ${error?.message ?? "the agreement was reviewed meanwhile"}`)
  }
  return sha256
}

/**
 * Records each row's evidence on the agreement Open WIP imported: the executed
 * copy, its signers and date, and the deposits the source says were received.
 * Evidence already on file is matched, never replaced.
 */
export async function commitAgreementRows(rows: CutoverStagedRow[], context: CutoverImportContext, batchId: string) {
  if (!context.platform) await requirePermission("closing.manage", context)
  const rechecked = await validateAgreementRows(freshCopies(rows), context)
  refuseChangedRows(rechecked)
  const results = new Map<string, { id: string; action: string }>()
  const evidenced: string[] = []
  for (const row of rechecked) {
    const parsed = row.parsed
    const evidenceId = String(parsed.evidence_id)
    if (row.issues.some((issue) => issue.code === "already_evidenced")) { results.set(row.id, { id: String(parsed.project_id), action: "skipped_existing" }); continue }
    const provenance = { source_batch_id: batchId, source_row_id: row.id, source_deposit_cents: typeof parsed.deposit_cents === "number" ? parsed.deposit_cents : null }
    if (typeof parsed.file_id === "string") {
      const signers = signersSchema.parse(JSON.parse(String(parsed.signers_json)))
      await bindExecutedCopy(context.supabase, context.orgId, context.userId, { evidenceId, contractId: String(parsed.contract_id), projectId: String(parsed.project_id), fileId: parsed.file_id, expectedSha256: String(parsed.file_sha256), signers, signedOn: String(parsed.signed_on), provenance: { import_batch_id: batchId, import_row_id: row.id } }, provenance)
      evidenced.push(evidenceId)
      results.set(row.id, { id: String(parsed.project_id), action: "created" })
    } else {
      const signers = typeof parsed.signers_json === "string" ? JSON.parse(parsed.signers_json) : []
      const { error } = await context.supabase.from("imported_agreement_evidence").update({ ...provenance, signers, signed_on: typeof parsed.signed_date === "string" ? parsed.signed_date : null })
        .eq("org_id", context.orgId).eq("id", evidenceId).eq("status", "evidence_missing")
      if (error) throw new Error(`Row ${row.row_number}: ${error.message}`)
      await recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "imported_agreement_evidence", entityId: evidenceId, after: { status: "evidence_missing", ...provenance, signed_on: typeof parsed.signed_date === "string" ? parsed.signed_date : null } })
      results.set(row.id, { id: String(parsed.project_id), action: "updated" })
    }
  }
  if (evidenced.length) {
    await Promise.all(evidenced.map((id) => Promise.all([
      recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "imported_agreement_evidence_recorded", entityType: "imported_agreement_evidence", entityId: id, payload: { source: "import", batch_id: batchId } }),
      recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "imported_agreement_evidence", entityId: id, after: { status: "executed_file", batch_id: batchId } }),
    ])))
  }
  return results
}

/** True when the home's active agreement came over without an executed copy and no one has reviewed it. */
export async function importedAgreementEvidenceMissing(supabase: SupabaseClient, orgId: string, projectId: string) {
  const { data, error } = await supabase.from("imported_agreement_evidence").select("id, contract:contracts!inner(status)")
    .eq("org_id", orgId).eq("project_id", projectId).eq("status", "evidence_missing").eq("contract.status", "active").limit(1)
  if (error) throw new Error(`Failed to check the imported agreement's evidence: ${error.message}`)
  return (data ?? []).length > 0
}

const queueRowSchema = z.object({
  id: z.string().uuid(), project_id: z.string().uuid(), contract_id: z.string().uuid(), created_at: z.string(), source_deposit_cents: z.number().int().nullable(),
  contract: z.object({ number: z.string().nullable(), total_cents: z.number().int().nullable(), signed_at: z.string().nullable(), status: z.string() }),
  project: z.object({ name: z.string(), division_id: z.string().uuid().nullable() }),
})

export interface AgreementEvidenceQueueItem {
  id: string
  projectId: string
  home: string
  agreementNumber: string | null
  totalCents: number | null
  signedOn: string | null
  sourceDepositCents: number | null
  files: Array<{ id: string; name: string }>
}

async function reviewerContext() {
  const context = await requireOrgContext()
  return { ...context, service: createServiceSupabaseClient() }
}

/** Imported agreements still without an executed copy, oldest first, on the homes the reviewer can read. */
export async function listAgreementEvidenceQueue(): Promise<{ items: AgreementEvidenceQueueItem[]; total: number }> {
  const context = await reviewerContext()
  await requirePermission("closing.manage", context)
  const scope = await getProjectReadScopeForUser({ orgId: context.orgId, userId: context.userId })
  const access = scope.projectMembershipRequired ? ",access:project_members!project_members_project_id_fkey!inner()" : ""
  let query = context.service.from("imported_agreement_evidence")
    .select(`id,project_id,contract_id,created_at,source_deposit_cents,contract:contracts!inner(number,total_cents,signed_at,status),project:projects!inner(name,division_id${access})`, { count: "exact" })
    .eq("org_id", context.orgId).eq("status", "evidence_missing").eq("contract.status", "active").eq("project.org_id", context.orgId)
  if (scope.divisionIds) query = query.in("project.division_id", scope.divisionIds)
  if (scope.projectMembershipRequired) query = query.eq("project.access.org_id", context.orgId).eq("project.access.user_id", context.userId).eq("project.access.status", "active")
  const { data, error, count } = await query.order("created_at").order("id").limit(QUEUE_CAP)
  if (error) throw new Error(`Failed to load the agreement review queue: ${error.message}`)
  const rows = z.array(queueRowSchema).parse(data ?? [])
  const files = await readIn("Failed to read the homes' documents", [...new Set(rows.map((row) => row.project_id))], (group) => context.service.from("files")
    .select("id,file_name,checksum,project_id").eq("org_id", context.orgId).is("archived_at", null).eq("mime_type", "application/pdf").in("project_id", group).order("created_at", { ascending: false }), fileSchema)
  return {
    total: count ?? rows.length,
    items: rows.map((row) => ({
      id: row.id, projectId: row.project_id, home: row.project.name, agreementNumber: row.contract.number, totalCents: row.contract.total_cents,
      signedOn: row.contract.signed_at ? row.contract.signed_at.slice(0, 10) : null, sourceDepositCents: row.source_deposit_cents,
      files: files.filter((file) => file.project_id === row.project_id).slice(0, CANDIDATE_FILES_PER_HOME).map((file) => ({ id: file.id, name: file.file_name })),
    })),
  }
}

async function loadReviewable(context: Awaited<ReturnType<typeof reviewerContext>>, evidenceId: string) {
  const { data, error } = await context.service.from("imported_agreement_evidence").select("id,project_id,contract_id,status")
    .eq("org_id", context.orgId).eq("id", evidenceId).maybeSingle()
  if (error) throw new Error(`Failed to load the imported agreement: ${error.message}`)
  const row = data ? z.object({ id: z.string().uuid(), project_id: z.string().uuid(), contract_id: z.string().uuid(), status: z.string() }).parse(data) : null
  if (!row) throw new Error("Imported agreement not found")
  // Closing authority on this home, as the closing itself checks it: division and project scope included.
  await requireAuthorization({ permission: "closing.manage", orgId: context.orgId, userId: context.userId, projectId: row.project_id, supabase: context.supabase,
    resourceType: "imported_agreement_evidence", resourceId: row.id, logDecision: true })
  if (row.status !== "evidence_missing") throw new Error("This agreement has already been reviewed")
  return row
}

/** A reviewer attaches the executed copy uploaded to the home's Documents, with who signed it and when. */
export async function attachExecutedAgreement(input: unknown) {
  const parsed = attachAgreementEvidenceSchema.parse(input)
  const context = await reviewerContext()
  const row = await loadReviewable(context, parsed.evidenceId)
  const { data: file, error } = await context.service.from("files").select("id,file_name,checksum,project_id").eq("org_id", context.orgId).eq("id", parsed.fileId).is("archived_at", null).maybeSingle()
  if (error) throw new Error(`Failed to read the executed copy: ${error.message}`)
  const found = file ? fileSchema.parse(file) : null
  if (!found || (found.project_id !== null && found.project_id !== row.project_id)) throw new Error("Choose a file from this home's documents")
  const sha256 = await bindExecutedCopy(context.service, context.orgId, context.userId, { evidenceId: row.id, contractId: row.contract_id, projectId: row.project_id, fileId: found.id, expectedSha256: null, signers: parsed.signers, signedOn: parsed.signedOn, provenance: { reviewed: true } },
    { reviewed_by: context.userId, reviewed_at: new Date().toISOString() })
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "imported_agreement_evidence_recorded", entityType: "imported_agreement_evidence", entityId: row.id, payload: { source: "review", project_id: row.project_id, file_id: found.id } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "imported_agreement_evidence", entityId: row.id, before: { status: "evidence_missing" }, after: { status: "executed_file", file_id: found.id, sha256 } }),
  ])
  return { id: row.id, status: "executed_file" as const }
}

/** A reviewer accepts an imported agreement that has no executed copy, and says why. */
export async function acceptAgreementWithoutExecutedCopy(input: unknown) {
  const parsed = acceptAgreementEvidenceSchema.parse(input)
  const context = await reviewerContext()
  const row = await loadReviewable(context, parsed.evidenceId)
  const { data, error } = await context.service.from("imported_agreement_evidence").update({ status: "accepted", reviewed_by: context.userId, reviewed_at: new Date().toISOString(), review_reason: parsed.reason })
    .eq("org_id", context.orgId).eq("id", row.id).eq("status", "evidence_missing").select("id").maybeSingle()
  if (error || !data) throw new Error(`Failed to accept the agreement: ${error?.message ?? "it was reviewed meanwhile"}`)
  await Promise.all([
    recordEvent({ orgId: context.orgId, actorId: context.userId, eventType: "imported_agreement_evidence_accepted", entityType: "imported_agreement_evidence", entityId: row.id, payload: { project_id: row.project_id } }),
    recordAudit({ orgId: context.orgId, actorId: context.userId, action: "update", entityType: "imported_agreement_evidence", entityId: row.id, before: { status: "evidence_missing" }, after: { status: "accepted", reason: parsed.reason } }),
  ])
  return { id: row.id, status: "accepted" as const }
}
