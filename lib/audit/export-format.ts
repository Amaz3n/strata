import { createHash } from "node:crypto"
import { z } from "zod"

/**
 * The audit export file: a CSV an auditor can check without Arc.
 *
 *   # Arc audit export
 *   # manifest {"columns":[...],"digest_algorithm":...,"org_id":...,"row_count":2,...}
 *   # digest sha256:<hex>
 *   id,created_at,...,row_sha256
 *   ...
 *
 * Each row carries `row_sha256`: SHA-256 of the canonical JSON of that row's
 * cells (column → cell text, keys sorted). The digest is SHA-256 of the
 * canonical manifest, a newline, and every row hash in file order joined by
 * newlines — so it fixes the organization, the range, the exporter, the row
 * count, the row order and every cell. `verifyAuditExport` is the auditor's
 * check, and the only reader of this format.
 *
 * A null value and an empty string are both written as an empty cell. JSON
 * columns are written as canonical JSON. A cell that a spreadsheet would run
 * as a formula (`=`, `+`, `-`, `@`, tab, carriage return) is written with a
 * leading `'`, as is one that already starts with `'`; the hash covers the
 * value, not the guard.
 */

export const AUDIT_EXPORT_FORMAT = "arc-audit-export/1"
export const AUDIT_EXPORT_DIGEST_ALGORITHM =
  "sha256(canonical manifest + \"\\n\" + row_sha256 values in file order joined by \"\\n\")"
export const ROW_HASH_COLUMN = "row_sha256"

const MANIFEST_PREFIX = "# manifest "
const DIGEST_PREFIX = "# digest sha256:"

export type AuditExportSource = "changes" | "access"

export const AUDIT_EXPORT_COLUMNS: Record<AuditExportSource, readonly string[]> = {
  changes: [
    "id",
    "created_at",
    "org_id",
    "actor_user_id",
    "action",
    "entity_type",
    "entity_id",
    "source",
    "ip_address",
    "correlation_id",
    "before_data",
    "after_data",
  ],
  access: [
    "id",
    "occurred_at",
    "org_id",
    "actor_user_id",
    "project_id",
    "action_key",
    "resource_type",
    "resource_id",
    "decision",
    "reason_code",
    "policy_version",
    "impersonation_session_id",
    "request_id",
    "ip",
    "user_agent",
    "context",
  ],
}

const manifestSchema = z.object({
  format: z.literal(AUDIT_EXPORT_FORMAT),
  source: z.enum(["changes", "access"]),
  org_id: z.string(),
  from: z.string(),
  to: z.string(),
  generated_at: z.string(),
  exported_by: z.object({ user_id: z.string(), email: z.string().nullable() }),
  row_count: z.number().int().nonnegative(),
  columns: z.array(z.string()),
  digest_algorithm: z.string(),
}).strict()

export type AuditExportManifest = z.infer<typeof manifestSchema>

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** JSON with object keys sorted at every depth and no whitespace. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry ?? null)).join(",")}]`
  if (isPlainObject(value)) {
    const keys = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`
  }
  if (value === undefined) return "null"
  return JSON.stringify(value)
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

/** The text a stored value is exported as. */
export function exportCell(value: unknown): string {
  if (value === null || value === undefined) return ""
  if (typeof value === "object") return canonicalJson(value)
  return String(value)
}

export function rowHash(cells: Record<string, string>): string {
  return sha256Hex(canonicalJson(cells))
}

export function exportDigest(manifest: AuditExportManifest, rowHashes: readonly string[]): string {
  return sha256Hex(`${canonicalJson(manifest)}\n${rowHashes.join("\n")}`)
}

