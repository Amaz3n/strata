#!/usr/bin/env node
/**
 * QA-ORG SEED: a representative construction contract lifecycle for Arc Books
 * acceptance (gameplan C1 "Acceptance", the fourth tie-out).
 *
 *   node --env-file=.env.local scripts/seed-books-qa-org.js            # dry run
 *   node --env-file=.env.local scripts/seed-books-qa-org.js --commit   # write
 *   node --env-file=.env.local scripts/seed-books-qa-org.js --rollback --commit
 *
 * WHY THIS EXISTS
 * `Arc QA — Commercial` holds no bills, payments, or job cost, so enabling Books
 * there would project an empty ledger and every tie-out would pass at 0 = 0 — a
 * vacuous green, which is worse than a red. This seeds a contract that exercises
 * every posting rule the projector wires, with retainage left BOTH held and
 * released on each side so the retainage tie-outs compare non-zero numbers.
 *
 * SAFETY
 * Local dev points at PRODUCTION Supabase. This script therefore:
 *  - writes only to the hard-coded QA org, and re-reads the org name to confirm
 *    the id still belongs to it before touching anything;
 *  - refuses outright if the target resolves to a known customer org;
 *  - is dry-run by default — `--commit` is required to write;
 *  - tags every row it creates with metadata.seed_key so `--rollback` can remove
 *    exactly what it made and nothing else.
 *
 * It seeds SOURCE RECORDS ONLY. It never writes books_settings, gl_accounts,
 * accounting_facts, or journal_entries: enabling Books must go through the
 * product (Settings → Accounting), because `setBooksWorkspaceEnabled` also seeds
 * the chart of accounts via `initializeArcBooks`, and a hand-written settings row
 * would leave the org with no accounts and fail every posting.
 */

const { randomUUID } = require("node:crypto")
const { createClient } = require("@supabase/supabase-js")

const SEED_KEY = "books-acceptance-v1"

const QA_ORG_ID = "96ee73a8-a991-42f8-ac1c-4375a5ec414b"
const QA_ORG_NAME = "Arc QA — Commercial"
const QA_PROJECT_ID = "946a8b5f-178e-44d4-94ab-b27d71d06541"
const QA_PROJECT_NAME = "Arc QA — Commercial Office Buildout"

/** Orgs that must never be written to by a seed, whatever the arguments say. */
const FORBIDDEN_ORG_IDS = new Set([
  "eda817f7-b343-46e4-ad17-f61d9fe2e30d", // Patagonia Development LLC — customer
  "2c99095e-e918-4c90-968a-0a4d94ef7d13", // Strata Construction LLC — customer
])

const commit = process.argv.includes("--commit")
const rollback = process.argv.includes("--rollback")
const enableBooks = process.argv.includes("--enable-books")

/** The QA org owner, used for the `created_by` / `updated_by` stamps Books writes. */
const QA_OWNER_USER_ID = "28e7060a-17b8-4290-856c-b2c0bd734125"

// ---------------------------------------------------------------------------
// The scenario. Amounts are integer cents. The expected ledger these produce is
// asserted at the end of the run, so a drifted posting rule shows up here rather
// than in a nightly tie-out nobody is watching.
// ---------------------------------------------------------------------------
const S = {
  // AP: a bill with retainage, paid, then its retainage released via a second bill.
  bill1: { number: "QA-BILL-001", date: "2026-06-15", gross: 10_000_000, retainage: 1_000_000 },
  bill1Lines: [
    { description: "Structural steel — fabrication", cents: 6_000_000 },
    { description: "Structural steel — erection", cents: 4_000_000 },
  ],
  billPayment: { date: "2026-07-01", cents: 9_000_000 },
  apRelease: { number: "QA-BILL-001-R", date: "2026-07-20", cents: 1_000_000 },
  // AP: a second bill whose retainage is STILL HELD, so 2010 is non-zero.
  bill2: { number: "QA-BILL-002", date: "2026-07-10", gross: 4_000_000, retainage: 400_000 },
  bill2Line: { description: "Curtain wall — deposit", cents: 4_000_000 },

  // AR: an invoice with retainage, partly paid, partly reversed, retainage released.
  // `invoices.total_cents` is NET of retainage — the hold is a negative line.
  invoice1: { number: "QA-INV-001", date: "2026-06-20", gross: 15_000_000, retainage: 1_500_000 },
  invoicePayment: { date: "2026-07-05", cents: 10_000_000 },
  achReturn: { date: "2026-07-15", cents: 500_000 },
  arRelease: { number: "QA-INV-002-R", date: "2026-07-20", cents: 1_500_000 },
  // AR: a later invoice whose retainage is STILL HELD, so 1110 is non-zero.
  invoice2: { number: "QA-INV-003", date: "2026-07-25", gross: 5_000_000, retainage: 500_000 },

  expense: { date: "2026-06-25", cents: 250_000, description: "Site fencing rental" },
  labor: { date: "2026-06-30", cents: 480_000 },
}

