/**
 * Pure rules for cutover records that are not Books openings: who signed an
 * imported agreement, how a source system spells an inspection result or a
 * selection status, and how one home's source totals compare with Arc's.
 */

export interface AgreementSigner {
  name: string
  email: string | null
}

const SIGNER = /^\s*([^<>;]+?)\s*(?:<\s*([^<>\s;]+@[^<>\s;]+\.[^<>\s;]+)\s*>)?\s*$/

/** "Rosa Quintero <rosa@example.com>; Arc Builder" → each signer, or null when one entry cannot be read. */
export function parseAgreementSigners(text: unknown): AgreementSigner[] | null {
  if (typeof text !== "string" || !text.trim()) return []
  const signers: AgreementSigner[] = []
  for (const part of text.split(";")) {
    if (!part.trim()) continue
    const match = SIGNER.exec(part)
    if (!match) return null
    signers.push({ name: match[1].replace(/\s+/g, " "), email: match[2] ? match[2].toLowerCase() : null })
  }
  return signers
}

export const SHA256_PATTERN = /^[0-9a-f]{64}$/

export function normalizeSha256(value: unknown): string | null {
  if (typeof value !== "string") return null
  const text = value.trim().toLowerCase()
  return SHA256_PATTERN.test(text) ? text : null
}

const INSPECTION_RESULTS: Record<string, "pass" | "fail" | "partial"> = {
  pass: "pass", passed: "pass", approved: "pass", ok: "pass",
  fail: "fail", failed: "fail", rejected: "fail", "not approved": "fail",
  partial: "partial", "partial pass": "partial", conditional: "partial",
}

export function normalizeInspectionResult(value: unknown) {
  return typeof value === "string" ? INSPECTION_RESULTS[value.trim().toLowerCase()] ?? null : null
}

export const IMPORTED_SELECTION_STATUSES = ["selected", "confirmed", "ordered", "received"] as const
export type ImportedSelectionStatus = (typeof IMPORTED_SELECTION_STATUSES)[number]

/** A blank status is a confirmed choice: the source carried it as the home's selection. */
export function normalizeSelectionStatus(value: unknown): ImportedSelectionStatus | null {
  if (value == null || (typeof value === "string" && !value.trim())) return "confirmed"
  const text = String(value).trim().toLowerCase()
  return (IMPORTED_SELECTION_STATUSES as readonly string[]).includes(text) ? (text as ImportedSelectionStatus) : null
}

/** What Arc's signing policy locks: a choice that is confirmed or further along. */
export function selectionLocksAtImport(status: ImportedSelectionStatus) {
  return status !== "selected"
}

export type HomeFigures = Record<string, number>

export interface HomeComparison {
  projectId: string
  source: HomeFigures
  arc: HomeFigures
  differences: string[]
}

/**
 * Each home the source states figures for, against Arc's figures for the same
 * home. A home the source names that Arc has nothing for compares against zeros;
 * a home with Arc figures and no source line is not part of the reconciliation.
 */
export function compareHomeFigures(keys: readonly string[], source: ReadonlyMap<string, HomeFigures>, arc: ReadonlyMap<string, HomeFigures>) {
  const figures = (values: HomeFigures | undefined): HomeFigures => Object.fromEntries(keys.map((key) => [key, values?.[key] ?? 0]))
  const homes: HomeComparison[] = [...source].map(([projectId, stated]) => {
    const sourceFigures = figures(stated), arcFigures = figures(arc.get(projectId))
    return { projectId, source: sourceFigures, arc: arcFigures, differences: keys.filter((key) => sourceFigures[key] !== arcFigures[key]) }
  })
  const mismatches = homes.filter((home) => home.differences.length > 0)
  const total = (side: "source" | "arc"): HomeFigures => Object.fromEntries(keys.map((key) => [key, homes.reduce((sum, home) => sum + home[side][key], 0)]))
  return { homes: homes.length, matched: homes.length - mismatches.length, sourceTotals: total("source"), arcTotals: total("arc"), mismatches }
}
