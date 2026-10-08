// ENTITY-01 — legal entities on the one ledger (B14.1/B14.2): every posting
// belongs to one company; a payment from one company's bank for another
// company's job records what they owe each other; each company's books balance
// on their own; consolidated, what they owe each other is eliminated; ownership
// is fixed once posted; a reversal keeps each line's company.
const { randomUUID } = require("node:crypto")
const { app, contractJob, project } = require("./shared.cjs")
const { prepareAndReview } = require("./wip-01.cjs").helpers

const LAND_CHECKING = { code: "1005", name: "Land company checking", accountType: "asset", subtype: "cash", normalBalance: "debit" }
const glId = (kit, org, code) => kit.rows(`select id from public.gl_accounts where org_id=${kit.q(org.orgId)} and code=${kit.q(code)}`)[0]?.id ?? null
const today = new Date().toISOString().slice(0, 10)
const refusal = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }

// A builder whose land company owns a separate checking account.
async function twoCompanies(kit, name, input, password) {
  const org = await contractJob(kit, { name, password, contractCents: input.contractCents, retainagePercent: 0, periods: ["2026-07"], accounts: [LAND_CHECKING] })
  const entities = app("books/legal-entities")
  org.land = (await kit.as(org.owner, () => entities.createLegalEntity({ name: "Cedar Ridge Land Co", legalName: "Cedar Ridge Land Company LLC" }))).id
  org.builder = kit.rows(`select id from public.books_legal_entities where org_id=${kit.q(org.orgId)} and is_primary`)[0].id
  await kit.as(org.owner, () => entities.setLegalEntityOwner({ kind: "account", id: glId(kit, org, "1005"), entityId: org.land }))
  const { createManualBankAccount } = app("books/bank-feeds")
  await kit.as(org.owner, () => createManualBankAccount({ name: "Land company checking", accountType: "depository", glAccountId: glId(kit, org, "1005") }))
  return org
}

async function paidBill(kit, org, input) {
  const { createProjectVendorBill, approveVendorBillsAtomic, updateVendorBillStatus } = app("vendor-bills")
  const created = await kit.as(org.owner, () => createProjectVendorBill({ projectId: org.projectId, input: { company_id: org.vendorId, bill_number: "ENT-1", bill_date: input.billDate, due_date: input.billDate, total_cents: input.billCents,
    actual_lines: [{ cost_code_id: org.costCodeId, description: "Framing", amount_cents: input.billCents, project_id: org.projectId }] } }))
  await kit.as(org.owner, () => approveVendorBillsAtomic([{ id: created.id }]))
  await kit.as(org.owner, () => updateVendorBillStatus({ billId: created.id, input: { status: "paid", payment_amount_cents: input.billCents, payment_method: "check", check_number: "1001",
    payment_date: input.paidDate, books_payment_account_id: glId(kit, org, "1005"), payment_idempotency_key: `ent-pay-${org.orgId}` } }))
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  return created.id
}

// Trial balance rows (code → balance) and the proof, for one company or consolidated.
async function trialBalance(kit, org, entityId, asOf = "2026-07-31") {
  const statements = app("books/statements")
  const report = await kit.service(async () => statements.buildTrialBalance(org.orgId, asOf, await statements.ledgerForCompany(org.orgId, await statements.loadLedgerBalances(org.orgId, asOf), entityId)))
  return {
    balanced: report.totalDebitCents === report.totalCreditCents,
    accounts: Object.fromEntries(report.rows.filter((row) => row.balanceCents !== 0).map((row) => [row.code, row.balanceCents]).sort(([a], [b]) => a.localeCompare(b))),
  }
}

