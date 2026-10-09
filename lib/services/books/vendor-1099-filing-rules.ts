import { z } from "zod"
import type { Vendor1099Row } from "@/lib/services/reports/vendor-1099"

/**
 * The frozen content of a 1099-NEC package and its filing-partner import file
 * ("Arc 1099-NEC import, version 1"): one row per payee, full taxpayer IDs only
 * in the file, never in the package.
 */
export const FILING_COLUMNS = ["Payer TIN", "Payer Name", "Payer Address", "Payer City", "Payer State", "Payer ZIP", "Recipient TIN", "Recipient TIN Type",
  "Recipient Name", "Recipient Address", "Recipient City", "Recipient State", "Recipient ZIP", "Box 1 Nonemployee Compensation", "Tax Year", "Arc Payee ID"] as const

const address = z.object({ street1: z.string().trim().min(1), city: z.string().trim().min(1), state: z.string().trim().regex(/^[A-Za-z]{2}$/), postal_code: z.string().trim().regex(/^\d{5}(-?\d{4})?$/) })
export type FilingAddress = z.infer<typeof address>

const payeeSchema = z.object({ company_id: z.string().uuid(), name: z.string(), tin_last4: z.string().regex(/^\d{4}$/), tin_type: z.enum(["SSN", "EIN"]), amount_cents: z.number().int().safe().nonnegative(), address })
export const packageSnapshotSchema = z.object({ version: z.literal(1), tax_year: z.number().int(), threshold_cents: z.number().int().nonnegative(),
  payer: z.object({ legal_entity_id: z.string().uuid(), name: z.string(), tin_last4: z.string().regex(/^\d{4}$/), address }), payees: z.array(payeeSchema) })
export type PackagePayee = z.infer<typeof payeeSchema>
export type PackageSnapshot = z.infer<typeof packageSnapshotSchema>

/** A payee who is an individual or sole proprietor files under an SSN; everyone else under an EIN. */
export const isSsnFiler = (taxEntityType: string | null | undefined) => ["individual", "sole_prop"].includes(taxEntityType ?? "")

/**
 * Why nine digits cannot be a Social Security number, or null. The SSA never
 * issues an area of 000, 666 or 900-999, a group of 00 or a serial of 0000, and
 * the IRS refuses a 1099 that names one.
 */
export function ssnProblem(tin: string) {
  if (!/^\d{9}$/.test(tin)) return "A Social Security number has nine digits"
  if (tin.startsWith("000") || tin.startsWith("666") || tin.startsWith("9")) return "A Social Security number cannot start with 000, 666 or 9"
  if (tin.slice(3, 5) === "00" || tin.slice(5) === "0000") return "A Social Security number cannot have 00 in the middle or 0000 at the end"
  return null
}

/**
 * Everyone at or over the threshold is filed; anyone blocked stops the package
 * with the reason, so nothing is filed with a guess.
 */
export function buildPackageSnapshot(input: {
  taxYear: number; thresholdCents: number
  payer: { legalEntityId: string; name: string; tinLast4: string | null; address: unknown }
  rows: Vendor1099Row[]; addresses: Map<string, unknown>
}): { snapshot: PackageSnapshot } | { problems: string[] } {
  const problems: string[] = []
  const payerAddress = address.safeParse(input.payer.address)
  if (!input.payer.tinLast4) problems.push(`${input.payer.name}: record the company's own taxpayer ID before filing`)
  if (!payerAddress.success) problems.push(`${input.payer.name}: record the company's street, city, state and ZIP before filing`)
  const payees: PackagePayee[] = []
  for (const row of input.rows.filter((candidate) => candidate.meets_threshold)) {
    for (const reason of row.blocking_reasons) problems.push(`${row.vendor_name}: ${reason}`)
    const payeeAddress = address.safeParse(input.addresses.get(row.company_id))
    if (!payeeAddress.success) problems.push(`${row.vendor_name}: add the vendor's street, city, state and ZIP`)
    if (!row.tax_id_last4) problems.push(`${row.vendor_name}: no taxpayer ID on file`)
    if (row.blocking_reasons.length || !payeeAddress.success || !row.tax_id_last4) continue
    payees.push({ company_id: row.company_id, name: row.vendor_name, tin_last4: row.tax_id_last4, tin_type: isSsnFiler(row.tax_entity_type) ? "SSN" : "EIN",
      amount_cents: row.total_paid_cents, address: normalizeAddress(payeeAddress.data) })
  }
  if (problems.length || !payerAddress.success || !input.payer.tinLast4) return { problems }
  payees.sort((a, b) => a.name.localeCompare(b.name) || a.company_id.localeCompare(b.company_id))
  return { snapshot: { version: 1, tax_year: input.taxYear, threshold_cents: input.thresholdCents,
    payer: { legal_entity_id: input.payer.legalEntityId, name: input.payer.name, tin_last4: input.payer.tinLast4, address: normalizeAddress(payerAddress.data) }, payees } }
}

