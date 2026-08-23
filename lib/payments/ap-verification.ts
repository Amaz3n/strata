import { z } from "zod"

/**
 * Pure AP document-verification logic: COI currency checks and lien-waiver
 * fact comparison. Kept free of server imports so the claims that feed the
 * payment release gate can be tested directly, alongside the hold policy.
 *
 * Design rule: everything here produces CHECKABLE CLAIMS for humans. Nothing
 * in this module (or its callers) auto-approves or mutates lifecycle state —
 * a mismatch becomes a review flag, never an action.
 */

const isoDateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)

export const coiPolicyTypeSchema = z.enum(["general_liability", "workers_comp", "auto", "umbrella", "other"])
export type CoiPolicyType = z.infer<typeof coiPolicyTypeSchema>

/** Shape persisted at compliance_documents.metadata.coi_extraction. */
export const coiExtractionSchema = z.object({
  carrier_name: z.string().nullable(),
  policy_number: z.string().nullable(),
  policy_type: coiPolicyTypeSchema.nullable(),
  each_occurrence_cents: z.number().int().min(0).nullable(),
  aggregate_cents: z.number().int().min(0).nullable(),
  effective_date: isoDateSchema.nullable(),
  expiry_date: isoDateSchema.nullable(),
  additional_insured: z.boolean().nullable(),
  // The other two endorsements a requirement can demand. Defaulted rather than
  // required so readings persisted before they were extracted still parse —
  // an older reading is simply silent about them, which is not the same as
  // stating the endorsement is absent.
  primary_noncontributory: z.boolean().nullable().default(null),
  waiver_of_subrogation: z.boolean().nullable().default(null),
  certificate_holder: z.string().nullable(),
  confidence: z.enum(["high", "medium", "low"]),
  notes: z.array(z.string()),
  file_id: z.string(),
  model: z.string(),
  extracted_at: z.string(),
})
export type CoiExtraction = z.infer<typeof coiExtractionSchema>

/**
 * A COI-backed policy is current when its extracted expiry is on or after
 * today and, when known, its effective date has already arrived.
 */
export function isCoiPolicyCurrent(
  extraction: Pick<CoiExtraction, "effective_date" | "expiry_date">,
  todayIso: string,
): boolean {
  if (!extraction.expiry_date) return false
  if (extraction.expiry_date < todayIso) return false
  if (extraction.effective_date && extraction.effective_date > todayIso) return false
  return true
}

/**
 * Bookkeeping for the extraction attempt itself, persisted next to the reading
 * at `compliance_documents.metadata.coi_extraction_attempt`. It exists so an
 * unchanged file is never sent to a model twice — including after a failure,
 * which would otherwise re-run on every enqueue for a document nothing can read.
 */
export const coiExtractionAttemptSchema = z.object({
  input_key: z.string(),
  status: z.enum(["extracted", "failed"]),
  /** Why a failed attempt failed, in the reviewer's words. Null on success. */
  reason: z.string().nullable(),
  model: z.string().nullable(),
  attempted_at: z.string(),
})
export type CoiExtractionAttempt = z.infer<typeof coiExtractionAttemptSchema>

/**
 * Re-reading an unchanged certificate buys nothing, so the key is the file's
 * identity plus its last-modified marker. A re-upload moves the marker; a new
 * document carries a new file id. Anything else is the same page of ink.
 */
export function buildCoiExtractionInputKey(parts: { fileId: string; fileUpdatedAt: string | null }): string {
  return [parts.fileId, parts.fileUpdatedAt ?? ""].join(":")
}

/**
 * Which compliance document types count as insurance. This is the same regex
 * the payment hold has always used, extracted so the extraction trigger and the
 * hold cannot drift apart about what "an insurance document" means.
 */
const INSURANCE_DOCUMENT_TYPE_PATTERN = /insurance|certificate|coi/i

export function isInsuranceDocumentTypeName(value: string | null | undefined): boolean {
  return INSURANCE_DOCUMENT_TYPE_PATTERN.test(value ?? "")
}

export interface InsuranceDocumentFact {
  status: string
  /** The expiry a human typed onto the compliance record. Wins for blocking. */
  storedExpiry: string | null
  fileId: string | null
  extraction: CoiExtraction | null
}

export interface InsuranceCurrencyVerdict {
  /**
   * Whether insurance is current, decided from the compliance record alone —
   * approval status and the expiry a human entered. A model reading never moves
   * this, because `insurance_current` blocks payment and no AI claim should be
   * able to stop a subcontractor being paid on its own.
   */
  current: boolean
  /**
   * Set when a confident reading of the certificate contradicts the record —
   * in EITHER direction. Surfaced through the warn-only `insurance_verified`
   * hold so a disagreement is always visible and never silently decisive.
   */
  contradiction: string | null
  basis: "no_documents" | "stored" | "extracted"
}