// A bill on the builder's job paid from the land company's bank: each company
// carries its side, what they owe each other, and balances on its own.
async function paymentAcrossCompanies(kit, expected, check) {
  const input = expected.inputs
  const org = await twoCompanies(kit, "ENTITY-01 payment across companies", input)
  await paidBill(kit, org, input)
  const payment = kit.rows(`select e.id from public.journal_entries e join public.payments p on p.id=e.source_id where e.org_id=${kit.q(org.orgId)} and p.bill_id is not null and e.status='posted'`)[0].id
  const lines = kit.rows(`select a.code, case when l.legal_entity_id=${kit.q(org.land)} then 'land' else 'builder' end company, l.debit_cents::bigint d, l.credit_cents::bigint c,
    case when l.dimensions->>'counterparty_entity_id'=${kit.q(org.land)} then 'land' when l.dimensions->>'counterparty_entity_id'=${kit.q(org.builder)} then 'builder' end counterparty
    from public.journal_lines l join public.gl_accounts a on a.id=l.account_id where l.entry_id=${kit.q(payment)} order by l.line_no`)
  check.equal("the payment's lines sit with their companies, with what each owes the other", expected.expected, {
    paymentLines: lines.map((row) => ({ code: row.code, company: row.company, debit: Number(row.d), credit: Number(row.c), counterparty: row.counterparty ?? null })),
    builder: await trialBalance(kit, org, org.builder),
    land: await trialBalance(kit, org, org.land),
    consolidated: await trialBalance(kit, org, null),
    // Each company files its own 1099s: the land company paid the framing sub.
    vendor1099: await (async () => {
      kit.sql(`update public.companies set is_1099_eligible=true where id=${kit.q(org.vendorId)}`)
      const paid = async (legalEntityId) => (await kit.as(org.owner, () => app("reports/vendor-1099").getVendor1099Report({ year: 2026, legalEntityId }))).rows.find((row) => row.company_id === org.vendorId)?.total_paid_cents ?? 0
      return { land: await paid(org.land), builder: await paid(org.builder) }
    })(),
  })
  return { orgId: org.orgId, land: org.land, builder: org.builder }
}

// Once something has posted, its company is fixed; a voided payment's reversal
// keeps each line with the company it came from.
async function ownershipFixedAndReversal(kit, expected, check) {
  const input = expected.inputs
  const org = await twoCompanies(kit, "ENTITY-01 ownership and reversal", input)
  const billId = await paidBill(kit, org, input)
  const entities = app("books/legal-entities")
  const projectMove = await refusal(() => kit.as(org.owner, () => entities.setLegalEntityOwner({ kind: "project", id: org.projectId, entityId: org.land })))
  const accountMove = await refusal(() => kit.as(org.owner, () => entities.setLegalEntityOwner({ kind: "account", id: glId(kit, org, "1005"), entityId: null })))
  const paymentId = kit.rows(`select id from public.payments where org_id=${kit.q(org.orgId)} and bill_id=${kit.q(billId)}`)[0].id
  await kit.as(org.owner, () => app("vendor-bills").reverseManualBillPayment({ paymentId, reason: "Check 1001 voided", idempotencyKey: `ent-void-${org.orgId}` }))
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  const reversal = kit.rows(`select id from public.journal_entries where org_id=${kit.q(org.orgId)} and source_type='payment_reversal' and status='posted' order by created_at desc limit 1`)[0]?.id
  const reversalCompanies = kit.rows(`select a.code, case when l.legal_entity_id=${kit.q(org.land)} then 'land' else 'builder' end company from public.journal_lines l join public.gl_accounts a on a.id=l.account_id where l.entry_id=${kit.q(reversal)} order by a.code`)
  check.equal("posted ownership cannot move, and the reversal keeps each line's company", expected.expected, {
    projectMove: /already has postings/.test(projectMove) ? "refused: already has postings" : projectMove,
    accountMove: /already has postings/.test(accountMove) ? "refused: already has postings" : accountMove,
    reversalCompanies: Object.fromEntries(reversalCompanies.map((row) => [row.code, row.company])),
    // The void is dated when it is recorded, so the books are read as of today.
    builder: await trialBalance(kit, org, org.builder, today),
    land: await trialBalance(kit, org, org.land, today),
  })
  return { orgId: org.orgId }
}

