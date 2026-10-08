// RESTORE-01 — recovery from a Books archive (B06): a populated company is
// exported, verified, preflighted against the actual target schema, planned with
// explicit identity mappings, lost (every archived row deleted) and loaded back
// from the plan alone. Every archived table returns byte-identical, closed months
// still read as closed, guards are back on, and ordinary work continues: a new
// month, billing, collection, a bill, an asset and a close.
const { randomUUID } = require("node:crypto")
const { app, project } = require("./shared.cjs")

const refusal = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }
const glId = (kit, org, code) => kit.rows(`select id from public.gl_accounts where org_id=${kit.q(org.orgId)} and code=${kit.q(code)}`)[0].id
const silent = { equal: () => true, checks: [] }

function archive(kit, orgId) {
  const { BOOKS_EXPORT_SCHEMA_VERSION, EXPORT_TABLES } = app("books/export-contract")
  const { booksDigest } = require("../../../lib/services/books/hash")
  const { historicalDocumentInventory } = app("books/tax-attachment-archive")
  const snapshot = JSON.parse(kit.sql(`select public.capture_books_export_snapshot(${kit.q(orgId)});`))
  const tables = Object.fromEntries(EXPORT_TABLES.map((table) => [table, snapshot.tables[table] ?? []]))
  return { tables, manifest: { schemaVersion: BOOKS_EXPORT_SCHEMA_VERSION, orgId, tables: Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, { rows: rows.length, checksum: booksDigest(rows) }])),
    supportingFiles: [], supportingHistoricalFiles: historicalDocumentInventory(tables, orgId) } }
}

// The target schema as the restore sees it: every archived table's columns and foreign keys.
function catalog(kit) {
  const { EXPORT_TABLES } = app("books/export-contract")
  const tables = [...EXPORT_TABLES, "orgs", "app_users"].map(kit.q).join(",")
  return JSON.parse(kit.sql(`select jsonb_build_object('columns',(select jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'name',a.attname,'notNull',a.attnotnull,'hasDefault',a.atthasdef,'generated',a.attgenerated<>'')) from pg_class c join pg_namespace n on n.oid=c.relnamespace join pg_attribute a on a.attrelid=c.oid where ((n.nspname='public' and c.relname in(${tables})) or (n.nspname='auth' and c.relname='users')) and a.attnum>0 and not a.attisdropped),
    'foreignKeys',(select jsonb_agg(jsonb_build_object('schema',n.nspname,'table',c.relname,'match',case when f.confmatchtype='f' then 'full' else 'simple' end,'columns',(select jsonb_agg(a.attname order by k.ordinality) from unnest(f.conkey) with ordinality k(attnum,ordinality) join pg_attribute a on a.attrelid=f.conrelid and a.attnum=k.attnum),'targetSchema',rn.nspname,'targetTable',rc.relname,'targetColumns',(select jsonb_agg(a.attname order by k.ordinality) from unnest(f.confkey) with ordinality k(attnum,ordinality) join pg_attribute a on a.attrelid=f.confrelid and a.attnum=k.attnum))) from pg_constraint f join pg_class c on c.oid=f.conrelid join pg_namespace n on n.oid=c.relnamespace join pg_class rc on rc.oid=f.confrelid join pg_namespace rn on rn.oid=rc.relnamespace where f.contype='f' and ((n.nspname='public' and c.relname in(${tables})) or (n.nspname='auth' and c.relname='users'))))::text;`))
}

// The people the archive refers to, mapped explicitly (they exist in the target).
function identities(kit, orgId) {
  const users = kit.rows(`select to_jsonb(u)::text j from public.app_users u where u.id in (select user_id from public.memberships where org_id=${kit.q(orgId)}) order by u.id`).map((row) => JSON.parse(row.j))
  return [
    { schema: "public", table: "orgs", rows: [JSON.parse(kit.rows(`select to_jsonb(o)::text j from public.orgs o where id=${kit.q(orgId)}`)[0].j)] },
    { schema: "public", table: "app_users", rows: users },
    { schema: "auth", table: "users", rows: users.map((user) => ({ id: user.id, email: user.email, banned_until: "infinity" })) },
  ]
}

