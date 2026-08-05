/**
 * AP batch layouts for file-imported construction ERPs.
 *
 * What is and is not verified, precisely:
 *
 * - **Viewpoint Vista** — column names taken from Trimble's published AP Invoice
 *   Header (APHB) import documentation. Header only; see the note on that layout.
 * - **Sage 300 CRE** — Sage documents no fixed public column set. The import
 *   format is printed from inside the AP module per company file and varies with
 *   which optional AP fields are enabled, so any layout claiming to be "the"
 *   Sage format is a guess. This one is a starting point a controller maps
 *   against their own printed format.
 * - **Foundation** — no public import specification found. Unverified.
 *
 * None of these has been run against a live install. Treat a successful render
 * as "the file is well-formed", not "the import will succeed".
 *
 * Vendors and jobs are emitted as Arc's NAMES, not as the target system's codes.
 * Arc has no vendor-code or job-number field, and inventing always-blank columns
 * would look like a mapping that exists. The controller maps names to codes in
 * their import tool, which is how these imports are configured in practice; a
 * real code mapping is a separate piece of work with its own UI.
 *
 * Pure string building on purpose: this is how money reaches another ledger, and
 * it should be testable without a database or a provider.
 */

export type AccountingBatchFormat = "sage300" | "foundation" | "viewpoint" | "generic"

export interface BatchLineRecord {
  entityType: "invoice" | "payment" | "project_expense" | "bill" | "bill_payment" | "journal"
  direction: "post" | "reverse"
  amountCents: number
  currency: string
  postedAt: string
  memo: string | null
  payload: Record<string, unknown>
}

export interface BatchFormatDefinition {
  key: AccountingBatchFormat
  label: string
  fileExtension: "csv" | "txt"
  columns: Array<{ header: string; value: (line: BatchLineRecord) => string }>
}

function text(value: unknown): string {
  return value == null ? "" : String(value)
}

/**
 * Amounts render as signed decimal strings, computed from integer cents. A
 * reversal is negative — every one of these importers treats a negative AP line
 * as a debit memo against the vendor, which is what a returned payment is.
 */
function amount(line: BatchLineRecord): string {
  const signed = line.direction === "reverse" ? -line.amountCents : line.amountCents
  const whole = Math.trunc(Math.abs(signed) / 100)
  const fraction = String(Math.abs(signed) % 100).padStart(2, "0")
  return `${signed < 0 ? "-" : ""}${whole}.${fraction}`
}

/** Bare `YYYY-MM-DD`; none of these importers accept an ISO instant. */
function postedDate(line: BatchLineRecord): string {
  return line.postedAt.slice(0, 10)
}

function field(line: BatchLineRecord, key: string): string {
  return text(line.payload[key])
}

/**
 * ⚠ Sage publishes no canonical column list — the import format is printed from
 * inside the AP module and differs per company file. These are the fields Arc
 * holds, named to match Sage's AP vocabulary so a controller can line them up
 * against their own printed format. It is a starting point, not a spec.
 */
const SAGE_300: BatchFormatDefinition = {
  key: "sage300",
  label: "Sage 300 CRE (map against your printed format)",
  fileExtension: "csv",
  columns: [
    { header: "Vendor", value: (line) => field(line, "vendor_name") },
    { header: "Invoice", value: (line) => field(line, "document_number") },
    { header: "InvoiceDate", value: postedDate },
    { header: "DueDate", value: (line) => field(line, "due_date") || postedDate(line) },
    { header: "Job", value: (line) => field(line, "job_name") },
    { header: "CostCode", value: (line) => field(line, "cost_code") },
    { header: "Category", value: (line) => field(line, "cost_type") },
    { header: "Amount", value: amount },
    { header: "Description", value: (line) => text(line.memo) },
    { header: "ArcReference", value: (line) => field(line, "arc_reference") },
  ],
}

/** ⚠ No public import specification found. Unverified. */
const FOUNDATION: BatchFormatDefinition = {
  key: "foundation",
  label: "Foundation (unverified layout)",
  fileExtension: "csv",
  columns: [
    { header: "VendorName", value: (line) => field(line, "vendor_name") },
    { header: "InvoiceNumber", value: (line) => field(line, "document_number") },
    { header: "InvoiceDate", value: postedDate },
    { header: "JobName", value: (line) => field(line, "job_name") },
    { header: "CostCode", value: (line) => field(line, "cost_code") },
    { header: "CostClass", value: (line) => field(line, "cost_type") },
    { header: "Amount", value: amount },
    { header: "Memo", value: (line) => text(line.memo) },
    { header: "ArcReference", value: (line) => field(line, "arc_reference") },
  ],
}

