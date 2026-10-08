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

module.exports = {
  id: "RESTORE-01",
  subcases: {
    "closed-group-and-continuation": closedGroup,
    "tax-records": taxRecords,
  },
}