/** Lose the company's Books data and load it back from the restore plan alone. */
function restore(kit, orgId) {
  const { verifyBooksExportBundle, EXPORT_TABLES } = app("books/export-contract")
  const { prepareBooksRestorePlan } = app("books/restore-plan")
  const bundle = archive(kit, orgId)
  const verification = verifyBooksExportBundle(bundle)
  const plan = prepareBooksRestorePlan({ bundle, catalog: catalog(kit), dependencies: identities(kit, orgId), fundingActors: {} })
  if (!plan.preflight.readyForRestoreAttempt) return { bundle, verification, plan, ms: null }
  const statements = ["begin;", "set local session_replication_role = replica;"]
  for (const table of EXPORT_TABLES) statements.push(`delete from public.${table} where org_id = ${kit.q(orgId)};`)
  for (const table of EXPORT_TABLES) {
    const rows = plan.tables[table] ?? []
    if (!rows.length) continue
    statements.push(`do $restore$ declare cols text; begin
  select string_agg(quote_ident(column_name), ',' order by ordinal_position) into cols from information_schema.columns where table_schema='public' and table_name=${kit.q(table)} and is_generated='NEVER';
  execute format('insert into public.%I (%s) overriding system value select %s from jsonb_populate_recordset(null::public.%I, $1)', ${kit.q(table)}, cols, cols, ${kit.q(table)}) using $rows$${JSON.stringify(rows)}$rows$::jsonb;
end $restore$;`)
  }
  statements.push("commit;")
  const started = Date.now()
  kit.sql(statements.join("\n"))
  return { bundle, verification, plan, ms: Date.now() - started }
}

function tableDigests(kit, orgId) {
  const { booksDigest } = require("../../../lib/services/books/hash")
  return Object.fromEntries(Object.entries(archive(kit, orgId).tables).map(([table, rows]) => [table, booksDigest(rows)]))
}

async function controls(kit, orgId, asOf) {
  const rows = await kit.service(() => app("books/verifier").runLedgerTieOuts(orgId, asOf))
  return Object.fromEntries(rows.map((row) => [row.code, row.status]).sort(([a], [b]) => a.localeCompare(b)))
}