// A single-company builder sees no change: no intercompany accounts, one company.
async function singleCompanyUnchanged(kit, expected, check) {
  const input = expected.inputs
  const org = await contractJob(kit, { name: "ENTITY-01 single company", contractCents: input.contractCents, retainagePercent: 0, periods: ["2026-07"] })
  const { createProjectVendorBill, approveVendorBillsAtomic } = app("vendor-bills")
  const created = await kit.as(org.owner, () => createProjectVendorBill({ projectId: org.projectId, input: { company_id: org.vendorId, bill_number: "ONE-1", bill_date: input.billDate, due_date: input.billDate, total_cents: input.billCents,
    actual_lines: [{ cost_code_id: org.costCodeId, description: "Framing", amount_cents: input.billCents, project_id: org.projectId }] } }))
  await kit.as(org.owner, () => approveVendorBillsAtomic([{ id: created.id }]))
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  const choices = await kit.as(org.owner, () => app("books/legal-entities").listLegalEntityChoices())
  const consolidated = await trialBalance(kit, org, null)
  check.equal("one company, every line on it, no intercompany accounts", expected.expected, {
    companies: choices.length,
    linesOffPrimary: Number(kit.rows(`select count(*)::int n from public.journal_lines l join public.books_legal_entities e on e.id=l.legal_entity_id where l.org_id=${kit.q(org.orgId)} and not e.is_primary`)[0].n),
    intercompanyAccounts: [glId(kit, org, "1180"), glId(kit, org, "2180")].filter(Boolean).length,
    sameAsCompany: JSON.stringify(consolidated) === JSON.stringify(await trialBalance(kit, org, choices[0].id)),
  })
  return { orgId: org.orgId }
}

