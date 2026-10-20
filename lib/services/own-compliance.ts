import "server-only"

import type { SupabaseClient } from "@supabase/supabase-js"

import { isExpiredOn, todayKey } from "@/lib/compliance/dates"
import {
  OWN_DOCUMENT_REMINDER_HORIZON_DAYS,
  ownDocumentReminderEventId,
  ownDocumentReminderRung,
} from "@/lib/compliance/own-document-reminders"
import { recordAudit } from "@/lib/services/audit"
import {
  DocumentNotRequestedError,
  shareOwnComplianceDocumentToOrg,
} from "@/lib/services/compliance-portability"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { requirePermission } from "@/lib/services/permissions"
import { deleteFilesObjects, uploadFilesObject } from "@/lib/storage/files-storage"
import { createServiceSupabaseClient } from "@/lib/supabase/server"
import {
  OWN_COMPLIANCE_TYPE_CODES,
  OWN_COMPLIANCE_TYPE_LABELS,
  ownComplianceTypeCodeSchema,
  ownComplianceUploadSchema,
  shareOwnComplianceSchema,
  type OwnComplianceTypeCode,
} from "@/lib/validation/own-compliance"

/**
 * The company's own compliance vault: its certificate, W-9, license and bond,
 * stored once with their dates and shared from here to each builder it works for.
 *
 * "Every active builder connection" means the distinct builder orgs that hold an
 * ACTIVE `project_connections` row for this org, each paired with the company
 * row that builder keeps for us (`source_company_id`). That is the only
 * definition that carries the two things a share needs: a target company to
 * file against and a consent that is still standing. A sub-portal grant with no
 * linked job has neither a job nor a company link on our side, and a paused or
 * ended connection is a builder we have stopped working for; neither is shared to.
 * A builder appears once however many of our jobs it connects.
 *
 * Every read and write goes through the service client because the table is
 * service-write-only and the builders' types and shares live in other orgs;
 * `compliance.read` / `compliance.manage` is checked first, here.
 */

const MAX_FILE_BYTES = 25 * 1024 * 1024
const EXPIRY_SWEEP_PAGE = 500
const HISTORY_CAP = 25
const BUILDER_CAP = 200
const FILE_TYPES = new Set(["application/pdf", "image/jpeg", "image/png", "image/webp", "image/heic"])

export type OwnComplianceShareState = "shared" | "not_shared" | "not_requested"

export interface OwnComplianceBuilderStatus {
  builderOrgId: string
  builderName: string
  state: OwnComplianceShareState
}

export interface OwnComplianceDocument {
  id: string
  typeCode: OwnComplianceTypeCode
  typeLabel: string
  status: "current" | "superseded"
  fileId: string
  fileName: string
  effectiveDate: string | null
  expiryDate: string | null
  carrierName: string | null
  policyNumber: string | null
  coverageAmountCents: number | null
  licenseNumber: string | null
  licenseJurisdiction: string | null
  licenseClassification: string | null
  additionalInsured: boolean
  primaryNoncontributory: boolean
  waiverOfSubrogation: boolean
  uploadedAt: string
  /** One entry per active builder connection; empty for superseded rows. */
  builders: OwnComplianceBuilderStatus[]
}

export interface OwnComplianceVault {
  current: OwnComplianceDocument[]
  history: OwnComplianceDocument[]
  historyTruncated: boolean
  builderCount: number
}

export type OwnComplianceShareOutcomeStatus = "shared" | "already_shared" | "not_requested" | "failed"

export interface OwnComplianceShareOutcome {
  builderOrgId: string
  builderName: string
  status: OwnComplianceShareOutcomeStatus
  error?: string
}

interface OwnDocumentRow {
  id: string
  org_id: string
  document_type_code: string
  file_id: string
  status: "current" | "superseded"
  effective_date: string | null
  expiry_date: string | null
  carrier_name: string | null
  policy_number: string | null
  coverage_amount_cents: number | string | null
  license_number: string | null
  license_jurisdiction: string | null
  license_classification: string | null
  additional_insured: boolean
  primary_noncontributory: boolean
  waiver_of_subrogation: boolean
  created_at: string
}

interface FileRow {
  id: string
  file_name: string | null
  storage_path: string
  mime_type: string | null
}

interface BuilderConnection {
  builderOrgId: string
  builderName: string
  companyId: string
  portalTokenId: string
}