// A closed two-company group: intercompany payment, invoices and bills for both
// companies, a WIP review, a bank reconciliation and July closed with statements.
async function closedGroup(kit, expected, check) {
  const input = expected.inputs
  const entity = require("./entity-01.cjs")
  const built = await entity.subcases["company-subledgers-and-close"](kit, require("../expected/ENTITY-01.json").subcases["company-subledgers-and-close"], silent)
  const orgId = built.orgId
  const owner = { userId: kit.rows(`select m.user_id from public.memberships m join public.roles r on r.id=m.role_id where m.org_id=${kit.q(orgId)} and r.key='org_owner'`)[0].user_id, orgId, productTier: "residential", role: "org_owner" }
  const org = { orgId, owner, ...kit.rows(`select (select id from public.projects where org_id=${kit.q(orgId)} and legal_entity_id is null order by created_at limit 1) "projectId",
    (select id from public.companies where org_id=${kit.q(orgId)} order by created_at limit 1) "vendorId", (select id from public.cost_codes where org_id=${kit.q(orgId)} limit 1) "costCodeId"`)[0] }
  const july = kit.rows(`select id from public.accounting_periods where org_id=${kit.q(orgId)} and period_start='2026-07-01'`)[0].id
  const before = { digests: tableDigests(kit, orgId), controls: await controls(kit, orgId, "2026-07-31"),
    statements: kit.rows(`select statement_type, coalesce(legal_entity_id::text,'group') company, content_hash from public.financial_statement_snapshots where period_id=${kit.q(july)} order by 1, 2, 3`) }

  const result = restore(kit, orgId)
  const after = { digests: tableDigests(kit, orgId), controls: await controls(kit, orgId, "2026-07-31"),
    statements: kit.rows(`select statement_type, coalesce(legal_entity_id::text,'group') company, content_hash from public.financial_statement_snapshots where period_id=${kit.q(july)} order by 1, 2, 3`) }
  const changedTables = Object.keys(before.digests).filter((table) => before.digests[table] !== after.digests[table])
  const populated = Object.values(result.bundle.tables).filter((rows) => rows.length).length

  // Guards are on again, and an exact rerun of the projector changes nothing.
  const lines = () => Number(kit.rows(`select count(*) n from public.journal_lines where org_id=${kit.q(orgId)}`)[0].n)
  const linesBefore = lines()
  await project(kit, org)
  const rerunAddsNothing = lines() === linesBefore
  const closedMonth = await refusal(() => kit.as(owner, () => app("books/bookkeeping").createAdjustingJournal({ entryDate: "2026-07-15", memo: "Late July entry after restore",
    lines: [{ accountCode: "6900", debitCents: 100, creditCents: 0 }, { accountCode: "1000", debitCents: 0, creditCents: 100 }] })))

  // Ordinary work after the restore: a new month, billing and collection, a bill, an asset, a close.
  const august = await kit.as(owner, () => app("books/period-close").createAccountingPeriod({ periodStart: "2026-08-01", periodEnd: "2026-08-31", fiscalYear: 2026, fiscalPeriod: 8 }))
  const invoice = await kit.as(owner, () => app("invoices").createInvoice({ input: { project_id: org.projectId, invoice_number: `R-${randomUUID().slice(0, 6)}`, title: "August billing", issue: true,
    issue_date: "2026-08-05", due_date: "2026-08-31", sent_to_emails: ["owner@acceptance.example.test"], lines: [{ description: "Work completed", quantity: 1, unit_cost: input.augustInvoiceCents / 100, taxable: false }] } }))
  await kit.as(owner, () => app("payments").recordMultiInvoicePayment({ received_at: "2026-08-12T12:00:00Z", method: "check", idempotency_key: randomUUID(), allocations: [{ invoice_id: invoice.id, amount_cents: input.augustInvoiceCents }] }))
  const vendorBills = app("vendor-bills")
  const bill = await kit.as(owner, () => vendorBills.createProjectVendorBill({ projectId: org.projectId, input: { company_id: org.vendorId, bill_number: "R-B1", bill_date: "2026-08-08", due_date: "2026-08-31", total_cents: input.augustBillCents,
    actual_lines: [{ cost_code_id: org.costCodeId, description: "Trim", amount_cents: input.augustBillCents, project_id: org.projectId }] } }))
  await kit.as(owner, () => vendorBills.approveVendorBillsAtomic([{ id: bill.id }]))
  await kit.as(owner, () => vendorBills.updateVendorBillStatus({ billId: bill.id, input: { status: "paid", payment_amount_cents: input.augustBillCents, payment_method: "check", payment_date: "2026-08-20",
    books_payment_account_id: glId(kit, org, "1000"), payment_idempotency_key: `restore-${orgId}` } }))
  const registers = app("books/registers")
  const asset = await kit.as(owner, () => registers.createFixedAsset({ assetNumber: "TRK-R", name: "Crew truck", placedInServiceOn: "2026-08-15", acquisitionCostCents: input.truckCents, salvageValueCents: 0, usefulLifeMonths: 36,
    assetAccountId: glId(kit, org, "1500"), accumulatedDepreciationAccountId: glId(kit, org, "1590"), depreciationExpenseAccountId: glId(kit, org, "6080"), fundingAccountId: glId(kit, org, "1000"), postAcquisition: true }))
  await kit.as(owner, () => registers.postFixedAssetDepreciation({ assetId: asset.id ?? asset, throughDate: "2026-08-31", amountCents: input.truckCents / 36 }))
  await kit.drainOutbox(orgId)
  await project(kit, org)
  const { prepareAndReview } = require("./wip-01.cjs").helpers
  const reviewer = { userId: kit.rows(`select m.user_id from public.memberships m join public.roles r on r.id=m.role_id where m.org_id=${kit.q(orgId)} and r.key<>'org_owner' order by m.created_at limit 1`)[0].user_id, orgId, productTier: "residential", role: "org_accountant" }
  await prepareAndReview(kit, { ...org, reviewer, periods: { "2026-08": { periodId: august } } }, "2026-08", { contractCents: input.contractCents, eacCents: input.eacCents })
  const { getClearingSupportWorkspace, reviewClearingSupport } = app("books/clearing-support")
  const clearing = await kit.as(owner, () => getClearingSupportWorkspace(august))
  if (clearing.balances.some((row) => row.balanceCents !== 0)) await kit.as(owner, () => reviewClearingSupport({ periodId: august, ledgerDigest: clearing.ledgerDigest, items: clearing.balances.filter((row) => row.balanceCents !== 0)
    .map((row) => ({ code: row.code, amountCents: row.balanceCents, expectedSettlementDate: "2026-09-02", explanation: "August receipts deposited September 2", evidenceUrl: "https://evidence.acceptance.example.test/restore-01/deposit" })) }))
  const { createBankReconciliation, closeBankReconciliation } = app("books/bank-reconciliation")
  const bankId = kit.rows(`select id from public.bank_accounts where org_id=${kit.q(orgId)} and gl_account_id=${kit.q(glId(kit, org, "1005"))}`)[0].id
  const reconciliation = await kit.as(owner, () => createBankReconciliation({ bankAccountId: bankId, statementStart: "2026-08-01", statementEnd: "2026-08-31", beginningBalanceCents: 0, endingBalanceCents: 0 }))
  await kit.as(owner, () => closeBankReconciliation(reconciliation))
  const close = await refusal(() => kit.as(owner, () => app("books/period-close").closeAccountingPeriod(august)))

  check.equal("the archive verifies and preflights clean; every archived table returns identical; July still reads as closed; guards are on; August is worked and closed", expected.expected, {
    archiveVerifies: result.verification.valid, ready: result.plan.preflight.readyForRestoreAttempt, secretRecovery: result.plan.preflight.secretRecovery.length,
    populatedTables: populated >= input.minimumPopulatedTables, changedTables, plannedChanges: [...new Set(result.plan.changes.map((change) => change.table))].sort(), controlsUnchanged: JSON.stringify(after.controls) === JSON.stringify(before.controls),
    closedStatementsUnchanged: JSON.stringify(after.statements) === JSON.stringify(before.statements) && before.statements.length > 0,
    rerunAddsNothing, closedMonthRefused: closedMonth !== "allowed", augustClosed: close === "allowed" ? "closed" : close,
    augustControls: Object.values(await controls(kit, orgId, "2026-08-31")).every((status) => status === "passed" || status === "not_applicable"),
  })
  return { orgId, restoreMs: result.ms, blockers: result.plan.preflight.blockers.slice(0, 10), externalDependencies: result.plan.preflight.externalDependencies.slice(0, 10), populatedTables: populated, rows: Object.values(result.bundle.tables).reduce((sum, rows) => sum + rows.length, 0) }
}