const FORMULA_START = /^[=+\-@\t\r']/

/** RFC 4180 quoting, plus the spreadsheet formula guard. */
export function csvEscape(value: string): string {
  const guarded = FORMULA_START.test(value) ? `'${value}` : value
  return /[",\n\r]/.test(guarded) || guarded !== guarded.trim()
    ? `"${guarded.replace(/"/g, '""')}"`
    : guarded
}

function unguard(value: string): string {
  return value.startsWith("'") ? value.slice(1) : value
}

/** One stored row as its cells, in column order. */
export function exportRowCells(columns: readonly string[], row: Record<string, unknown>): Record<string, string> {
  const cells: Record<string, string> = {}
  for (const column of columns) cells[column] = exportCell(row[column])
  return cells
}

/** The complete file, given the manifest (without digest) and the stored rows. */
export function buildAuditExportCsv(
  manifest: AuditExportManifest,
  rows: readonly Record<string, unknown>[],
): { csv: string; digest: string } {
  const lines: string[] = []
  const hashes: string[] = []
  for (const row of rows) {
    const cells = exportRowCells(manifest.columns, row)
    const hash = rowHash(cells)
    hashes.push(hash)
    lines.push([...manifest.columns.map((column) => cells[column]), hash].map(csvEscape).join(","))
  }
  const digest = exportDigest(manifest, hashes)
  const header = [
    "# Arc audit export",
    `${MANIFEST_PREFIX}${canonicalJson(manifest)}`,
    `${DIGEST_PREFIX}${digest}`,
    [...manifest.columns, ROW_HASH_COLUMN].join(","),
  ]
  return { csv: `${[...header, ...lines].join("\n")}\n`, digest }
}

/** RFC 4180 records: quoted fields may hold commas, quotes and newlines. */
export function parseCsv(text: string): string[][] {
  const records: string[][] = []
  let record: string[] = []
  let field = ""
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"'
        index += 1
      } else if (character === '"') {
        quoted = false
      } else {
        field += character
      }
      continue
    }
    if (character === '"') {
      quoted = true
    } else if (character === ",") {
      record.push(field)
      field = ""
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") index += 1
      record.push(field)
      records.push(record)
      record = []
      field = ""
    } else {
      field += character
    }
  }
  if (field !== "" || record.length > 0) {
    record.push(field)
    records.push(record)
  }
  return records
}

export interface AuditExportVerification {
  valid: boolean
  digest: string | null
  rowCount: number
  manifest: AuditExportManifest | null
  problems: string[]
}

function readManifest(line: string | undefined): AuditExportManifest | null {
  if (!line?.startsWith(MANIFEST_PREFIX)) return null
  try {
    const parsed = manifestSchema.safeParse(JSON.parse(line.slice(MANIFEST_PREFIX.length)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

/**
 * Recompute every row hash and the digest from the file alone. Any edited
 * cell, added, removed or reordered row, or edited manifest fails.
 */
export function verifyAuditExport(text: string): AuditExportVerification {
  const lines = text.split("\n")
  const manifest = readManifest(lines[1])
  const stated = lines[2]?.startsWith(DIGEST_PREFIX) ? lines[2].slice(DIGEST_PREFIX.length).trim() : null
  const fail = (problem: string): AuditExportVerification => ({
    valid: false,
    digest: stated,
    rowCount: 0,
    manifest,
    problems: [problem],
  })
  if (lines[0] !== "# Arc audit export" || !manifest) return fail("The file has no Arc audit export manifest.")
  if (!stated) return fail("The file states no digest.")

  const records = parseCsv(lines.slice(3).join("\n"))
  const [header, ...body] = records
  const expectedHeader = [...manifest.columns, ROW_HASH_COLUMN]
  if (!header || header.join(",") !== expectedHeader.join(",")) return fail("The column header does not match the manifest.")

  const problems: string[] = []
  const hashes: string[] = []
  body.forEach((record, index) => {
    if (record.length !== expectedHeader.length) {
      problems.push(`Row ${index + 1} has ${record.length} cells, expected ${expectedHeader.length}.`)
      return
    }
    const cells: Record<string, string> = {}
    manifest.columns.forEach((column, position) => {
      cells[column] = unguard(record[position])
    })
    const hash = rowHash(cells)
    if (hash !== record[expectedHeader.length - 1]) problems.push(`Row ${index + 1} does not match its row_sha256.`)
    hashes.push(hash)
  })
  if (body.length !== manifest.row_count) {
    problems.push(`The manifest states ${manifest.row_count} rows; the file has ${body.length}.`)
  }
  if (exportDigest(manifest, hashes) !== stated) problems.push("The digest does not match the manifest and rows.")

  return { valid: problems.length === 0, digest: stated, rowCount: body.length, manifest, problems }
}