function normalizeAddress(value: FilingAddress): FilingAddress {
  return { street1: value.street1.trim(), city: value.city.trim(), state: value.state.trim().toUpperCase(), postal_code: value.postal_code.trim() }
}

const csvCell = (value: string) => /[",\n]/.test(value) ? `"${value.replace(/"/g, "\"\"")}"` : value
const dollars = (cents: number) => `${Math.trunc(cents / 100)}.${String(cents % 100).padStart(2, "0")}`

type FilingIdentities = { payer: string | null; payees: Record<string, string> }

/** Each full taxpayer ID read from Vault must still end in the last four frozen in the package. */
function verifiedIdentities(snapshot: PackageSnapshot, identities: FilingIdentities) {
  const payerTin = identities.payer
  if (!payerTin || payerTin.slice(-4) !== snapshot.payer.tin_last4) throw new Error("The company's taxpayer ID changed after this package was approved; prepare a corrected package")
  const tinOf = (payee: PackagePayee) => {
    const tin = identities.payees[payee.company_id]
    if (!tin || tin.slice(-4) !== payee.tin_last4) throw new Error(`${payee.name}'s taxpayer ID changed after this package was approved; prepare a corrected package`)
    return tin
  }
  return { payerTin, tinOf }
}

/** The import file, with each full taxpayer ID checked against the last four frozen in the package. */
export function buildFilingFile(snapshot: PackageSnapshot, identities: FilingIdentities) {
  const { payerTin, tinOf } = verifiedIdentities(snapshot, identities)
  const rows = snapshot.payees.map((payee) => {
    const tin = tinOf(payee)
    return [payerTin, snapshot.payer.name, snapshot.payer.address.street1, snapshot.payer.address.city, snapshot.payer.address.state, snapshot.payer.address.postal_code,
      tin, payee.tin_type, payee.name, payee.address.street1, payee.address.city, payee.address.state, payee.address.postal_code, dollars(payee.amount_cents), String(snapshot.tax_year), payee.company_id]
  })
  return [FILING_COLUMNS.join(","), ...rows.map((row) => row.map(csvCell).join(","))].join("\n") + "\n"
}

/** Checks a filing file against the import contract before it leaves Arc. */
export function validateFilingFile(content: string, snapshot: PackageSnapshot) {
  const lines = content.trimEnd().split("\n")
  if (lines[0] !== FILING_COLUMNS.join(",")) throw new Error("Filing file header does not match the import format")
  if (lines.length - 1 !== snapshot.payees.length) throw new Error("Filing file rows do not match the approved payees")
  let total = 0
  for (const line of lines.slice(1)) {
    const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)?.slice(0, FILING_COLUMNS.length).map((cell) => cell.replace(/,$/, "").replace(/^"(.*)"$/, "$1").replace(/""/g, "\"")) ?? []
    if (cells.length !== FILING_COLUMNS.length) throw new Error("Filing file row has the wrong number of columns")
    if (!/^\d{9}$/.test(cells[0]) || !/^\d{9}$/.test(cells[6])) throw new Error("Filing file taxpayer IDs must be nine digits")
    if (!["SSN", "EIN"].includes(cells[7]) || !/^[A-Z]{2}$/.test(cells[4]) || !/^[A-Z]{2}$/.test(cells[11])) throw new Error("Filing file has an invalid TIN type or state")
    if (!/^\d+\.\d{2}$/.test(cells[13]) || cells[14] !== String(snapshot.tax_year)) throw new Error("Filing file has an invalid amount or tax year")
    const cents = Math.round(Number(cells[13]) * 100)
    if (cents < snapshot.threshold_cents) throw new Error("Filing file includes a payee under the threshold")
    total += cents
  }
  if (total !== snapshot.payees.reduce((sum, payee) => sum + payee.amount_cents, 0)) throw new Error("Filing file total does not match the approved package")
  return { rows: lines.length - 1, totalCents: total }
}