// Each company's receivables and payables tie to its own ledger, and a closed
// month keeps each company's statements as they were closed.
async function companySubledgersAndClose(kit, expected, check) {
  const input = expected.inputs
  const org = await twoCompanies(kit, "ENTITY-01 subledgers and close", input)
  const { q } = kit
  const landJob = randomUUID()
  kit.sql(`begin;
insert into public.projects(id,org_id,name,property_type,created_by,legal_entity_id) values(${q(landJob)},${q(org.orgId)},'Cedar Ridge lot sales','production',${q(org.owner.userId)},${q(org.land)});
insert into public.project_financial_settings(org_id,project_id) values(${q(org.orgId)},${q(landJob)}) on conflict do nothing;
insert into public.contracts(id,org_id,project_id,title,status,total_cents,currency,contract_type,retainage_percent,effective_date) values(${q(randomUUID())},${q(org.orgId)},${q(landJob)},'Lot sale','active',${input.landInvoiceCents},'usd','purchase_agreement',0,'2026-07-01');
commit;`)
  const invoice = (projectId, number, cents) => kit.sql(`select public.create_invoice_atomic(${q(org.orgId)},jsonb_build_object('project_id',${q(projectId)},'invoice_number',${q(number)},
  'title','Billing','issue_date','2026-07-20','due_date','2026-07-30','client_visible',true,'approval_status','approved','product_posture','residential','subtotal_cents',${cents},'tax_cents',0,'total_cents',${cents},'balance_due_cents',${cents},'token',${q(randomUUID())},'metadata','{}'::jsonb),
  jsonb_build_array(jsonb_build_object('description','Work','quantity',1,'unit_price_cents',${cents},'amount_cents',${cents})));`)
  invoice(org.projectId, "B-1", input.builderInvoiceCents)
  invoice(landJob, "L-1", input.landInvoiceCents)
  const { createProjectVendorBill, approveVendorBillsAtomic } = app("vendor-bills")
  for (const [projectId, cents, number] of [[org.projectId, input.builderBillCents, "BB-1"], [landJob, input.landBillCents, "LB-1"]]) {
    const created = await kit.as(org.owner, () => createProjectVendorBill({ projectId, input: { company_id: org.vendorId, bill_number: number, bill_date: "2026-07-12", due_date: "2026-08-12", total_cents: cents,
      actual_lines: [{ cost_code_id: org.costCodeId, description: "Work", amount_cents: cents, project_id: projectId }] } }))
    await kit.as(org.owner, () => approveVendorBillsAtomic([{ id: created.id }]))
  }
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  const aging = async (legalEntityId) => {
    const [ar, ap] = await Promise.all([
      kit.as(org.owner, () => app("reports/ar-aging").getArAgingReport({ asOf: "2026-07-31", legalEntityId })),
      kit.as(org.owner, () => app("reports/ap-aging").getApAgingReport({ asOf: "2026-07-31", legalEntityId })),
    ])
    return { receivable: ar.totals.total_open_cents, payable: ap.totals.total_open_cents, readAsClosed: Boolean(ar.as_closed) }
  }
  const tie = async (legalEntityId) => {
    const books = await trialBalance(kit, org, legalEntityId)
    const sub = await aging(legalEntityId)
    return { receivable: sub.receivable, ledgerReceivable: books.accounts["1100"] ?? 0, payable: sub.payable, ledgerPayable: books.accounts["2000"] ?? 0 }
  }
  const before = { builder: await tie(org.builder), land: await tie(org.land) }
  await prepareAndReview(kit, org, "2026-07", { contractCents: input.contractCents, eacCents: input.eacCents })
  // The land company's checking had no activity; its July statement still reconciles.
  const { createBankReconciliation, closeBankReconciliation } = app("books/bank-reconciliation")
  const bankId = kit.rows(`select id from public.bank_accounts where org_id=${q(org.orgId)} and gl_account_id=${q(glId(kit, org, "1005"))}`)[0].id
  const reconciliation = await kit.as(org.owner, () => createBankReconciliation({ bankAccountId: bankId, statementStart: "2026-07-01", statementEnd: "2026-07-31", beginningBalanceCents: 0, endingBalanceCents: 0 }))
  await kit.as(org.owner, () => closeBankReconciliation(reconciliation))
  await kit.as(org.owner, () => app("books/period-close").closeAccountingPeriod(org.periods["2026-07"].periodId))
  const saved = Object.fromEntries(kit.rows(`select case when legal_entity_id=${q(org.land)} then 'land' when legal_entity_id is null then 'consolidated' else 'builder' end company, count(*)::int n
    from public.financial_statement_snapshots where period_id=${q(org.periods["2026-07"].periodId)} group by 1 order by 1`).map((row) => [row.company, Number(row.n)]))
  const closedLand = await kit.as(org.owner, () => app("books/statement-detail").getStatementsForPeriod({ startDate: "2026-07-01", endDate: "2026-07-31", comparison: "none", legalEntityId: org.land }))
  check.equal("each company's aging ties to its own ledger, and its statements are kept as closed", expected.expected, {
    before,
    savedAtClose: saved,
    landReadsAsClosed: Boolean(closedLand.closedPeriod),
    landNetIncome: closedLand.profitLoss.netIncomeCents,
    landAgingAfterClose: await aging(org.land),
  })
  return { orgId: org.orgId, landJob }
}

