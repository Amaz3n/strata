import "server-only"

import { z } from "zod"

import { toCents } from "@/lib/financials/invoice-reconcile"
import {
  buildCoiExtractionInputKey,
  buildWaiverVerificationInputKey,
  coiExtractionSchema,
  coiPolicyTypeSchema,
  compareWaiverFacts,
  summarizeWaiverMismatches,
  type CoiExtraction,
  type CoiExtractionAttempt,
  type WaiverExpectedFacts,
  type WaiverFoundFacts,
  type WaiverVerification,
} from "@/lib/payments/ap-verification"
import { runAiObject } from "@/lib/services/ai/gateway"
import { parseDate } from "@/lib/services/import-parsers"
import { loadStoredFileForModel } from "@/lib/services/ai/stored-file-input"
import { requireOrgContext } from "@/lib/services/context"
import { recordEvent } from "@/lib/services/events"
import { createServiceSupabaseClient } from "@/lib/supabase/server"

/**
 * Checking that the signed lien waiver on a payable actually says what the
 * payable says.
 *
 * A waiver is the document that stops a sub filing a lien for work you paid
 * for. Arc used to treat it as a boolean — a row exists, therefore the hold is
 * satisfied — which is worth exactly nothing if the waiver names a different
 * amount, a different property, or a through-date that stops short of the
 * period being paid. Those are the three ways a waiver silently fails to cover
 * the payment it was collected for.
 *
 * The result is a CHECKABLE CLAIM, never an action: a mismatch surfaces as a
 * warn-tier hold with the specific fields that disagree. Nothing here changes
 * the bill's status, and no policy may promote the claim to a block — see
 * `waiver_verified` in `lib/payments/payment-hold-policy.ts`.
 *
 * Waivers signed through Arc's own portal carry structured facts, so their
 * comparison is deterministic and costs nothing. Only an uploaded or scanned
 * waiver file would need a model to read it, and that path is deliberately not
 * inferred from structured data that is already trustworthy.
 */

/**
 * Reading the certificate of insurance instead of guessing from its filename.
 *
 * The insurance payment hold has always answered "is this vendor covered?" by
 * checking that a compliance document whose TYPE NAME matches /insurance|
 * certificate|coi/ is approved and has not passed a hand-typed expiry date.
 * That is a check on Arc's filing, not on the policy: a certificate that lapsed
 * in March passes forever if nobody typed the date in, and a document filed
 * under the wrong type is invisible to it.
 *
 * So the model reads the page and states what it found — carrier, policy
 * number, limits, effective and expiry dates. That is a CHECKABLE CLAIM and
 * nothing more. It never approves a document, never changes its status, and
 * never overrides the expiry a human entered: `evaluateInsuranceCurrency` keeps
 * the stored date authoritative for blocking and surfaces the model's date as
 * evidence beside it. Every degraded path — no reading, a stale reading, a
 * low-confidence reading, an unreadable file — lands back on the pre-model
 * rule, so a bad scan can neither release a payment nor stop one.
 */

// No `.regex()`: the Google adapter drops `pattern` from the schema it sends,
// so the constraint would only ever fire client-side as a rejected object.
// The format is requested in the description and normalised by `parseDate`.
const coiIsoDate = z.string().describe("Date as YYYY-MM-DD, or null if not printed").nullable()

/**
 * The model reads, code counts. Limits come back as the number printed on the
 * certificate ("1,000,000" → 1000000) and are converted to cents here, so the
 * model is never asked to know what a cent is.
 */