// Tax records: an accepted-then-corrected 1099 package and its filing file, and a
// superseded and approved tax workpaper, come back exactly; the archive carries no
// taxpayer ID and preflight names each one that Vault recovery must supply.
async function taxRecords(kit, expected, check) {
  const tax = require("./tax-01.cjs")
  const built = await tax.subcases["package-review-and-handoff"](kit, require("../expected/TAX-01.json").subcases["package-review-and-handoff"], silent)
  const orgId = built.orgId
  const owner = { userId: kit.rows(`select m.user_id from public.memberships m join public.roles r on r.id=m.role_id where m.org_id=${kit.q(orgId)} and r.key='org_owner'`)[0].user_id, orgId, productTier: "residential", role: "org_owner" }
  const live = built.packages.at(-1)
  const packages = app("books/vendor-1099-packages")
  const file = (await kit.as(owner, () => packages.build1099FilingFile(live))).content
  const report = JSON.stringify((await kit.as(owner, () => app("reports/vendor-1099").getVendor1099Report({ year: 2026 }))).rows)
  const before = { digests: tableDigests(kit, orgId), file, report }
  const result = restore(kit, orgId)
  const restoredDigests = tableDigests(kit, orgId)
  // The documented recovery step for the company's own TIN: enter it again.
  const primary = kit.rows(`select public.books_primary_entity(${kit.q(orgId)}) id`)[0].id
  const restoredPayer = await refusal(() => kit.as(owner, () => packages.build1099FilingFile(live)))
  await kit.as(owner, () => packages.setPayerTaxIdentity({ legalEntityId: primary, tin: "112223334", address: require("./tax-01.cjs").helpers.ADDRESS("100 Builder Way") }))
  const after = { digests: restoredDigests, file: (await kit.as(owner, () => packages.build1099FilingFile(live))).content,
    report: JSON.stringify((await kit.as(owner, () => app("reports/vendor-1099").getVendor1099Report({ year: 2026 }))).rows) }
  const archived = JSON.stringify(result.bundle.tables)
  check.equal("1099 packages and the 1099 report come back exactly; no taxpayer ID is archived and preflight names each one Vault must supply", expected.expected, {
    ready: result.plan.preflight.readyForRestoreAttempt,
    secretRecovery: result.plan.preflight.secretRecovery.map((row) => row.table).sort(),
    fileRefusedUntilPayerTinReentered: /taxpayer ID changed/.test(restoredPayer),
    noTaxpayerIdArchived: !/\b(123456781|987654324|555443333|444556666|112223334)\b/.test(archived) && !archived.includes("payer_tin_secret_id"),
    packageStatuses: result.bundle.tables.books_1099_packages.map((row) => row.status).sort(),
    changedTables: Object.keys(before.digests).filter((table) => before.digests[table] !== after.digests[table]),
    filingFileIdentical: before.file === after.file, reportIdentical: before.report === after.report,
  })
  return { orgId, restoreMs: result.ms }
}