// A land company sells a lot to the building company's home. Each company books
// its side; consolidated, the lot stays at the land company's cost and the land
// company's profit is held back until the home sells to an outside buyer, so the
// group earns exactly what the two companies earned together.
async function intercompanyLotSale(kit, expected, check) {
  const input = expected.inputs
  const home = require("./home-01.cjs").helpers
  const org = await home.builder(kit, "ENTITY-01 intercompany lot sale", [{ name: "Lot 9 — Aspen plan", priceCents: input.outsidePriceCents }])
  const lot = org.homes[0]
  const entities = app("books/legal-entities")
  org.land = (await kit.as(org.owner, () => entities.createLegalEntity({ name: "Cedar Ridge Land Co", legalName: null }))).id
  org.builderEntity = kit.rows(`select id from public.books_legal_entities where org_id=${kit.q(org.orgId)} and is_primary`)[0].id
  await kit.as(org.owner, () => app("books/chart-management").createGlAccount(LAND_CHECKING))
  for (const code of ["1005", "1120"]) await kit.as(org.owner, () => entities.setLegalEntityOwner({ kind: "account", id: glId(kit, org, code), entityId: org.land }))
  const inventory = app("books/inventory")
  await kit.as(org.owner, () => inventory.enableProjectInventory({ projectId: lot.projectId, effectiveOn: "2026-06-01", evidenceUrl: "https://evidence.acceptance.example.test/entity-01/ownership" }))
  await kit.as(org.owner, () => inventory.acquireLandInventory({ date: "2026-06-02", allocations: [{ lotId: lot.lotId, amountCents: input.landCostCents }], cashAccountId: glId(kit, org, "1005"), cashCents: input.landCostCents, debtInstrumentId: null, debtCents: 0, reference: "Lot 9 settlement", evidenceUrl: "https://evidence.acceptance.example.test/entity-01/land" }))
  kit.sql(`update public.lots set project_id=${kit.q(lot.projectId)} where id=${kit.q(lot.lotId)}`)
  const sameCompany = await refusal(() => kit.as(org.owner, () => entities.sellLotToAffiliate({ projectId: lot.projectId, date: "2026-06-03", priceCents: 0, evidenceUrl: "https://evidence.acceptance.example.test/entity-01/sale" })))
  await kit.as(org.owner, () => entities.sellLotToAffiliate({ projectId: lot.projectId, date: "2026-06-03", priceCents: input.lotPriceCents, evidenceUrl: "https://evidence.acceptance.example.test/entity-01/sale" }))
  await home.bill(kit, org, lot.projectId, "2026-06-10", input.constructionCents)
  await kit.as(org.owner, () => inventory.completeProjectInventory({ projectId: lot.projectId, date: "2026-07-01", evidenceUrl: "https://evidence.acceptance.example.test/entity-01/completion" }))
  const beforeSale = { land: await trialBalance(kit, org, org.land, "2026-07-31"), builder: await trialBalance(kit, org, org.builderEntity, "2026-07-31"), consolidated: await trialBalance(kit, org, null, "2026-07-31") }
  await home.settle(kit, org, lot, "2026-08-10")
  const statements = app("books/statements")
  const profit = async (entityId) => (await kit.service(async () => statements.buildProfitAndLoss(org.orgId, "2026-06-01", "2026-08-31", await statements.ledgerForCompany(org.orgId, await statements.loadPostedLedger(org.orgId, "2026-08-31"), entityId)))).netIncomeCents
  const reconciliation = await kit.as(org.owner, () => entities.getIntercompanyReconciliation("2026-08-31"))
  const net = { land: await profit(org.land), builder: await profit(org.builderEntity), consolidated: await profit(null) }
  check.equal("each company books its side of the lot sale, and the group earns only what was earned outside", expected.expected, {
    priceRequired: /price/.test(sameCompany) ? "refused: a sale price is required" : sameCompany,
    beforeSale,
    netIncome: net,
    groupEqualsCompanies: net.consolidated === net.land + net.builder,
    reconciliation: { pairs: reconciliation.pairs.map((pair) => ({ ties: pair.ties, owed: Math.abs(pair.aOwedByB) })), sales: reconciliation.sales.map((sale) => ({ profit: sale.profitCents, realized: sale.realized })) },
    intercompanyControl: (await kit.service(() => app("books/verifier").runLedgerTieOuts(org.orgId, "2026-08-31"))).find((row) => row.code === "intercompany_control")?.status,
  })
  return { orgId: org.orgId }
}