const coiModelSchema = z.object({
  carrier_name: z.string().nullable().describe("The insurance carrier / insurer name, not the agency or broker"),
  policy_number: z.string().nullable(),
  policy_type: coiPolicyTypeSchema
    .nullable()
    .describe(
      "The coverage this certificate's primary policy line is for. Use general_liability for CGL, " +
        "workers_comp for workers compensation and employers liability, auto for business auto, " +
        "umbrella for umbrella or excess liability.",
    ),
  each_occurrence: z
    .number()
    .nullable()
    .describe("Each-occurrence limit for that policy line, as printed in dollars, e.g. 1000000"),
  aggregate: z.number().nullable().describe("General aggregate limit, as printed in dollars"),
  effective_date: coiIsoDate.describe("Policy effective date for that line"),
  expiry_date: coiIsoDate.describe("Policy expiration date for that line"),
  additional_insured: z
    .boolean()
    .nullable()
    .describe("True only when the certificate states the holder is an additional insured"),
  primary_noncontributory: z
    .boolean()
    .nullable()
    .describe(
      "True only when the certificate states the coverage is primary and non-contributory. " +
        "Null when the wording is absent — never infer it from an additional insured endorsement.",
    ),
  waiver_of_subrogation: z
    .boolean()
    .nullable()
    .describe(
      "True only when the certificate states a waiver of subrogation applies in favor of the holder. " +
        "Null when the wording is absent.",
    ),
  certificate_holder: z.string().nullable().describe("The name in the CERTIFICATE HOLDER box"),
  confidence: z.enum(["high", "medium", "low"]),
  notes: z.array(z.string()),
})

const COI_SYSTEM = [
  "You read ACORD 25 certificates of liability insurance for a construction general contractor.",
  "Report only what is printed on the certificate. Never infer coverage, never carry a date forward,",
  "and never treat the producer or broker as the carrier.",
  "Monetary limits are the decimal numbers as printed, for example 1000000, not cents.",
  "Use null for anything not visible, and say what was missing in notes.",
].join(" ")

interface CoiFileRow {
  id: string
  file_name: string | null
  storage_path: string
  mime_type: string | null
  size_bytes: number | null
  updated_at: string | null
}

interface CoiComplianceDocumentRow {
  id: string
  company_id: string
  metadata: Record<string, unknown> | null
}

export type CoiExtractionReason =
  | "extracted"
  | "unchanged"
  | "file_not_found"
  | "no_compliance_document"
  | "unreadable"
  | "model_failed"

export interface CoiExtractionOutcome {
  extracted: boolean
  reason: CoiExtractionReason
  extraction: CoiExtraction | null
  message: string | null
}

function toLimitCents(value: number | null): number | null {
  const cents = toCents(value)
  // The persisted schema will not accept a negative limit, and a negative limit
  // is not a thing a certificate prints — so it is a misread, not a number.
  if (cents === null || cents < 0) return null
  return cents
}

function cleanCoiText(value: string | null, max = 200): string | null {
  const cleaned = value?.trim()
  return cleaned ? cleaned.slice(0, max) : null
}

async function persistCoiAttempt(params: {
  supabase: ReturnType<typeof createServiceSupabaseClient>
  orgId: string
  documents: CoiComplianceDocumentRow[]
  attempt: CoiExtractionAttempt
  extraction: CoiExtraction | null
}) {
  const results = await Promise.all(
    params.documents.map((document) => {
      const metadata: Record<string, unknown> = { ...(document.metadata ?? {}), coi_extraction_attempt: params.attempt }
      // A failed re-read leaves the last good reading in place. It carries its
      // own file_id, so a reading for a replaced file is ignored downstream
      // rather than needing to be deleted here.
      if (params.extraction) metadata.coi_extraction = params.extraction
      return params.supabase
        .from("compliance_documents")
        .update({ metadata })
        .eq("org_id", params.orgId)
        .eq("id", document.id)
    }),
  )
  const failure = results.find((result) => result.error)
  if (failure?.error) throw new Error(`Unable to record the certificate reading: ${failure.error.message}`)
}

/**
 * Read the certificate of insurance stored as `fileId` and persist the claim
 * onto every compliance document that file backs.
 *
 * Safe to call repeatedly: an unchanged file short-circuits on the stored input
 * key, and that key covers failures too, so a certificate no model can read is
 * attempted once rather than on every upload, approval and retry.
 */