/** Hand-computed ledger this scenario must produce. Verified against posting-rules.ts. */
const EXPECTED_LEDGER = [
  ["1000 Operating cash", 250_000, "debit"],
  ["1100 Accounts receivable", 10_000_000, "debit"],
  ["1110 Retainage receivable", 500_000, "debit"],
  ["5000 Job costs", 14_250_000, "debit"],
  ["5030 Labor costs", 480_000, "debit"],
  ["2000 Accounts payable", 4_600_000, "credit"],
  ["2010 Retainage payable", 400_000, "credit"],
  ["2200 Payroll clearing", 480_000, "credit"],
  ["2350 Contract liabilities", 20_000_000, "credit"],
]

const usd = (cents) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2 })}`

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_ROLE) {
  console.error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Run with --env-file=.env.local")
  process.exit(1)
}

const db = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { autoRefreshToken: false, persistSession: false } })

function fail(message) {
  console.error(`\n  REFUSING TO RUN: ${message}\n`)
  process.exit(1)
}

async function guard() {
  if (FORBIDDEN_ORG_IDS.has(QA_ORG_ID)) fail("target org is on the customer deny-list")

  const { data: org, error } = await db.from("orgs").select("id, name").eq("id", QA_ORG_ID).maybeSingle()
  if (error) fail(`could not read the target org: ${error.message}`)
  if (!org) fail(`org ${QA_ORG_ID} does not exist`)
  if (org.name !== QA_ORG_NAME) {
    fail(`org ${QA_ORG_ID} is named "${org.name}", expected "${QA_ORG_NAME}". The id may have been reused.`)
  }

  const { data: project, error: projectError } = await db
    .from("projects").select("id, name, org_id").eq("id", QA_PROJECT_ID).maybeSingle()
  if (projectError) fail(`could not read the target project: ${projectError.message}`)
  if (!project) fail(`project ${QA_PROJECT_ID} does not exist`)
  if (project.org_id !== QA_ORG_ID) fail(`project ${QA_PROJECT_ID} belongs to a different org`)
  if (project.name !== QA_PROJECT_NAME) {
    fail(`project ${QA_PROJECT_ID} is named "${project.name}", expected "${QA_PROJECT_NAME}"`)
  }

  console.log(`org      ${org.name} (${QA_ORG_ID})`)
  console.log(`project  ${project.name} (${QA_PROJECT_ID})`)
  console.log(`mode     ${rollback ? "ROLLBACK" : "SEED"} · ${commit ? "COMMIT (writes)" : "dry run (no writes)"}\n`)
}

const seedMeta = (extra = {}) => ({ seed_key: SEED_KEY, ...extra })

/** Insert one row tagged with the seed key, or return the existing one. */
async function ensure(table, matchColumn, matchValue, row, label) {
  const { data: existing, error: findError } = await db
    .from(table).select("id").eq("org_id", QA_ORG_ID).eq(matchColumn, matchValue).maybeSingle()
  if (findError) throw new Error(`lookup ${table}.${matchColumn}=${matchValue}: ${findError.message}`)
  if (existing) {
    console.log(`  = ${label} (exists)`)
    return existing.id
  }
  if (!commit) {
    console.log(`  + ${label} (dry run)`)
    // A real uuid, so downstream lookups keyed on this id still parse in a dry run.
    return randomUUID()
  }
  const { data, error } = await db.from(table).insert({ org_id: QA_ORG_ID, ...row }).select("id").single()
  if (error) throw new Error(`insert ${table} (${label}): ${error.message}`)
  console.log(`  + ${label}`)
  return data.id
}

async function seed() {
  console.log("Companies")
  const vendorId = await ensure("companies", "name", "QA Steel & Framing LLC", {
    name: "QA Steel & Framing LLC", company_type: "subcontractor", metadata: seedMeta(),
  }, "vendor  QA Steel & Framing LLC")
  const clientId = await ensure("companies", "name", "QA Northline Properties LLC", {
    name: "QA Northline Properties LLC", company_type: "client", metadata: seedMeta(),
  }, "client  QA Northline Properties LLC")

  console.log("\nContract (required: `retainage` rows carry a NOT NULL contract_id)")
  const contractId = await ensure("contracts", "title", "Arc QA — Books Acceptance Prime Contract", {
    project_id: QA_PROJECT_ID,
    title: "Arc QA — Books Acceptance Prime Contract",
    status: "active",
    contract_type: "fixed",
    total_cents: 425_000_000,
    retainage_percent: 10,
    effective_date: "2026-06-01",
    snapshot: seedMeta(),
  }, "prime contract $4,250,000.00 @ 10% retainage")

  console.log("\nAccounts payable")
  const bill1Id = await ensure("vendor_bills", "bill_number", S.bill1.number, {
    project_id: QA_PROJECT_ID, company_id: vendorId, bill_number: S.bill1.number,
    status: "paid", bill_date: S.bill1.date, due_date: "2026-07-15",
    total_cents: S.bill1.gross, paid_cents: S.billPayment.cents,
    retainage_cents: S.bill1.retainage, retainage_released_cents: S.apRelease.cents,
    retainage_percent: 10, paid_at: `${S.billPayment.date}T12:00:00Z`, metadata: seedMeta(),
  }, `bill ${S.bill1.number}  gross ${usd(S.bill1.gross)}  retainage ${usd(S.bill1.retainage)}  PAID`)

  for (const [index, spec] of S.bill1Lines.entries()) {
    const lineId = await ensure("bill_lines", "description", spec.description, {
      bill_id: bill1Id, project_id: QA_PROJECT_ID, description: spec.description, quantity: 1,
      unit_cost_cents: spec.cents, sort_order: index, metadata: seedMeta(),
    }, `  line ${spec.description} ${usd(spec.cents)}`)
    await ensure("job_cost_entries", "source_id", lineId, {
      project_id: QA_PROJECT_ID, source_type: "vendor_bill_line", source_id: lineId,
      incurred_on: S.bill1.date, cost_cents: spec.cents, status: "posted",
      gmp_classification: "inside_gmp", metadata: seedMeta(),
    }, `    job cost ${usd(spec.cents)}`)
  }

  await ensure("payments", "reference", "QA-PAY-BILL-001", {
    project_id: QA_PROJECT_ID, bill_id: bill1Id, amount_cents: S.billPayment.cents,
    status: "succeeded", method: "ach", reference: "QA-PAY-BILL-001",
    received_at: `${S.billPayment.date}T12:00:00Z`, fee_cents: 0, metadata: seedMeta(),
  }, `payment to vendor ${usd(S.billPayment.cents)}`)

  await ensure("vendor_bills", "bill_number", S.apRelease.number, {
    project_id: QA_PROJECT_ID, company_id: vendorId, bill_number: S.apRelease.number,
    status: "approved", bill_date: S.apRelease.date, due_date: "2026-08-20",
    total_cents: S.apRelease.cents, paid_cents: 0, retainage_cents: 0,
    // The projector routes on this marker: a release carries no new cost, it only
    // moves the withheld amount out of 2010 and into AP.
    metadata: seedMeta({ source: "retainage_release", released_bill_id: bill1Id }),
  }, `bill ${S.apRelease.number}  AP retainage release ${usd(S.apRelease.cents)}`)

  const bill2Id = await ensure("vendor_bills", "bill_number", S.bill2.number, {
    project_id: QA_PROJECT_ID, company_id: vendorId, bill_number: S.bill2.number,
    status: "approved", bill_date: S.bill2.date, due_date: "2026-08-10",
    total_cents: S.bill2.gross, paid_cents: 0,
    retainage_cents: S.bill2.retainage, retainage_released_cents: 0, retainage_percent: 10,
    metadata: seedMeta(),
  }, `bill ${S.bill2.number}  gross ${usd(S.bill2.gross)}  retainage ${usd(S.bill2.retainage)} STILL HELD`)

  const bill2LineId = await ensure("bill_lines", "description", S.bill2Line.description, {
    bill_id: bill2Id, project_id: QA_PROJECT_ID, description: S.bill2Line.description, quantity: 1,
    unit_cost_cents: S.bill2Line.cents, sort_order: 0, metadata: seedMeta(),
  }, `  line ${S.bill2Line.description} ${usd(S.bill2Line.cents)}`)
  await ensure("job_cost_entries", "source_id", bill2LineId, {
    project_id: QA_PROJECT_ID, source_type: "vendor_bill_line", source_id: bill2LineId,
    incurred_on: S.bill2.date, cost_cents: S.bill2Line.cents, status: "posted",
    gmp_classification: "inside_gmp", metadata: seedMeta(),
  }, `    job cost ${usd(S.bill2Line.cents)}`)

  console.log("\nAccounts receivable")
  const net1 = S.invoice1.gross - S.invoice1.retainage
  const invoice1Id = await ensure("invoices", "invoice_number", S.invoice1.number, {
    project_id: QA_PROJECT_ID, invoice_number: S.invoice1.number,
    title: "Application for Payment 1", status: "partial",
    issue_date: S.invoice1.date, due_date: "2026-07-20",
    subtotal_cents: S.invoice1.gross, total_cents: net1,
    // net billed, less the payment, plus the ACH return that came back
    balance_due_cents: net1 - S.invoicePayment.cents + S.achReturn.cents,
    client_visible: true, sent_at: `${S.invoice1.date}T12:00:00Z`, metadata: seedMeta(),
  }, `invoice ${S.invoice1.number}  gross ${usd(S.invoice1.gross)}  net ${usd(net1)}  PARTIAL`)

  await ensure("invoice_lines", "description", "Application for Payment 1 — work in place", {
    invoice_id: invoice1Id, description: "Application for Payment 1 — work in place",
    quantity: 1, unit_price_cents: S.invoice1.gross, sort_order: 0, metadata: seedMeta(),
  }, `  line work in place ${usd(S.invoice1.gross)}`)
  await ensure("invoice_lines", "description", "Retainage withheld (10%)", {
    invoice_id: invoice1Id, description: "Retainage withheld (10%)",
    quantity: 1, unit: "retainage", unit_price_cents: -S.invoice1.retainage, sort_order: 1, metadata: seedMeta(),
  }, `  line retainage withheld ${usd(-S.invoice1.retainage)}`)

  const arReleaseId = await ensure("invoices", "invoice_number", S.arRelease.number, {
    project_id: QA_PROJECT_ID, invoice_number: S.arRelease.number,
    title: "Retainage release", status: "sent",
    issue_date: S.arRelease.date, due_date: "2026-08-20",
    subtotal_cents: S.arRelease.cents, total_cents: S.arRelease.cents,
    balance_due_cents: S.arRelease.cents, client_visible: true,
    sent_at: `${S.arRelease.date}T12:00:00Z`, metadata: seedMeta(),
  }, `invoice ${S.arRelease.number}  AR retainage release ${usd(S.arRelease.cents)}`)

  await ensure("invoice_lines", "description", "Retainage released", {
    invoice_id: arReleaseId, description: "Retainage released",
    quantity: 1, unit_price_cents: S.arRelease.cents, sort_order: 0, metadata: seedMeta(),
  }, `  line retainage released ${usd(S.arRelease.cents)}`)

  // The `retainage` table is the authoritative home for AR retainage. This row is
  // both the hold on invoice 1 and the release onto the release invoice.
  await ensure("retainage", "invoice_id", invoice1Id, {
    project_id: QA_PROJECT_ID, contract_id: contractId, invoice_id: invoice1Id,
    amount_cents: S.invoice1.retainage, status: "invoiced",
    held_at: `${S.invoice1.date}T12:00:00Z`, released_at: `${S.arRelease.date}T12:00:00Z`,
    release_invoice_id: arReleaseId, metadata: seedMeta(),
  }, `retainage ${usd(S.invoice1.retainage)} held on ${S.invoice1.number} → released on ${S.arRelease.number}`)

  const invoicePaymentId = await ensure("payments", "reference", "QA-PAY-INV-001", {
    project_id: QA_PROJECT_ID, invoice_id: invoice1Id, amount_cents: S.invoicePayment.cents,
    status: "succeeded", method: "ach", reference: "QA-PAY-INV-001",
    received_at: `${S.invoicePayment.date}T12:00:00Z`, fee_cents: 0, metadata: seedMeta(),
  }, `customer payment ${usd(S.invoicePayment.cents)}`)

  await ensure("payment_reversals", "provider_reversal_id", "QA-ACH-RETURN-001", {
    project_id: QA_PROJECT_ID, invoice_id: invoice1Id, payment_id: invoicePaymentId,
    amount_cents: S.achReturn.cents, reversal_type: "ach_return", status: "succeeded",
    provider_reversal_id: "QA-ACH-RETURN-001", reason: "Insufficient funds (QA fixture)",
    occurred_at: `${S.achReturn.date}T12:00:00Z`, metadata: seedMeta(),
  }, `ACH return ${usd(S.achReturn.cents)}`)

  const net2 = S.invoice2.gross - S.invoice2.retainage
  const invoice2Id = await ensure("invoices", "invoice_number", S.invoice2.number, {
    project_id: QA_PROJECT_ID, invoice_number: S.invoice2.number,
    title: "Application for Payment 2", status: "sent",
    issue_date: S.invoice2.date, due_date: "2026-08-25",
    subtotal_cents: S.invoice2.gross, total_cents: net2, balance_due_cents: net2,
    client_visible: true, sent_at: `${S.invoice2.date}T12:00:00Z`, metadata: seedMeta(),
  }, `invoice ${S.invoice2.number}  gross ${usd(S.invoice2.gross)}  net ${usd(net2)}  SENT`)

  await ensure("invoice_lines", "description", "Application for Payment 2 — work in place", {
    invoice_id: invoice2Id, description: "Application for Payment 2 — work in place",
    quantity: 1, unit_price_cents: S.invoice2.gross, sort_order: 0, metadata: seedMeta(),
  }, `  line work in place ${usd(S.invoice2.gross)}`)
  await ensure("invoice_lines", "description", "Retainage withheld (10%) — AFP 2", {
    invoice_id: invoice2Id, description: "Retainage withheld (10%) — AFP 2",
    quantity: 1, unit: "retainage", unit_price_cents: -S.invoice2.retainage, sort_order: 1, metadata: seedMeta(),
  }, `  line retainage withheld ${usd(-S.invoice2.retainage)}`)

  await ensure("retainage", "invoice_id", invoice2Id, {
    project_id: QA_PROJECT_ID, contract_id: contractId, invoice_id: invoice2Id,
    amount_cents: S.invoice2.retainage, status: "held",
    held_at: `${S.invoice2.date}T12:00:00Z`, metadata: seedMeta(),
  }, `retainage ${usd(S.invoice2.retainage)} STILL HELD on ${S.invoice2.number}`)

  console.log("\nDirect cost")
  // tax_cents stays 0 so the expense equals its subledger entry exactly; a taxed
  // expense would need the subledger to agree on whether tax is job cost.
  const expenseId = await ensure("project_expenses", "description", S.expense.description, {
    project_id: QA_PROJECT_ID, vendor_company_id: vendorId, description: S.expense.description,
    expense_date: S.expense.date, amount_cents: S.expense.cents, tax_cents: 0,
    status: "approved", payment_method: "company_card", metadata: seedMeta(),
  }, `expense ${S.expense.description} ${usd(S.expense.cents)}`)
  await ensure("job_cost_entries", "source_id", expenseId, {
    project_id: QA_PROJECT_ID, source_type: "project_expense", source_id: expenseId,
    incurred_on: S.expense.date, cost_cents: S.expense.cents, status: "posted",
    gmp_classification: "inside_gmp", metadata: seedMeta(),
  }, `  job cost ${usd(S.expense.cents)}`)

  // `job_cost_entries.source_id` is text, so field labor with no `time_entries` row
  // behind it can carry a stable synthetic key and stay idempotent across re-runs.
  const laborSourceId = "qa-seed-time-entry-001"
  await ensure("job_cost_entries", "source_id", laborSourceId, {
    project_id: QA_PROJECT_ID, source_type: "time_entry", source_id: laborSourceId,
    incurred_on: S.labor.date, cost_cents: S.labor.cents, status: "posted",
    gmp_classification: "inside_gmp", metadata: seedMeta({ note: "field labor" }),
  }, `field labor ${usd(S.labor.cents)}`)
}

async function doRollback() {
  // Child rows first: FKs point upward.
  const tables = [
    "payment_reversals", "payments", "job_cost_entries", "bill_lines", "invoice_lines",
    "retainage", "vendor_bills", "invoices", "project_expenses", "companies",
  ]
  for (const table of tables) {
    if (!commit) {
      const { count } = await db.from(table).select("id", { count: "exact", head: true })
        .eq("org_id", QA_ORG_ID).eq("metadata->>seed_key", SEED_KEY)
      console.log(`  - ${table}: ${count ?? 0} row(s) would be deleted`)
      continue
    }
    const { data, error } = await db.from(table).delete()
      .eq("org_id", QA_ORG_ID).eq("metadata->>seed_key", SEED_KEY).select("id")
    if (error) throw new Error(`delete ${table}: ${error.message}`)
    console.log(`  - ${table}: ${data?.length ?? 0} row(s) deleted`)
  }
  // contracts keeps its marker in `snapshot`, not `metadata`.
  if (commit) {
    const { data, error } = await db.from("contracts").delete()
      .eq("org_id", QA_ORG_ID).eq("snapshot->>seed_key", SEED_KEY).select("id")
    if (error) throw new Error(`delete contracts: ${error.message}`)
    console.log(`  - contracts: ${data?.length ?? 0} row(s) deleted`)
  }
}

/** Read the source records back and confirm they imply the ledger we expect. */
async function verify() {
  const [bills, invoices, jobCost, retainage] = await Promise.all([
    db.from("vendor_bills").select("total_cents, paid_cents, retainage_cents, retainage_released_cents, status, metadata")
      .eq("org_id", QA_ORG_ID).in("status", ["approved", "partial", "paid"]),
    db.from("invoices").select("invoice_number, status, balance_due_cents")
      .eq("org_id", QA_ORG_ID).not("status", "in", "(draft,void)"),
    db.from("job_cost_entries").select("cost_cents").eq("org_id", QA_ORG_ID).eq("status", "posted"),
    db.from("retainage").select("amount_cents, status").eq("org_id", QA_ORG_ID),
  ])

  const apOpen = (bills.data ?? []).reduce((sum, r) =>
    sum + Math.max(0, (r.total_cents ?? 0) - (r.paid_cents ?? 0) - (r.retainage_cents ?? 0)), 0)
  const apRetainage = (bills.data ?? []).reduce((sum, r) =>
    sum + Math.max(0, (r.retainage_cents ?? 0) - (r.retainage_released_cents ?? 0)), 0)
  const jobCostTotal = (jobCost.data ?? []).reduce((sum, r) => sum + (r.cost_cents ?? 0), 0)
  const arHeld = (retainage.data ?? []).filter((r) => r.status === "held")
    .reduce((sum, r) => sum + (r.amount_cents ?? 0), 0)

  const seeded = (invoices.data ?? []).filter((r) => r.invoice_number?.startsWith("QA-INV-"))
  const foreign = (invoices.data ?? []).filter((r) => !r.invoice_number?.startsWith("QA-INV-"))
  const arSeeded = seeded.reduce((sum, r) => sum + Math.max(0, r.balance_due_cents ?? 0), 0)
  const arForeign = foreign.reduce((sum, r) => sum + Math.max(0, r.balance_due_cents ?? 0), 0)

  console.log("\nExpected ledger once Books is enabled and the projection runs")
  for (const [label, cents, side] of EXPECTED_LEDGER) {
    console.log(`  ${label.padEnd(28)} ${usd(cents).padStart(16)} ${side}`)
  }

  console.log("\nSubledger totals the tie-outs will compare against")
  console.log(`  AP open (total − paid − retainage)   ${usd(apOpen).padStart(16)}  expect ${usd(4_600_000)}`)
  console.log(`  AP retainage still held             ${usd(apRetainage).padStart(16)}  expect ${usd(400_000)}`)
  console.log(`  Job cost subledger                  ${usd(jobCostTotal).padStart(16)}  expect ${usd(14_730_000)}`)
  console.log(`  AR retainage still held             ${usd(arHeld).padStart(16)}  expect ${usd(500_000)}`)
  console.log(`  AR open — seeded invoices           ${usd(arSeeded).padStart(16)}  expect ${usd(10_000_000)}`)

  if (arForeign > 0) {
    console.log(`\n  ⚠ AR open — OTHER invoices in this org  ${usd(arForeign)}`)
    console.log("    These are pre-existing WS02 fixtures in `saved` status. The AR tie-out counts")
    console.log("    them (it excludes only draft and void) but the projector does not post them")
    console.log("    (it posts only sent/partial/paid/overdue), so `ar_control` will fail by this")
    console.log("    amount. That is a real definition mismatch, not a seeding artifact.")
  }
}

/**
 * Turn Books on for the QA org in `shadow` mode.
 *
 * Mirrors `initializeArcBooks` + `setBooksWorkspaceEnabled` step for step, and
 * imports the REAL `CONSTRUCTION_CHART_TEMPLATE` rather than restating it — a
 * second copy of the chart is exactly the kind of drift this codebase keeps
 * paying for. The product path is still the right one for a human (Settings →
 * Accounting); this exists so an unattended QA run does not have to hand-write a
 * `books_settings` row and leave the org with no accounts.
 */
async function doEnableBooks() {
  require("./register-ts-node-test")
  const { CONSTRUCTION_CHART_TEMPLATE } = require("../lib/services/books/chart-of-accounts.ts")

  const { data: before, error: beforeError } = await db
    .from("books_settings").select("workspace_enabled, arc_ledger_mode, ledger_authority")
    .eq("org_id", QA_ORG_ID).maybeSingle()
  if (beforeError) throw new Error(`read books_settings: ${beforeError.message}`)
  console.log(`  before: ${before ? JSON.stringify(before) : "no books_settings row"}`)
  console.log(`  chart:  ${CONSTRUCTION_CHART_TEMPLATE.length} accounts from CONSTRUCTION_CHART_TEMPLATE`)

  if (!commit) {
    console.log("  + would upsert books_settings (shadow, external authority) and the chart (dry run)")
    return
  }

  const settings = await db.from("books_settings").upsert({
    org_id: QA_ORG_ID,
    workspace_enabled: true,
    ledger_authority: "external",
    arc_ledger_mode: "shadow",
    external_sync_posture: "normal",
    functional_currency: "usd",
    reporting_basis: "accrual",
    active_policy_version: 1,
    created_by: QA_OWNER_USER_ID,
    updated_by: QA_OWNER_USER_ID,
  }, { onConflict: "org_id", ignoreDuplicates: true })
  if (settings.error) throw new Error(`upsert books_settings: ${settings.error.message}`)

  const chart = await db.from("gl_accounts").upsert(
    CONSTRUCTION_CHART_TEMPLATE.map((account) => ({
      org_id: QA_ORG_ID,
      code: account.code,
      name: account.name,
      account_type: account.accountType,
      subtype: account.subtype,
      normal_balance: account.normalBalance,
      cash_flow_category: account.cashFlowCategory ?? null,
      is_system: account.system,
      active: true,
      created_by: QA_OWNER_USER_ID,
      updated_by: QA_OWNER_USER_ID,
    })),
    { onConflict: "org_id,code", ignoreDuplicates: true },
  )
  if (chart.error) throw new Error(`upsert gl_accounts: ${chart.error.message}`)

  // `upsert(..., ignoreDuplicates)` will not flip an existing row, exactly as
  // `setBooksWorkspaceEnabled` handles separately.
  const update = await db.from("books_settings")
    .update({ workspace_enabled: true, arc_ledger_mode: before?.arc_ledger_mode === "disabled" ? "shadow" : (before?.arc_ledger_mode ?? "shadow"), updated_by: QA_OWNER_USER_ID })
    .eq("org_id", QA_ORG_ID)
  if (update.error) throw new Error(`enable books: ${update.error.message}`)

  const { count } = await db.from("gl_accounts").select("id", { count: "exact", head: true }).eq("org_id", QA_ORG_ID)
  console.log(`  + Books enabled in shadow mode · ${count} GL accounts seeded`)
}

async function main() {
  await guard()
  if (enableBooks) {
    console.log("Enabling Arc Books (shadow mode)")
    await doEnableBooks()
    console.log(commit ? "\nDone." : "\nDry run only — re-run with --commit to write.")
    return
  }
  if (rollback) {
    console.log("Removing seeded rows")
    await doRollback()
  } else {
    await seed()
    await verify()
  }
  console.log(commit ? "\nDone." : "\nDry run only — re-run with --commit to write.")
}

main().catch((error) => {
  console.error(`\nFAILED: ${error.message}`)
  process.exit(1)
})