// Each company brings its own opening position at cutover; a batch whose lines
// belong to more than one company is refused rather than inventing what they owe
// each other.
async function companyOpenings(kit, expected, check) {
  const input = expected.inputs
  const { greenfieldOrg } = require("./shared.cjs")
  const balances = app("books/opening-balances")
  const post = async (org, lines, legalEntityId, name) => {
    const batch = await kit.as(org.owner, () => balances.createOpeningBalanceBatch({ cutoverDate: "2026-06-30", sourceFilename: `${name}.csv`, sourceContent: JSON.stringify(lines), lines, legalEntityId }))
    await kit.as(org.owner, () => balances.approveOpeningBalanceBatch({ batchId: batch.batchId, approvalRole: "owner" }))
    await kit.as(org.reviewer, () => balances.approveOpeningBalanceBatch({ batchId: batch.batchId, approvalRole: "accountant" }))
    return kit.as(org.owner, () => balances.postOpeningBalanceBatch(batch.batchId))
  }
  const position = (cents) => [
    { accountCode: "1200", description: "Prepaid insurance", debitCents: cents, creditCents: 0 },
    { accountCode: "3000", description: "Owner equity", debitCents: 0, creditCents: cents },
  ]
  let mixed
  const org = await greenfieldOrg(kit, { name: "ENTITY-01 company openings", periods: ["2026-07"],
    setup: (org) => {
      org.projectId = randomUUID()
      kit.sql(`insert into public.projects(id,org_id,name,property_type,created_by) values(${kit.q(org.projectId)},${kit.q(org.orgId)},'Builder job','residential',${kit.q(org.owner.userId)});`)
    },
    beforeOpening: async (org) => {
      org.land = (await kit.as(org.owner, () => app("books/legal-entities").createLegalEntity({ name: "Cedar Ridge Land Co", legalName: null }))).id
      await post(org, position(input.landOpeningCents), org.land, "land-opening")
      mixed = await refusal(() => post(org, [
        { accountCode: "1200", description: "Prepaid on the builder's job", projectId: org.projectId, debitCents: input.mixedCents, creditCents: 0 },
        { accountCode: "3000", description: "Owner equity", debitCents: 0, creditCents: input.mixedCents },
      ], org.land, "mixed-opening"))
    },
    opening: () => position(input.builderOpeningCents),
  })
  const builder = kit.rows(`select id from public.books_legal_entities where org_id=${kit.q(org.orgId)} and is_primary`)[0].id
  check.equal("each company opens with its own position, and a batch spanning companies is refused", expected.expected, {
    mixed: /more than one company/.test(mixed) ? "refused: lines belong to more than one company" : mixed,
    land: await trialBalance(kit, org, org.land, "2026-06-30"),
    builder: await trialBalance(kit, org, builder, "2026-06-30"),
    consolidated: await trialBalance(kit, org, null, "2026-06-30"),
  })
  return { orgId: org.orgId }
}