/**
 * A reading may only be used when it belongs to the file currently attached
 * (a re-upload leaves the old reading behind) and when the model was actually
 * confident. A low-confidence read is a hint for a reviewer, never a fact the
 * release gate acts on.
 */
function usableExtraction(document: InsuranceDocumentFact): CoiExtraction | null {
  const extraction = document.extraction
  if (!extraction || !document.fileId) return null
  if (extraction.file_id !== document.fileId) return null
  if (extraction.confidence === "low") return null
  return extraction
}

interface InsuranceDocumentReading {
  current: boolean
  usedExtraction: boolean
  note: string | null
}

function readInsuranceDocument(document: InsuranceDocumentFact, todayIso: string): InsuranceDocumentReading {
  const approved = document.status === "approved"
  // The compliance record decides currency, exactly as it did before any model
  // read a certificate. The reading below can contradict this loudly, but it
  // cannot overturn it: `insurance_current` is a blocking hold, and a
  // hallucinated date must never be able to stop a vendor being paid.
  const storedCurrent = approved && (!document.storedExpiry || document.storedExpiry >= todayIso)

  const extraction = usableExtraction(document)
  if (!extraction) return { current: storedCurrent, usedExtraction: false, note: null }

  // What the certificate itself says, computed independently so the two can be
  // compared rather than blended.
  const scannedCurrent = extraction.expiry_date
    ? isCoiPolicyCurrent({ effective_date: extraction.effective_date, expiry_date: extraction.expiry_date }, todayIso)
    : null

  let note: string | null = null
  if (document.storedExpiry && extraction.expiry_date && extraction.expiry_date !== document.storedExpiry) {
    note = `The scanned certificate expires ${extraction.expiry_date}, the recorded expiry is ${document.storedExpiry}`
  } else if (scannedCurrent === false && storedCurrent) {
    note = extraction.expiry_date && extraction.expiry_date < todayIso
      ? `The scanned certificate expired ${extraction.expiry_date} but the record shows insurance as current`
      : `The scanned certificate is not effective until ${extraction.effective_date} but the record shows insurance as current`
  } else if (!extraction.expiry_date && !document.storedExpiry) {
    note = "Neither the record nor the scanned certificate states an expiry date"
  }

  return { current: storedCurrent, usedExtraction: true, note }
}

const MAX_INSURANCE_DETAIL_LENGTH = 400

/**
 * Whether a vendor's insurance is current, preferring what the certificates
 * actually say over what their filenames imply.
 *
 * The fact this produces feeds a BLOCK-tier hold, so the degrade path matters
 * more than the happy path: no documents, no reading, a reading for a file that
 * has since been replaced, a low-confidence reading, or a reading with no date
 * in it all fall back to the stored status-and-expiry rule that shipped before
 * any model was involved. A model that cannot read the page leaves the gate
 * exactly where it found it.
 */
export function evaluateInsuranceCurrency(input: {
  documents: InsuranceDocumentFact[]
  todayIso: string
  /** The answer when the vendor has no insurance document at all. */
  fallbackCompliant: boolean
}): InsuranceCurrencyVerdict {
  if (input.documents.length === 0) {
    return { current: input.fallbackCompliant, contradiction: null, basis: "no_documents" }
  }

  const readings = input.documents.map((document) => readInsuranceDocument(document, input.todayIso))
  const notes = readings.map((reading) => reading.note).filter((note): note is string => Boolean(note))
  const contradiction = notes.length > 0 ? notes.join("; ").slice(0, MAX_INSURANCE_DETAIL_LENGTH) : null

  return {
    // One current certificate is enough, as it always has been.
    current: readings.some((reading) => reading.current),
    contradiction,
    basis: readings.some((reading) => reading.usedExtraction) ? "extracted" : "stored",
  }
}

export interface WaiverMismatch {
  field: "vendor_name" | "project" | "amount_cents" | "through_date" | "waiver_character"
  expected: string
  found: string
}

export interface WaiverComparison {
  matches: boolean
  mismatches: WaiverMismatch[]
  /** Fields the found document did not state — lowers confidence, never flags. */
  uncheckedFields: string[]
}

export interface WaiverExpectedFacts {
  vendorName: string | null
  projectName: string | null
  propertyDescription: string | null
  amountCents: number
  /** billing_period_end ?? due_date ?? bill_date, YYYY-MM-DD, or null when unknown. */
  periodEnd: string | null
}