export async function extractCoiFacts(fileId: string, orgId?: string): Promise<CoiExtractionOutcome> {
  // Callable from the outbox worker, which has no session — an explicit org id
  // is trusted, and only an interactive caller resolves one from its context.
  const resolvedOrgId = orgId ?? (await requireOrgContext()).orgId
  const supabase = createServiceSupabaseClient()

  const [fileResult, documentsResult] = await Promise.all([
    supabase
      .from("files")
      .select("id,file_name,storage_path,mime_type,size_bytes,updated_at")
      .eq("org_id", resolvedOrgId)
      .eq("id", fileId)
      .maybeSingle<CoiFileRow>(),
    supabase
      .from("compliance_documents")
      .select("id,company_id,metadata")
      .eq("org_id", resolvedOrgId)
      .eq("file_id", fileId)
      .returns<CoiComplianceDocumentRow[]>(),
  ])

  if (fileResult.error) throw new Error(`Unable to load the certificate file: ${fileResult.error.message}`)
  if (documentsResult.error) {
    throw new Error(`Unable to load the compliance document: ${documentsResult.error.message}`)
  }

  const file = fileResult.data
  if (!file) return { extracted: false, reason: "file_not_found", extraction: null, message: "The certificate file is gone" }

  const documents = documentsResult.data ?? []
  // Nothing to attach a claim to. Not a failure — the file simply is not filed
  // as a compliance document, so there is no hold it could ever inform.
  if (documents.length === 0) {
    return {
      extracted: false,
      reason: "no_compliance_document",
      extraction: null,
      message: "The file is not attached to a compliance document",
    }
  }

  const inputKey = buildCoiExtractionInputKey({ fileId, fileUpdatedAt: file.updated_at })
  const alreadyAttempted = documents.every((document) => {
    const attempt = (document.metadata ?? {}).coi_extraction_attempt
    const parsed = z.object({ input_key: z.string() }).safeParse(attempt)
    return parsed.success && parsed.data.input_key === inputKey
  })
  if (alreadyAttempted) {
    const stored = coiExtractionSchema.safeParse((documents[0].metadata ?? {}).coi_extraction)
    return { extracted: false, reason: "unchanged", extraction: stored.success ? stored.data : null, message: null }
  }

  const attemptedAt = new Date().toISOString()
  const input = await loadStoredFileForModel({ supabase, orgId: resolvedOrgId, file })
  if (!input.ok) {
    await persistCoiAttempt({
      supabase,
      orgId: resolvedOrgId,
      documents,
      attempt: { input_key: inputKey, status: "failed", reason: input.message, model: null, attempted_at: attemptedAt },
      extraction: null,
    })
    await recordEvent({
      orgId: resolvedOrgId,
      eventType: "compliance_document_coi_extraction_failed",
      entityType: "compliance_document",
      entityId: documents[0].id,
      payload: { file_id: fileId, company_id: documents[0].company_id, reason: input.reason, message: input.message },
    })
    return { extracted: false, reason: "unreadable", extraction: null, message: input.message }
  }

  const result = await runAiObject({
    feature: "document_extraction",
    schema: coiModelSchema,
    system: COI_SYSTEM,
    prompt: [
      "Read this certificate of insurance.",
      "If it lists several policy lines, report the general liability line, falling back to the",
      "line with the largest each-occurrence limit when there is no general liability line.",
      "Dates are the effective and expiration dates of that same line.",
      "Endorsements — additional insured, primary and non-contributory, waiver of subrogation —",
      "are true only where the certificate says so in the checkboxes or the description of operations.",
    ].join(" "),
    files: [input.part],
    orgId: resolvedOrgId,
    entityType: "compliance_document",
    entityId: documents[0].id,
    // The one thing arithmetic can settle: a policy cannot expire before it
    // begins. Everything else on an ACORD form is prose the model must read.
    verify: (value) => {
      const effective = parseDate(value.effective_date)
      const expiry = parseDate(value.expiry_date)
      if (value.effective_date && !effective) return { ok: false, message: "The effective date is not a readable date" }
      if (value.expiry_date && !expiry) return { ok: false, message: "The expiration date is not a readable date" }
      if (effective && expiry && effective > expiry) {
        return { ok: false, message: "The effective date is after the expiration date" }
      }
      return { ok: true }
    },
  })

  if (!result.ok) {
    await persistCoiAttempt({
      supabase,
      orgId: resolvedOrgId,
      documents,
      attempt: {
        input_key: inputKey,
        status: "failed",
        reason: result.message,
        model: result.meta?.model ?? null,
        attempted_at: attemptedAt,
      },
      extraction: null,
    })
    await recordEvent({
      orgId: resolvedOrgId,
      eventType: "compliance_document_coi_extraction_failed",
      entityType: "compliance_document",
      entityId: documents[0].id,
      payload: { file_id: fileId, company_id: documents[0].company_id, reason: result.reason, message: result.message },
    })
    // Failure is data: the hold falls back to the stored expiry, unchanged.
    return { extracted: false, reason: "model_failed", extraction: null, message: result.message }
  }

  const value = result.object
  const candidate: CoiExtraction = {
    carrier_name: cleanCoiText(value.carrier_name),
    policy_number: cleanCoiText(value.policy_number, 80),
    policy_type: value.policy_type,
    each_occurrence_cents: toLimitCents(value.each_occurrence),
    aggregate_cents: toLimitCents(value.aggregate),
    effective_date: parseDate(value.effective_date),
    expiry_date: parseDate(value.expiry_date),
    additional_insured: value.additional_insured,
    primary_noncontributory: value.primary_noncontributory,
    waiver_of_subrogation: value.waiver_of_subrogation,
    certificate_holder: cleanCoiText(value.certificate_holder),
    confidence: value.confidence,
    notes: value.notes.map((note) => note.trim()).filter(Boolean).slice(0, 5),
    file_id: fileId,
    model: result.meta.model,
    extracted_at: attemptedAt,
  }

  // Nothing reaches the metadata that the persisted contract would reject.
  const parsed = coiExtractionSchema.safeParse(candidate)
  if (!parsed.success) {
    await persistCoiAttempt({
      supabase,
      orgId: resolvedOrgId,
      documents,
      attempt: {
        input_key: inputKey,
        status: "failed",
        reason: "The reading did not match the expected shape",
        model: result.meta.model,
        attempted_at: attemptedAt,
      },
      extraction: null,
    })
    return { extracted: false, reason: "model_failed", extraction: null, message: "The reading was not usable" }
  }

  await persistCoiAttempt({
    supabase,
    orgId: resolvedOrgId,
    documents,
    attempt: { input_key: inputKey, status: "extracted", reason: null, model: result.meta.model, attempted_at: attemptedAt },
    extraction: parsed.data,
  })

  await recordEvent({
    orgId: resolvedOrgId,
    eventType: "compliance_document_coi_extracted",
    entityType: "compliance_document",
    entityId: documents[0].id,
    payload: {
      file_id: fileId,
      company_id: documents[0].company_id,
      document_ids: documents.map((document) => document.id),
      policy_type: parsed.data.policy_type,
      expiry_date: parsed.data.expiry_date,
      confidence: parsed.data.confidence,
      model: parsed.data.model,
    },
  })

  return { extracted: true, reason: "extracted", extraction: parsed.data, message: null }
}