// The export alone rebuilds a multi-company organization: every exported row is
// removed and reinserted from the snapshot (in a transaction that is rolled
// back), each company's balances and what they owe each other come back exactly,
// and a new cross-company posting and the ownership guard work on the restored data.
async function archiveRoundTrip(kit, expected, check) {
  const input = expected.inputs
  const org = await twoCompanies(kit, "ENTITY-01 archive round trip", input)
  await paidBill(kit, org, input)
  const { q } = kit
  const tables = app("books/export-contract").EXPORT_TABLES
  const balancesSql = `select coalesce(jsonb_agg(jsonb_build_array(legal_entity_id, account_id, n) order by legal_entity_id, account_id), '[]'::jsonb) from (select legal_entity_id, account_id, sum(debit_cents - credit_cents) n from public.journal_lines where org_id = ${q(org.orgId)} group by 1, 2) b`
  const result = JSON.parse(kit.sql(`begin;
create temp table snap on commit drop as select public.capture_books_export_snapshot(${q(org.orgId)}) s;
create temp table before_state on commit drop as select (${balancesSql}) balances, public.books_intercompany_positions(${q(org.orgId)}, '2099-12-31') positions;
set local session_replication_role = replica;
do $$
declare t text; cols text; rows jsonb;
begin
  foreach t in array array[${tables.map((t) => q(t)).join(",")}] loop
    select string_agg(quote_ident(column_name), ',' order by ordinal_position) into cols from information_schema.columns
      where table_schema = 'public' and table_name = t and is_generated = 'NEVER';
    select s -> 'tables' -> t into rows from snap;
    -- As the restore plan does: a feed connection comes back disconnected, without its credential.
    if t = 'bank_feed_connections' then
      select coalesce(jsonb_agg(r || jsonb_build_object('secret_ref', 'restore-disconnected:' || (r->>'id'), 'status', 'disconnected', 'disconnected_at', coalesce(r->>'disconnected_at', r->>'updated_at'))), '[]'::jsonb)
        into rows from jsonb_array_elements(coalesce(rows, '[]'::jsonb)) r;
    end if;
    execute format('delete from public.%I where org_id = %L', t, ${q(org.orgId)});
    execute format('insert into public.%I (%s) overriding system value select %s from jsonb_populate_recordset(null::public.%I, $1)', t, cols, cols, t) using coalesce(rows, '[]'::jsonb);
  end loop;
end $$;
set local session_replication_role = origin;
create temp table after_state on commit drop as select (${balancesSql}) balances, public.books_intercompany_positions(${q(org.orgId)}, '2099-12-31') positions;
create temp table probe on commit drop as select public.post_books_journal_entry(${q(org.orgId)},
  jsonb_build_object('entry_date','2026-07-20','entry_kind','adjusting','memo','Land company pays a builder cost after restore','posting_key',${q(`round-trip-${org.orgId}`)},'policy_version',1),
  jsonb_build_array(
    jsonb_build_object('line_no',1,'account_id',(select id from public.gl_accounts where org_id=${q(org.orgId)} and code='5000'),'project_id',${q(org.projectId)},'debit_cents',${input.probeCents},'credit_cents',0),
    jsonb_build_object('line_no',2,'account_id',(select id from public.gl_accounts where org_id=${q(org.orgId)} and code='1005'),'debit_cents',0,'credit_cents',${input.probeCents}))) id;
create temp table guard on commit drop as select 'allowed'::text outcome;
do $$ begin
  update public.projects set legal_entity_id = ${q(org.land)} where id = ${q(org.projectId)};
exception when others then update guard set outcome = 'refused: ' || sqlerrm; end $$;
select json_build_object(
  'balancesRestored', (select balances from before_state) = (select balances from after_state),
  'positionsRestored', (select positions from before_state) = (select positions from after_state),
  'probeLegs', (select count(*) from public.journal_lines where entry_id = (select id from probe) and dimensions->>'intercompany' = 'true'),
  'positionsAfterProbe', public.books_intercompany_positions(${q(org.orgId)}, '2099-12-31'),
  'guard', (select outcome from guard));
rollback;`).split("\n").filter(Boolean).at(-1))
  const owed = (rows) => Object.fromEntries(rows.map((row) => [row.entityId === org.land ? "land" : "builder", { dueFrom: Number(row.dueFromCents), dueTo: Number(row.dueToCents) }]).sort(([a], [b]) => a.localeCompare(b)))
  check.equal("the export alone rebuilds each company's books, and posting and guards work on the restored data", expected.expected, {
    bundleVerifies: (({ valid, integrityErrors }) => valid || integrityErrors.slice(0, 3).join("; "))(app("books/export-contract").verifyBooksExportBundle(await exportBundle(kit, org))),
    balancesRestored: result.balancesRestored,
    positionsRestored: result.positionsRestored,
    probeLegs: Number(result.probeLegs),
    positionsAfterProbe: owed(result.positionsAfterProbe),
    guard: /already has postings/.test(result.guard) ? "refused: already has postings" : result.guard,
  })
  return { orgId: org.orgId }
}