async function loadBuilderConnections(
  supabase: SupabaseClient,
  orgId: string,
): Promise<BuilderConnection[]> {
  const { data, error } = await supabase
    .from("project_connections")
    .select("source_org_id, source_org_name, source_company_id, portal_access_token_id")
    .eq("org_id", orgId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(BUILDER_CAP)
  if (error) throw new Error(`Failed to load builder connections: ${error.message}`)

  const byBuilder = new Map<string, BuilderConnection>()
  for (const row of data ?? []) {
    if (byBuilder.has(row.source_org_id)) continue
    byBuilder.set(row.source_org_id, {
      builderOrgId: row.source_org_id,
      builderName: row.source_org_name,
      companyId: row.source_company_id,
      portalTokenId: row.portal_access_token_id,
    })
  }
  return Array.from(byBuilder.values())
}

/** `builderOrgId:code` for every active type a builder asks its vendors for. */
async function loadRequestedTypes(
  supabase: SupabaseClient,
  builderOrgIds: string[],
): Promise<Set<string>> {
  if (builderOrgIds.length === 0) return new Set()
  const { data, error } = await supabase
    .from("compliance_document_types")
    .select("org_id, code")
    .in("org_id", builderOrgIds)
    .in("code", [...OWN_COMPLIANCE_TYPE_CODES])
    .eq("is_active", true)
  if (error) throw new Error(`Failed to load builder requirements: ${error.message}`)
  return new Set((data ?? []).map((row) => `${row.org_id}:${row.code}`))
}

async function loadSharedTargets(
  supabase: SupabaseClient,
  orgId: string,
  documentIds: string[],
): Promise<Set<string>> {
  if (documentIds.length === 0) return new Set()
  const { data, error } = await supabase
    .from("vendor_document_shares")
    .select("source_own_document_id, target_org_id")
    .eq("source_org_id", orgId)
    .in("source_own_document_id", documentIds)
  if (error) throw new Error(`Failed to load document shares: ${error.message}`)
  return new Set((data ?? []).map((row) => `${row.source_own_document_id}:${row.target_org_id}`))
}

async function loadFiles(supabase: SupabaseClient, orgId: string, fileIds: string[]): Promise<Map<string, FileRow>> {
  if (fileIds.length === 0) return new Map()
  const { data, error } = await supabase
    .from("files")
    .select("id, file_name, storage_path, mime_type")
    .eq("org_id", orgId)
    .in("id", fileIds)
  if (error) throw new Error(`Failed to load document files: ${error.message}`)
  const rows: FileRow[] = data ?? []
  return new Map(rows.map((row) => [row.id, row]))
}

function typeCode(value: string): OwnComplianceTypeCode {
  return ownComplianceTypeCodeSchema.parse(value)
}

function mapDocument(
  row: OwnDocumentRow,
  file: FileRow | undefined,
  builders: OwnComplianceBuilderStatus[],
): OwnComplianceDocument {
  const code = typeCode(row.document_type_code)
  return {
    id: row.id,
    typeCode: code,
    typeLabel: OWN_COMPLIANCE_TYPE_LABELS[code],
    status: row.status,
    fileId: row.file_id,
    fileName: file?.file_name ?? "Document",
    effectiveDate: row.effective_date,
    expiryDate: row.expiry_date,
    carrierName: row.carrier_name,
    policyNumber: row.policy_number,
    coverageAmountCents: row.coverage_amount_cents == null ? null : Number(row.coverage_amount_cents),
    licenseNumber: row.license_number,
    licenseJurisdiction: row.license_jurisdiction,
    licenseClassification: row.license_classification,
    additionalInsured: row.additional_insured,
    primaryNoncontributory: row.primary_noncontributory,
    waiverOfSubrogation: row.waiver_of_subrogation,
    uploadedAt: row.created_at,
    builders,
  }
}

export async function loadOwnComplianceVault(orgId?: string): Promise<OwnComplianceVault> {
  const context = await requireOrgContext(orgId)
  await requirePermission("compliance.read", context)
  const supabase = createServiceSupabaseClient()

  const [currentResult, historyResult, connections] = await Promise.all([
    supabase.from("own_compliance_documents").select("*").eq("org_id", context.orgId).eq("status", "current"),
    supabase
      .from("own_compliance_documents")
      .select("*")
      .eq("org_id", context.orgId)
      .eq("status", "superseded")
      .order("created_at", { ascending: false })
      .limit(HISTORY_CAP + 1),
    loadBuilderConnections(supabase, context.orgId),
  ])
  if (currentResult.error) throw new Error(`Failed to load compliance documents: ${currentResult.error.message}`)
  if (historyResult.error) throw new Error(`Failed to load compliance history: ${historyResult.error.message}`)

  const currentRows: OwnDocumentRow[] = currentResult.data ?? []
  const historyRows: OwnDocumentRow[] = historyResult.data ?? []
  const [requested, shared, files] = await Promise.all([
    loadRequestedTypes(supabase, connections.map((connection) => connection.builderOrgId)),
    loadSharedTargets(supabase, context.orgId, currentRows.map((row) => row.id)),
    loadFiles(supabase, context.orgId, [...currentRows, ...historyRows].map((row) => row.file_id)),
  ])

  const current = currentRows.map((row) =>
    mapDocument(
      row,
      files.get(row.file_id),
      connections.map((connection) => ({
        builderOrgId: connection.builderOrgId,
        builderName: connection.builderName,
        state: shared.has(`${row.id}:${connection.builderOrgId}`)
          ? "shared"
          : requested.has(`${connection.builderOrgId}:${row.document_type_code}`)
            ? "not_shared"
            : "not_requested",
      })),
    ),
  )
  const historyTruncated = historyRows.length > HISTORY_CAP
  return {
    current,
    history: historyRows.slice(0, HISTORY_CAP).map((row) => mapDocument(row, files.get(row.file_id), [])),
    historyTruncated,
    builderCount: connections.length,
  }
}

async function shareDocumentWithBuilders(
  supabase: SupabaseClient,
  row: OwnDocumentRow,
): Promise<OwnComplianceShareOutcome[]> {
  if (isExpiredOn(row.expiry_date)) {
    throw new Error("That document has expired. Upload the renewed one to share it.")
  }
  const [connections, files] = await Promise.all([
    loadBuilderConnections(supabase, row.org_id),
    loadFiles(supabase, row.org_id, [row.file_id]),
  ])
  const file = files.get(row.file_id)
  if (!file) throw new Error("That document has no file attached")

  const [requested, shared] = await Promise.all([
    loadRequestedTypes(supabase, connections.map((connection) => connection.builderOrgId)),
    loadSharedTargets(supabase, row.org_id, [row.id]),
  ])

  return Promise.all(
    connections.map(async (connection): Promise<OwnComplianceShareOutcome> => {
      const outcome = { builderOrgId: connection.builderOrgId, builderName: connection.builderName }
      if (shared.has(`${row.id}:${connection.builderOrgId}`)) return { ...outcome, status: "already_shared" }
      if (!requested.has(`${connection.builderOrgId}:${row.document_type_code}`)) {
        return { ...outcome, status: "not_requested" }
      }
      try {
        const result = await shareOwnComplianceDocumentToOrg(supabase, {
          ownDocumentId: row.id,
          source: {
            orgId: row.org_id,
            documentTypeCode: row.document_type_code,
            file: { file_name: file.file_name, storage_path: file.storage_path, mime_type: file.mime_type },
            facts: {
              effective_date: row.effective_date,
              expiry_date: row.expiry_date,
              policy_number: row.policy_number,
              coverage_amount_cents: row.coverage_amount_cents == null ? null : Number(row.coverage_amount_cents),
              carrier_name: row.carrier_name,
              additional_insured: row.additional_insured,
              primary_noncontributory: row.primary_noncontributory,
              waiver_of_subrogation: row.waiver_of_subrogation,
              license_number: row.license_number,
              license_jurisdiction: row.license_jurisdiction,
              license_classification: row.license_classification,
            },
          },
          targetOrgId: connection.builderOrgId,
          targetCompanyId: connection.companyId,
          portalTokenId: connection.portalTokenId,
        })
        return { ...outcome, status: result.alreadyShared ? "already_shared" : "shared" }
      } catch (error) {
        if (error instanceof DocumentNotRequestedError) return { ...outcome, status: "not_requested" }
        return {
          ...outcome,
          status: "failed",
          error: error instanceof Error ? error.message : "Could not share this document",
        }
      }
    }),
  )
}

async function recordShare(row: OwnDocumentRow, outcomes: OwnComplianceShareOutcome[]) {
  const sharedWith = outcomes.filter((outcome) => outcome.status === "shared")
  if (sharedWith.length === 0) return
  const after = { document_type_code: row.document_type_code, shared_with: sharedWith.map((o) => o.builderOrgId) }
  await Promise.all([
    recordAudit({
      orgId: row.org_id,
      action: "update",
      entityType: "own_compliance_document",
      entityId: row.id,
      after,
    }),
    recordEvent({
      orgId: row.org_id,
      eventType: "own_compliance_document_shared",
      entityType: "own_compliance_document",
      entityId: row.id,
      payload: { ...after, count: sharedWith.length },
    }),
  ])
}

async function loadCurrentDocument(supabase: SupabaseClient, orgId: string, documentId: string): Promise<OwnDocumentRow> {
  const { data, error } = await supabase
    .from("own_compliance_documents")
    .select("*")
    .eq("org_id", orgId)
    .eq("id", documentId)
    .maybeSingle()
  const row: OwnDocumentRow | null = data
  if (error || !row) throw new Error("Compliance document not found")
  if (row.status !== "current") throw new Error("Only the current document can be shared")
  return row
}

export async function shareOwnComplianceDocument(
  raw: unknown,
  orgId?: string,
): Promise<{ outcomes: OwnComplianceShareOutcome[] }> {
  const input = shareOwnComplianceSchema.parse(raw)
  const context = await requireOrgContext(orgId)
  await requirePermission("compliance.manage", context)
  const supabase = createServiceSupabaseClient()

  const row = await loadCurrentDocument(supabase, context.orgId, input.document_id)
  const outcomes = await shareDocumentWithBuilders(supabase, row)
  await recordShare(row, outcomes)
  return { outcomes }
}

export async function uploadOwnComplianceDocument(
  raw: unknown,
  file: File,
  orgId?: string,
): Promise<{ document: { id: string }; outcomes: OwnComplianceShareOutcome[] | null }> {
  const input = ownComplianceUploadSchema.parse(raw)
  if (file.size === 0) throw new Error("Choose a file to upload")
  if (file.size > MAX_FILE_BYTES) throw new Error("The file must be 25MB or smaller")
  if (!FILE_TYPES.has(file.type)) throw new Error("Upload a PDF or an image")

  const context = await requireOrgContext(orgId)
  await requirePermission("compliance.manage", context)
  const supabase = createServiceSupabaseClient()
  const { orgId: resolvedOrgId, userId } = context

  const safeName = file.name.replace(/[^\w.\-]+/g, "_")
  const storagePath = `${resolvedOrgId}/own-compliance/${input.document_type_code}/${Date.now()}_${safeName}`
  await uploadFilesObject({
    supabase,
    orgId: resolvedOrgId,
    path: storagePath,
    bytes: Buffer.from(await file.arrayBuffer()),
    contentType: file.type,
    upsert: false,
  })

  const { data: fileRow, error: fileError } = await supabase
    .from("files")
    .insert({
      org_id: resolvedOrgId,
      file_name: file.name,
      storage_path: storagePath,
      mime_type: file.type,
      size_bytes: file.size,
      visibility: "private",
      source: "upload",
      metadata: { file_type: "own_compliance_document", document_type_code: input.document_type_code },
    })
    .select("id")
    .single()
  if (fileError || !fileRow) throw new Error(`Failed to save the file: ${fileError?.message ?? "Unknown error"}`)

  // One current document per type is a unique index, so the one it replaces
  // steps aside first and is pointed at its successor afterwards. If the new
  // row cannot be written the old one is put back: the vault never ends up
  // holding no current document because an upload failed.
  const { data: replaced, error: stepAsideError } = await supabase
    .from("own_compliance_documents")
    .update({ status: "superseded" })
    .eq("org_id", resolvedOrgId)
    .eq("document_type_code", input.document_type_code)
    .eq("status", "current")
    .select("id")
  const previousIds: string[] = (replaced ?? []).map((row) => row.id)
  if (stepAsideError) throw new Error(`Failed to replace the current document: ${stepAsideError.message}`)

  const { data: created, error: createError } = await supabase
    .from("own_compliance_documents")
    .insert({
      org_id: resolvedOrgId,
      document_type_code: input.document_type_code,
      file_id: fileRow.id,
      status: "current",
      effective_date: input.effective_date ?? null,
      expiry_date: input.expiry_date ?? null,
      carrier_name: input.carrier_name ?? null,
      policy_number: input.policy_number ?? null,
      coverage_amount_cents: input.coverage_amount_cents ?? null,
      license_number: input.license_number ?? null,
      license_jurisdiction: input.license_jurisdiction ?? null,
      license_classification: input.license_classification ?? null,
      additional_insured: input.additional_insured,
      primary_noncontributory: input.primary_noncontributory,
      waiver_of_subrogation: input.waiver_of_subrogation,
      uploaded_by: userId,
    })
    .select("id")
    .single()

  if (createError || !created) {
    if (previousIds.length > 0) {
      await supabase.from("own_compliance_documents").update({ status: "current" }).eq("org_id", resolvedOrgId).in("id", previousIds)
    }
    await supabase.from("files").delete().eq("org_id", resolvedOrgId).eq("id", fileRow.id)
    await deleteFilesObjects({ supabase, orgId: resolvedOrgId, paths: [storagePath] })
    // 23505: another upload of this type landed between our step-aside and our insert.
    throw new Error(
      createError?.code === "23505"
        ? "Another upload of this document just landed. Reload and try again."
        : `Failed to save the document: ${createError?.message ?? "Unknown error"}`,
    )
  }

  if (previousIds.length > 0) {
    const { error: linkError } = await supabase
      .from("own_compliance_documents")
      .update({ superseded_by_id: created.id })
      .eq("org_id", resolvedOrgId)
      .in("id", previousIds)
    if (linkError) throw new Error(`Saved the document but could not link the one it replaced: ${linkError.message}`)
  }

  const after = {
    document_type_code: input.document_type_code,
    expiry_date: input.expiry_date ?? null,
    file_id: fileRow.id,
    replaced_document_ids: previousIds,
  }
  await Promise.all([
    recordAudit({ orgId: resolvedOrgId, action: "insert", entityType: "own_compliance_document", entityId: created.id, after }),
    recordEvent({
      orgId: resolvedOrgId,
      eventType: "own_compliance_document_uploaded",
      entityType: "own_compliance_document",
      entityId: created.id,
      payload: after,
    }),
  ])

  if (!input.share_after_upload) return { document: { id: created.id }, outcomes: null }
  const row = await loadCurrentDocument(supabase, resolvedOrgId, created.id)
  const outcomes = await shareDocumentWithBuilders(supabase, row)
  await recordShare(row, outcomes)
  return { document: { id: created.id }, outcomes }
}

/**
 * Tell each office about its own documents that are inside the 30-day window or
 * past it. Called by the nightly compliance run with the service client, across
 * every org in one read.
 *
 * Dedupe is the event id, not a delivery table: `compliance_autopilot_deliveries`
 * is keyed to a vendor company, document type and requirement, none of which a
 * vault document has, so a row there would need invented foreign keys. The
 * event's own idempotent insert says "this rung of this document already
 * happened" and, on replay, skips the notification fan-out too.
 */
export async function sweepOwnComplianceExpiry(supabase: SupabaseClient, now: Date = new Date()): Promise<number> {
  const today = todayKey(now)
  const horizon = todayKey(new Date(Date.parse(`${today}T00:00:00Z`) + OWN_DOCUMENT_REMINDER_HORIZON_DAYS * 86_400_000))

  let reminded = 0
  let after: string | null = null
  for (;;) {
    // Keyset pages by id: the scan never holds every lapsed document at once.
    let query = supabase
      .from("own_compliance_documents")
      .select("id, org_id, document_type_code, expiry_date")
      .eq("status", "current")
      .not("expiry_date", "is", null)
      .lte("expiry_date", horizon)
      .order("id")
      .limit(EXPIRY_SWEEP_PAGE)
    if (after) query = query.gt("id", after)
    const { data, error } = await query
    if (error) throw new Error(`Failed to scan own compliance documents: ${error.message}`)
    const rows = data ?? []

    // A lapsed document's last rung happens once; without this its row would be
    // re-read and re-checked against the event log every night for good.
    const lapsed = rows.flatMap((row) =>
      ownDocumentReminderRung(row.expiry_date, today) === 0 ? [ownDocumentReminderEventId(row.org_id, row.id, row.expiry_date, 0)] : [],
    )
    const recorded = new Set<string>()
    if (lapsed.length > 0) {
      const { data: events, error: eventsError } = await supabase.from("events").select("id").in("id", lapsed)
      if (eventsError) throw new Error(`Failed to check recorded expiry reminders: ${eventsError.message}`)
      for (const event of events ?? []) recorded.add(event.id)
    }

    for (const row of rows) {
      const rung = ownDocumentReminderRung(row.expiry_date, today)
      if (rung === null) continue
      if (rung === 0 && recorded.has(ownDocumentReminderEventId(row.org_id, row.id, row.expiry_date, 0))) continue
      const code = typeCode(row.document_type_code)
      await recordEvent({
        idempotencyId: ownDocumentReminderEventId(row.org_id, row.id, row.expiry_date, rung),
        orgId: row.org_id,
        eventType: "own_compliance_document_expiring",
        entityType: "own_compliance_document",
        entityId: row.id,
        channel: "notification",
        payload: {
          document_name: OWN_COMPLIANCE_TYPE_LABELS[code],
          document_type_code: code,
          expiry_date: row.expiry_date,
          reminder_rung: rung,
          expired: rung === 0,
        },
      })
      reminded += 1
    }
    if (rows.length < EXPIRY_SWEEP_PAGE) return reminded
    after = rows[rows.length - 1].id
  }
}