const usAddress = (value: FilingAddress) => ({ Address1: value.street1, City: value.city, State: value.state, ZipCd: value.postal_code })

/**
 * The approved package as one TaxBandits 1099-NEC submission (federal e-file
 * through IRIS, no state filing, no mailing). An individual filed under an SSN
 * is named first and last, the last word being the last name; a name longer
 * than TaxBandits accepts is refused rather than cut short.
 */
export function taxBanditsNecRequest(snapshot: PackageSnapshot, identities: FilingIdentities) {
  const { payerTin, tinOf } = verifiedIdentities(snapshot, identities)
  const fits = (value: string, limit: number, who: string) => {
    if (value.length > limit) throw new Error(`${who} is longer than the ${limit} characters the filing partner accepts; shorten it on the company record`)
    return value
  }
  return {
    SubmissionManifest: { TaxYear: String(snapshot.tax_year), IRSFilingType: "IRIS", IsFederalFiling: true, IsStateFiling: false, IsPostal: false, IsOnlineAccess: false, IsScheduleFiling: false },
    ReturnHeader: { Business: { BusinessNm: fits(snapshot.payer.name, 75, snapshot.payer.name), PayerRef: snapshot.payer.legal_entity_id, IsEIN: true, EINorSSN: payerTin,
      IsBusinessTerminated: false, IsForeign: false, USAddress: usAddress(snapshot.payer.address) } },
    ReturnData: snapshot.payees.map((payee) => {
      const parts = payee.name.trim().split(/\s+/)
      const name = payee.tin_type === "SSN"
        ? { FirstNm: fits(parts.slice(0, -1).join(" ") || parts[0], 20, payee.name), LastNm: fits(parts.length > 1 ? parts[parts.length - 1] : parts[0], 20, payee.name) }
        : { FirstPayeeNm: fits(payee.name, 75, payee.name) }
      return {
        SequenceId: payee.company_id,
        Recipient: { TINType: payee.tin_type, TIN: tinOf(payee), PayeeRef: payee.company_id, ...name, IsForeign: false, USAddress: usAddress(payee.address) },
        NECFormData: { B1NEC: Number(dollars(payee.amount_cents)), B2IsDirectSales: false, B4FedTaxWH: 0, Is2ndTINnot: false, States: [] },
      }
    }),
  }
}

/** What the partner's per-record federal statuses add up to for the package. */
export function taxBanditsOutcome(records: Array<{ status: string | null; errors: string[] }>) {
  const statuses = records.map((record) => (record.status ?? "").toUpperCase().replace(/\s+/g, "_"))
  if (records.length === 0) return { outcome: "pending" as const, statuses }
  if (statuses.some((status) => status === "REJECTED")) return { outcome: "rejected" as const, statuses, reasons: [...new Set(records.flatMap((record) => record.errors))] }
  if (statuses.every((status) => status === "ACCEPTED" || status === "ACCEPTEDWITHERRORS")) return { outcome: "accepted" as const, statuses }
  return { outcome: "pending" as const, statuses }
}