// The archive is built by a background job (B06.1). One database snapshot: a
// journal committed while the capture is running is not in it. An attempt that
// died is recorded as interrupted when the next starts; a failed attempt keeps
// its reason and names no file; an export whose job is gone fails explicitly; a
// finished export cannot be started again.
async function backgroundArchive(kit, expected, check) {
  const { greenfieldOrg } = require("./shared.cjs")
  const org = await greenfieldOrg(kit, { name: "RESTORE-01 background archive", periods: ["2026-07"] })
  const { q } = kit
  const journal = (memo) => kit.as(org.reviewer, () => app("books/bookkeeping").createAdjustingJournal({ entryDate: "2026-07-10", memo,
    lines: [{ accountCode: "6900", debitCents: 1000, creditCents: 0 }, { accountCode: "3010", debitCents: 0, creditCents: 1000 }] }))
  await journal("Before the capture")
  const entries = () => Number(kit.rows(`select count(*) n from public.journal_entries where org_id=${q(org.orgId)}`)[0].n)
  const before = entries()
  // The capture sleeps inside its one statement while a second connection commits.
  const { spawn } = require("node:child_process")
  const capture = new Promise((resolve, reject) => {
    const child = spawn("docker", ["exec", kit.container, "psql", "-U", "postgres", "-At", "-c",
      `select pg_sleep(2), jsonb_array_length(public.capture_books_export_snapshot(${q(org.orgId)})->'tables'->'journal_entries')`])
    let out = ""; child.stdout.on("data", (chunk) => { out += chunk }); child.on("error", reject)
    child.on("close", (code) => code === 0 ? resolve(Number(out.trim().split("|").pop())) : reject(Error(`capture exited ${code}`)))
  })
  await new Promise((resolve) => setTimeout(resolve, 500))
  await journal("Committed during the capture")
  const captured = await capture

  const exports = app("books/exports")
  const status = (id) => kit.rows(`select status, attempt_count, storage_path, content_hash, error_message, attempts from public.books_exports where id=${q(id)}`)[0]
  const outcomes = (row) => (typeof row.attempts === "string" ? JSON.parse(row.attempts) : row.attempts).map((attempt) => `${attempt.attempt}:${attempt.outcome}`)
  const requested = await kit.as(org.owner, () => exports.requestBooksExport({ exportType: "complete" }))
  const queued = { status: status(requested.exportId).status, job: Number(kit.rows(`select count(*) n from public.outbox where org_id=${q(org.orgId)} and job_type='generate_books_export' and payload->>'export_id'=${q(requested.exportId)}`)[0].n) }
  // A worker took the job and died before finishing.
  kit.sql(`select public.start_books_export_attempt(${q(org.orgId)}, ${q(requested.exportId)})`)
  const job = () => kit.rows(`select id from public.outbox where org_id=${q(org.orgId)} and job_type='generate_books_export' and payload->>'export_id'=${q(requested.exportId)}`)[0].id
  await kit.drainOutbox(org.orgId).catch(() => {})
  const afterRetry = status(requested.exportId)
  kit.sql(`update public.outbox set status='failed' where id=${q(job())}`)

  // A second export whose job was lost, an hour on.
  const lost = await kit.as(org.owner, () => exports.requestBooksExport({ exportType: "complete" }))
  kit.sql(`delete from public.outbox where org_id=${q(org.orgId)} and payload->>'export_id'=${q(lost.exportId)}; update public.books_exports set requested_at=now() - interval '2 hours' where id=${q(lost.exportId)}`)
  const fresh = await kit.as(org.owner, () => exports.requestBooksExport({ exportType: "complete" }))
  const swept = await kit.service(() => exports.failStrandedBooksExports())
  kit.sql(`update public.outbox set status='failed' where org_id=${q(org.orgId)} and payload->>'export_id'=${q(fresh.exportId)}`)

  // A finished archive is never started again (this stack has no storage to finish
  // one, so the fresh export is marked ready to check the rule).
  const freshStatus = status(fresh.exportId).status
  kit.sql(`update public.books_exports set status='ready' where id=${q(fresh.exportId)}`)
  const readyCannotRestart = kit.rows(`select public.start_books_export_attempt(${q(org.orgId)}, ${q(fresh.exportId)}) is null as done`)[0].done === true && status(fresh.exportId).status === "ready"
  check.equal("the archive is one snapshot; a dead attempt is recorded and the next one runs; failures keep their reason and name no file; a lost job fails the export; nothing is left generating", expected.expected, {
    snapshot: { before, captured, after: entries() },
    queued,
    retry: { status: afterRetry.status, attempts: outcomes(afterRetry), storagePath: afterRetry.storage_path, contentHash: afterRetry.content_hash, reasonGiven: Boolean(afterRetry.error_message) },
    lost: { swept: swept >= 1, status: status(lost.exportId).status, message: status(lost.exportId).error_message },
    freshUntouched: freshStatus,
    readyCannotRestart,
  })
  return { orgId: org.orgId }
}