interface WaiverRow {
  id: string
  waiver_type: string
  amount_cents: number | null
  through_date: string | null
  claimant_name: string | null
  property_description: string | null
  signed_at: string | null
  signed_file_id: string | null
  document_file_id: string | null
}

/** The bill facts a waiver has to agree with. */
function buildExpectedFacts(bill: {
  total_cents: number | null
  retainage_cents: number | null
  bill_date: string | null
  due_date: string | null
  metadata: Record<string, unknown> | null
  company: { name: string | null } | null
  project: { name: string | null; address: string | null } | null
}): WaiverExpectedFacts {
  const metadata = bill.metadata ?? {}
  // A conditional waiver covers what is being paid, which is the billed total
  // less anything held back — retainage is precisely the part not yet paid.
  const amountCents = Number(bill.total_cents ?? 0) - Number(bill.retainage_cents ?? 0)
  const periodEnd =
    typeof metadata.billing_period_end === "string"
      ? metadata.billing_period_end
      : typeof metadata.period_end === "string"
        ? metadata.period_end
        : bill.due_date ?? bill.bill_date

  return {
    vendorName: bill.company?.name ?? null,
    projectName: bill.project?.name ?? null,
    propertyDescription: bill.project?.address ?? null,
    amountCents,
    periodEnd: periodEnd ?? null,
  }
}

function firstRelation<T>(value: T | T[] | null | undefined): T | null {
  if (Array.isArray(value)) return value[0] ?? null
  return value ?? null
}

export interface WaiverVerificationOutcome {
  verified: boolean
  reason?: "no_waiver" | "unchanged"
  verification?: WaiverVerification
}

/**
 * Verify the signed waiver on a payable and persist the claim onto the bill.
 *
 * Re-running is cheap and safe: an unchanged waiver against unchanged bill
 * facts short-circuits on the stored input key rather than recomparing.
 */