/**
 * Column names taken from Vista's published AP Invoice Header (APHB) import
 * documentation, not from memory.
 *
 * ⚠ HEADER ONLY. Vista splits an AP invoice across two tables: APHB carries the
 * invoice, and the line table carries job, phase code and cost type. Arc emits
 * one row per bill, which is a header — so job costing is NOT in this file, and
 * a controller importing it gets invoices that land on the vendor without job
 * distribution. Use the generic layout, which carries the job fields, until Arc
 * emits the matching line import.
 *
 * `Co`, `Mth`, `PayMethod`, `CMCo`, `PrePaidYN` and `V1099YN` are required by
 * the importer and are company-configuration values Arc does not hold, so they
 * are emitted as empty columns for the controller to fill rather than omitted —
 * a missing column fails an import less obviously than a blank one.
 */
const VIEWPOINT: BatchFormatDefinition = {
  key: "viewpoint",
  label: "Viewpoint Vista (AP header)",
  fileExtension: "csv",
  columns: [
    { header: "Co", value: () => "" },
    { header: "Mth", value: (line) => postedDate(line).slice(0, 7) },
    { header: "Vendor", value: (line) => field(line, "vendor_name") },
    { header: "APRef", value: (line) => field(line, "document_number") },
    { header: "Description", value: (line) => text(line.memo) },
    { header: "InvDate", value: postedDate },
    { header: "DueDate", value: (line) => field(line, "due_date") || postedDate(line) },
    { header: "InvTotal", value: amount },
    { header: "PayMethod", value: () => "" },
    { header: "CMCo", value: () => "" },
    { header: "PrePaidYN", value: () => "N" },
    { header: "V1099YN", value: () => "" },
    { header: "ArcReference", value: (line) => field(line, "arc_reference") },
  ],
}

/**
 * Everything Arc knows, in stable column order. The honest default for a target
 * whose layout has not been confirmed — a controller can map it once rather than
 * discovering mid-import that a column they needed was dropped.
 */
const GENERIC: BatchFormatDefinition = {
  key: "generic",
  label: "Generic CSV",
  fileExtension: "csv",
  columns: [
    { header: "ArcReference", value: (line) => field(line, "arc_reference") },
    { header: "RecordType", value: (line) => line.entityType },
    { header: "Direction", value: (line) => line.direction },
    { header: "VendorName", value: (line) => field(line, "vendor_name") },
    { header: "DocumentNumber", value: (line) => field(line, "document_number") },
    { header: "PostedDate", value: postedDate },
    { header: "DueDate", value: (line) => field(line, "due_date") },
    { header: "JobName", value: (line) => field(line, "job_name") },
    { header: "CostCode", value: (line) => field(line, "cost_code") },
    { header: "CostType", value: (line) => field(line, "cost_type") },
    { header: "Amount", value: amount },
    { header: "Currency", value: (line) => line.currency.toUpperCase() },
    { header: "Memo", value: (line) => text(line.memo) },
  ],
}

export const BATCH_FORMATS: Record<AccountingBatchFormat, BatchFormatDefinition> = {
  sage300: SAGE_300,
  foundation: FOUNDATION,
  viewpoint: VIEWPOINT,
  generic: GENERIC,
}

export function isAccountingBatchFormat(value: unknown): value is AccountingBatchFormat {
  return typeof value === "string" && value in BATCH_FORMATS
}

function csvCell(value: string) {
  return /[",\n\r]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value
}

/**
 * Render a batch. CRLF because every one of these importers runs on Windows and
 * at least one of them treats a bare LF as a single malformed record.
 */
export function renderAccountingBatch(format: AccountingBatchFormat, lines: readonly BatchLineRecord[]): string {
  const definition = BATCH_FORMATS[format]
  const rows = [
    definition.columns.map((column) => column.header),
    ...lines.map((line) => definition.columns.map((column) => column.value(line))),
  ]
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n")
}