// The bundle an export would write, from the same snapshot.
async function exportBundle(kit, org) {
  const { BOOKS_EXPORT_SCHEMA_VERSION, EXPORT_TABLES } = app("books/export-contract")
  const { booksDigest } = require("../../../lib/services/books/hash")
  const snapshot = JSON.parse(kit.sql(`select public.capture_books_export_snapshot(${kit.q(org.orgId)});`))
  const tables = Object.fromEntries(EXPORT_TABLES.map((table) => [table, snapshot.tables[table] ?? []]))
  const { historicalDocumentInventory } = app("books/tax-attachment-archive")
  return { tables, manifest: { schemaVersion: BOOKS_EXPORT_SCHEMA_VERSION, orgId: org.orgId, tables: Object.fromEntries(Object.entries(tables).map(([name, rows]) => [name, { rows: rows.length, checksum: booksDigest(rows) }])),
    supportingFiles: [], supportingHistoricalFiles: historicalDocumentInventory(tables, org.orgId) } }
}

// Another organization's company ids are refused or see nothing, everywhere a
// company id is taken.
async function foreignCompanyRefused(kit, expected, check) {
  const input = expected.inputs
  const owner = await twoCompanies(kit, "ENTITY-01 company owner", input)
  const other = await contractJob(kit, { name: "ENTITY-01 other organization", contractCents: input.contractCents, retainagePercent: 0, periods: ["2026-07"] })
  const entities = app("books/legal-entities")
  const foreign = owner.land
  const moved = await refusal(() => kit.as(other.owner, () => entities.setLegalEntityOwner({ kind: "project", id: other.projectId, entityId: foreign })))
  const opening = await refusal(() => kit.as(other.owner, () => app("books/opening-balances").createOpeningBalanceBatch({ cutoverDate: "2026-06-30", sourceContent: "[]", legalEntityId: foreign,
    lines: [{ accountCode: "1200", description: "Prepaid", debitCents: 100, creditCents: 0 }, { accountCode: "3000", description: "Equity", debitCents: 0, creditCents: 100 }] })))
  const posted = await refusal(async () => kit.sql(`select public.post_books_journal_entry(${kit.q(other.orgId)}, jsonb_build_object('entry_date','2026-07-05','entry_kind','adjusting','memo','Foreign company','posting_key',${kit.q(`foreign-${other.orgId}`)},'policy_version',1),
    jsonb_build_array(jsonb_build_object('line_no',1,'account_id',(select id from public.gl_accounts where org_id=${kit.q(other.orgId)} and code='1200'),'debit_cents',100,'credit_cents',0,'legal_entity_id',${kit.q(foreign)}),
      jsonb_build_object('line_no',2,'account_id',(select id from public.gl_accounts where org_id=${kit.q(other.orgId)} and code='3000'),'debit_cents',0,'credit_cents',100)));`))
  const statement = await trialBalance(kit, other, foreign)
  check.equal("another organization's company is refused or shows nothing", expected.expected, {
    moved: /Company not found/.test(moved) ? "refused: company not found" : moved,
    opening: /Company not found/.test(opening) ? "refused: company not found" : opening,
    posted: /legal_entity_fkey|violates foreign key/.test(posted) ? "refused: not this organization's company" : posted,
    statementAccounts: Object.keys(statement.accounts).length,
  })
  return { orgId: other.orgId }
}

module.exports = {
  subcases: {
    "payment-across-companies": paymentAcrossCompanies,
    "ownership-fixed-and-reversal": ownershipFixedAndReversal,
    "single-company-unchanged": singleCompanyUnchanged,
    "company-subledgers-and-close": companySubledgersAndClose,
    "intercompany-lot-sale": intercompanyLotSale,
    "company-openings": companyOpenings,
    "archive-round-trip": archiveRoundTrip,
    "foreign-company-refused": foreignCompanyRefused,
  },
}
module.exports.helpers = { twoCompanies, paidBill }