export interface WaiverFoundFacts {
  claimantName: string | null
  propertyDescription: string | null
  amountCents: number | null
  throughDate: string | null
  character: "conditional" | "unconditional" | "final" | null
}

const LEGAL_SUFFIXES = new Set(["llc", "inc", "co", "corp", "ltd", "lp", "llp", "company", "incorporated", "corporation"])

function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token && !LEGAL_SUFFIXES.has(token))
    .join(" ")
    .trim()
}

function namesMatch(expected: string, found: string): boolean {
  const a = normalizeName(expected)
  const b = normalizeName(found)
  if (!a || !b) return true
  return a === b || a.includes(b) || b.includes(a)
}

export function formatCents(cents: number): string {
  return (cents / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

/**
 * Compare a signed waiver's stated facts against what the bill expects. Null
 * found values are recorded as unchecked, not as mismatches — a scanned
 * document that omits a field is unverifiable there, not wrong.
 */
export function compareWaiverFacts(expected: WaiverExpectedFacts, found: WaiverFoundFacts): WaiverComparison {
  const mismatches: WaiverMismatch[] = []
  const uncheckedFields: string[] = []

  if (found.claimantName === null || !expected.vendorName) {
    uncheckedFields.push("vendor_name")
  } else if (!namesMatch(expected.vendorName, found.claimantName)) {
    mismatches.push({ field: "vendor_name", expected: expected.vendorName, found: found.claimantName })
  }

  const expectedProject = expected.propertyDescription ?? expected.projectName
  if (found.propertyDescription === null || !expectedProject) {
    uncheckedFields.push("project")
  } else if (!namesMatch(expectedProject, found.propertyDescription)) {
    mismatches.push({ field: "project", expected: expectedProject, found: found.propertyDescription })
  }

  if (found.amountCents === null) {
    uncheckedFields.push("amount_cents")
  } else if (found.amountCents !== expected.amountCents) {
    mismatches.push({ field: "amount_cents", expected: formatCents(expected.amountCents), found: formatCents(found.amountCents) })
  }

  if (found.throughDate === null || expected.periodEnd === null) {
    uncheckedFields.push("through_date")
  } else if (found.throughDate < expected.periodEnd) {
    mismatches.push({ field: "through_date", expected: `covers through ${expected.periodEnd}`, found: found.throughDate })
  }

  // Before payment the waiver must be conditional (or final). An unconditional
  // waiver signed pre-payment is a real red flag for the vendor, worth surfacing.
  if (found.character === null) {
    uncheckedFields.push("waiver_character")
  } else if (found.character === "unconditional") {
    mismatches.push({ field: "waiver_character", expected: "conditional", found: "unconditional" })
  }

  return { matches: mismatches.length === 0, mismatches, uncheckedFields }
}

const MISMATCH_FIELD_LABELS: Record<WaiverMismatch["field"], string> = {
  vendor_name: "Vendor",
  project: "Project",
  amount_cents: "Amount",
  through_date: "Through date",
  waiver_character: "Waiver type",
}

export function summarizeWaiverMismatches(mismatches: WaiverMismatch[]): string {
  return mismatches
    .map((mismatch) => `${MISMATCH_FIELD_LABELS[mismatch.field]}: expected ${mismatch.expected}, found ${mismatch.found}`)
    .join("; ")
}

/** Shape persisted at vendor_bills.metadata.waiver_verification. */
export const waiverVerificationSchema = z.object({
  matches: z.boolean(),
  mismatches: z.array(
    z.object({
      field: z.enum(["vendor_name", "project", "amount_cents", "through_date", "waiver_character"]),
      expected: z.string(),
      found: z.string(),
    }),
  ),
  unchecked_fields: z.array(z.string()),
  confidence: z.enum(["high", "medium", "low"]),
  method: z.enum(["deterministic", "ai"]),
  model: z.string().nullable(),
  waiver_id: z.string(),
  file_id: z.string().nullable(),
  input_key: z.string(),
  verified_at: z.string(),
})
export type WaiverVerification = z.infer<typeof waiverVerificationSchema>

/**
 * Never call the model twice for unchanged inputs: the key encodes the waiver
 * identity, the exact document file, and every expected fact the comparison
 * reads. Any change to any of them produces a different key.
 */
export function buildWaiverVerificationInputKey(parts: {
  waiverId: string
  fileId: string | null
  signedAt: string | null
  amountCents: number
  periodEnd: string | null
}): string {
  return [parts.waiverId, parts.fileId ?? "structured", parts.signedAt ?? "", String(parts.amountCents), parts.periodEnd ?? ""].join(":")
}
