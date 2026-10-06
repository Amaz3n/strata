import { z } from "zod"
import { booksDigest } from "./hash"

const uuid = z.string().uuid().toLowerCase(), record = z.record(z.unknown())
const journalSchema = z.object({ id: uuid, org_id: uuid, source_type: z.string().nullable().optional(), source_id: uuid.nullable().optional(), entry_date: z.string().date(), status: z.enum(["posted", "reversed"]), reversal_of_entry_id: uuid.nullable().optional() })
const lineSchema = z.object({ id: uuid, org_id: uuid, entry_id: uuid, account_id: uuid, project_id: uuid.nullable().optional(), debit_cents: z.number().int().safe().nonnegative(), credit_cents: z.number().int().safe().nonnegative(), dimensions: record })
const classificationSchema = z.object({ account_id: uuid, code: z.string(), account_type: z.string() })
function exact(value: bigint) {
  const result = Number(value)
  if (!Number.isSafeInteger(result)) throw new Error("Payroll liability history exceeds safe integer cents")
  return result
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

/** Organization-wide payment/reclassification evidence is not a run balance.
 * Legacy clearing settlements cannot be assigned by date, project, reference or
 * a declared payroll_run_id alone. Preserve them for reviewed attribution.
 */
export function payrollLiabilityHistory(orgId: string, tables: Record<string, Record<string, unknown>[]>) {
  for (const name of ["journal_entries", "journal_lines", "gl_accounts"]) {
    if (!tables[name] || tables[name].some(row => row.org_id !== orgId)) throw new Error(`Payroll liability history has missing or foreign ${name}`)
    const ids = new Set<string>()
    for (const row of tables[name]) {
      const id = uuid.parse(row.id)
      if (ids.has(id)) throw new Error(`Payroll liability history has duplicate ${name}`)
      ids.add(id)
    }
  }
  const accounts = new Map(tables.gl_accounts.map(row => [String(row.id), row]))
  const journals = new Map(tables.journal_entries.map(row => [String(row.id), row]))
  const byEntry = new Map<string, Record<string, unknown>[]>()
  for (const row of tables.journal_lines) {
    const id = String(row.entry_id), lines = byEntry.get(id) ?? []
    lines.push(row); byEntry.set(id, lines)
  }
  const selected = new Set<string>()
  for (const line of tables.journal_lines) {
    const dimensions = record.parse(line.dimensions ?? {}), classification = dimensions.books_account_classification
    const candidate = classification ? record.parse(classification) : null, current = accounts.get(String(line.account_id))
    if (!["2200", "2230"].includes(String(candidate?.code)) && !["2200", "2230"].includes(String(current?.code))) continue
    const historical = classification ? classificationSchema.parse(classification) : null
    if (historical && historical.account_id !== line.account_id) throw new Error("Payroll liability historical classification differs from journal account")
    if (!["2200", "2230"].includes(String(historical?.code)) && !["2200", "2230"].includes(String(current?.code))) continue
    const entry = journals.get(String(line.entry_id))
    if (!entry) throw new Error("Payroll liability history has an orphan journal line")
    if (["posted", "reversed"].includes(String(entry.status)) && entry.source_type !== "labor_cost") selected.add(String(entry.id))
  }
  const movements = [...selected].sort(compare).map(id => {
    const original = journals.get(id)!, entry = journalSchema.parse(original)
    let wages = BigInt(0), deductions = BigInt(0), debit = BigInt(0), credit = BigInt(0)
    const lines = (byEntry.get(id) ?? []).map(row => {
      const line = lineSchema.parse(row), account = accounts.get(line.account_id)
      if ((!line.debit_cents && !line.credit_cents) || (line.debit_cents && line.credit_cents)) throw new Error("Payroll liability history has invalid journal amounts")
      debit += BigInt(line.debit_cents); credit += BigInt(line.credit_cents)
      const frozen = line.dimensions.books_account_classification ? classificationSchema.parse(line.dimensions.books_account_classification) : null
    if ((frozen && frozen.account_id !== line.account_id) || (!frozen && !account)) throw new Error("Payroll liability history has missing or mismatched account evidence")
      const code = frozen?.code ?? String(account!.code), type = frozen?.account_type ?? String(account!.account_type)
      if (["2200", "2230"].includes(code) && type !== "liability") throw new Error("Payroll liability history requires original liability classification")
      const movement = BigInt(line.credit_cents) - BigInt(line.debit_cents)
      if (code === "2200") wages += movement
      if (code === "2230") deductions += movement
      return { ...line, accountCode: code, classificationSource: frozen ? "original_journal" as const : "current_chart_unclassified" as const }
    }).sort((a, b) => compare(a.id, b.id))
    if (debit !== credit) throw new Error("Payroll liability history has an unbalanced journal")
    return { journal: { ...original, ...entry }, lines, wagesMovementCents: exact(wages), deductionsMovementCents: exact(deductions), requiresAttribution: true as const }
  })
  const history = { version: 1 as const, orgId, movements,
    organizationWagesMovementCents: exact(movements.reduce((total, row) => total + BigInt(row.wagesMovementCents), BigInt(0))),
    organizationDeductionsMovementCents: exact(movements.reduce((total, row) => total + BigInt(row.deductionsMovementCents), BigInt(0))),
    requiresSettlementAttribution: movements.length > 0, unpaidStatusProven: false as const, previewOnly: true as const }
  return { ...history, digest: booksDigest(history) }
}