export async function verifyBillWaiver(billId: string, orgId?: string): Promise<WaiverVerificationOutcome> {
  const context = await requireOrgContext(orgId)
  const supabase = createServiceSupabaseClient()

  const { data: bill, error: billError } = await supabase
    .from("vendor_bills")
    .select(
      "id,project_id,total_cents,retainage_cents,bill_date,due_date,metadata,company:companies(name),project:projects(name,address)",
    )
    .eq("org_id", context.orgId)
    .eq("id", billId)
    .maybeSingle()
  if (billError) throw new Error(`Unable to load the payable: ${billError.message}`)
  if (!bill) throw new Error("Payable not found")

  const { data: waivers, error: waiverError } = await supabase
    .from("lien_waivers")
    .select("id,waiver_type,amount_cents,through_date,claimant_name,property_description,signed_at,signed_file_id,document_file_id")
    .eq("org_id", context.orgId)
    .eq("bill_id", billId)
    .eq("status", "signed")
    .order("signed_at", { ascending: false })
    .limit(1)
  if (waiverError) throw new Error(`Unable to load the lien waiver: ${waiverError.message}`)

  const waiver = (waivers ?? [])[0] as WaiverRow | undefined
  // No signed waiver is not a mismatch — `waiver_signed` already speaks to
  // that, and verification stays silent rather than double-reporting it.
  if (!waiver) return { verified: false, reason: "no_waiver" }

  const expected = buildExpectedFacts({
    total_cents: bill.total_cents,
    retainage_cents: bill.retainage_cents,
    bill_date: bill.bill_date,
    due_date: bill.due_date,
    metadata: (bill.metadata ?? {}) as Record<string, unknown>,
    company: firstRelation(bill.company),
    project: firstRelation(bill.project),
  })

  const inputKey = buildWaiverVerificationInputKey({
    waiverId: waiver.id,
    fileId: waiver.signed_file_id ?? waiver.document_file_id ?? null,
    signedAt: waiver.signed_at,
    amountCents: expected.amountCents,
    periodEnd: expected.periodEnd,
  })

  const existingMetadata = (bill.metadata ?? {}) as Record<string, unknown>
  const existing = existingMetadata.waiver_verification as WaiverVerification | undefined
  if (existing && existing.input_key === inputKey) {
    return { verified: true, reason: "unchanged", verification: existing }
  }

  // Structured waiver facts come from Arc's own signing flow, so what the
  // document says is what these columns say — no model can add certainty here.
  const found: WaiverFoundFacts = {
    claimantName: waiver.claimant_name,
    propertyDescription: waiver.property_description,
    amountCents: waiver.amount_cents === null ? null : Number(waiver.amount_cents),
    throughDate: waiver.through_date,
    character:
      waiver.waiver_type === "conditional" || waiver.waiver_type === "unconditional" || waiver.waiver_type === "final"
        ? waiver.waiver_type
        : null,
  }

  const comparison = compareWaiverFacts(expected, found)
  const verification: WaiverVerification = {
    matches: comparison.matches,
    mismatches: comparison.mismatches,
    unchecked_fields: comparison.uncheckedFields,
    // Structured comparison is only as confident as its completeness: fields the
    // waiver never stated are unchecked, not confirmed.
    confidence: comparison.uncheckedFields.length === 0 ? "high" : comparison.uncheckedFields.length > 2 ? "low" : "medium",
    method: "deterministic",
    model: null,
    waiver_id: waiver.id,
    file_id: waiver.signed_file_id ?? waiver.document_file_id ?? null,
    input_key: inputKey,
    verified_at: new Date().toISOString(),
  }

  const { error: updateError } = await supabase
    .from("vendor_bills")
    .update({ metadata: { ...existingMetadata, waiver_verification: verification } })
    .eq("org_id", context.orgId)
    .eq("id", billId)
  if (updateError) throw new Error(`Unable to record the waiver check: ${updateError.message}`)

  await recordEvent({
    orgId: context.orgId,
    eventType: "payable_waiver_verified",
    entityType: "vendor_bill",
    entityId: billId,
    payload: {
      project_id: bill.project_id,
      waiver_id: waiver.id,
      matches: verification.matches,
      mismatch_summary: verification.matches ? null : summarizeWaiverMismatches(comparison.mismatches),
    },
  })

  return { verified: true, verification }
}