// B15.4: the proof accepts what an ordinary month leaves behind (a bill revised
// after posting, a journal reversed), finds what damage leaves behind (a journal
// altered, a journal lost, a stray entry with no source), and the bookkeeper's
// own tools repair it: reverse the bad entry with its reason, let the projector
// post the source again. Then July closes green, and a restored copy closes
// August.
async function proofRepairAndClose(kit, expected, check) {
  const input = expected.inputs
  const { contractJob } = require("./shared.cjs")
  const wip = require("./wip-01.cjs").helpers
  const job = await contractJob(kit, { name: "RESTORE-01 proof and repair", contractCents: input.contractCents, retainagePercent: 0, periods: ["2026-07", "2026-08"] })
  const { q } = kit
  for (const [label, cents] of Object.entries(input.bills)) await wip.bill(kit, job, "2026-07", cents, label)
  await project(kit, job)
  const billId = (label) => kit.rows(`select id from public.vendor_bills where org_id=${q(job.orgId)} and bill_number=${q(label)}`)[0].id
  const entryOf = (label) => kit.rows(`select id from public.journal_entries where org_id=${q(job.orgId)} and source_id=${q(billId(label))} and status='posted' and reversal_of_entry_id is null order by created_at desc limit 1`)[0].id
  // An ordinary month's history: a bill recoded after it posted, a journal reversed.
  await kit.as(job.owner, () => app("vendor-bills").updateVendorBillStatus({ billId: billId("B"), input: { status: "approved",
    actual_lines: [{ description: "Framing", amount_cents: input.bills.B, cost_code_id: job.costCodeId, project_id: job.projectId, arc_books_gl_account_id: glId(kit, job, "5020") }] } }))
  await kit.drainOutbox(job.orgId)
  await project(kit, job)
  const accrual = await kit.as(job.reviewer, () => app("books/bookkeeping").createAdjustingJournal({ entryDate: "2026-07-15", memo: "Accrued permit fee",
    lines: [{ accountCode: "6900", debitCents: 5000, creditCents: 0 }, { accountCode: "2100", debitCents: 0, creditCents: 5000 }] }))
  await kit.as(job.reviewer, () => app("books/ledger").reverseBooksJournalEntry({ entryId: accrual.id, reversalDate: "2026-07-20", reason: "Permit fee was paid by the owner" }))
  const drill = async () => {
    const run = await kit.service(() => app("books/rebuild").runLedgerRebuildDrillForOrg(job.orgId))
    return { status: run.status, found: [...new Set(run.differences.map((item) => item.type))].sort() }
  }
  const controls = async () => (await kit.service(() => app("books/verifier").runLedgerTieOuts(job.orgId, "2026-07-31")))
    .filter((row) => row.status !== "passed" && row.status !== "not_applicable").map((row) => row.code).sort()
  const ordinary = await drill()

  // Damage written past the guards, as a defect or a bypass would.
  const tampered = entryOf("A"), lost = entryOf("C"), copied = entryOf("B")
  kit.sql(`begin; set local session_replication_role = replica;
update public.journal_lines set debit_cents = debit_cents + case when debit_cents > 0 then ${input.tamperCents} else 0 end, credit_cents = credit_cents + case when credit_cents > 0 then ${input.tamperCents} else 0 end where entry_id = ${q(tampered)};
delete from public.journal_lines where entry_id = ${q(lost)};
delete from public.journal_entries where id = ${q(lost)};
create temp table stray on commit drop as select gen_random_uuid() id;
insert into public.journal_entries select (jsonb_populate_record(null::public.journal_entries, to_jsonb(e) || jsonb_build_object('id', (select id from stray), 'fact_id', null, 'posting_key', 'stray:' || e.id))).* from public.journal_entries e where e.id = ${q(copied)};
insert into public.journal_lines select (jsonb_populate_record(null::public.journal_lines, to_jsonb(l) || jsonb_build_object('id', gen_random_uuid(), 'entry_id', (select id from stray)))).* from public.journal_lines l where l.entry_id = ${q(copied)};
commit;`, "supabase_admin")
  const stray = kit.rows(`select id from public.journal_entries where org_id=${q(job.orgId)} and posting_key=${q(`stray:${copied}`)}`)[0].id
  const damaged = { proof: await drill(), controlsNotPassing: await controls() }

  // The repair: reverse what is wrong with its reason, post the sources again.
  const reverse = (entryId, reason) => kit.as(job.reviewer, () => app("books/ledger").reverseBooksJournalEntry({ entryId, reversalDate: "2026-07-31", reason }))
  await reverse(tampered, "Ledger proof: this entry no longer matched its bill")
  await reverse(stray, "Ledger proof: entry has no source document")
  await project(kit, job)
  const repaired = { proof: await drill(), controlsNotPassing: await controls(),
    jobCost: Number(kit.rows(`select coalesce(sum(l.debit_cents - l.credit_cents),0)::bigint n from public.journal_lines l join public.journal_entries e on e.id=l.entry_id join public.gl_accounts a on a.id=l.account_id
      where l.org_id=${q(job.orgId)} and l.project_id=${q(job.projectId)} and e.status in ('posted','reversed') and a.code in ('5000','5020')`)[0].n) }

  await wip.prepareAndReview(kit, job, "2026-07", { contractCents: input.contractCents, eacCents: input.eacCents })
  const julyClosed = await refusal(() => wip.close(kit, job, "2026-07"))
  restore(kit, job.orgId)
  await wip.bill(kit, job, "2026-08", input.augustBillCents, "AUG-1")
  await project(kit, job)
  await wip.prepareAndReview(kit, job, "2026-08", { contractCents: input.contractCents, eacCents: input.eacCents })
  const augustClosed = await refusal(() => wip.close(kit, job, "2026-08"))
  check.equal("the proof accepts ordinary history, finds the damage, the bookkeeper's tools repair it, July closes green and a restored copy closes August", expected.expected, {
    ordinary, damaged, repaired, julyClosed, augustAfterRestore: { closed: augustClosed, proof: await drill() },
  })
  return { orgId: job.orgId }
}

module.exports = {
  id: "RESTORE-01",
  subcases: {
    "closed-group-and-continuation": closedGroup,
    "tax-records": taxRecords,
    "background-archive": backgroundArchive,
    "proof-repair-and-close": proofRepairAndClose,
  },
}

module.exports.helpers = { restore, tableDigests }
