// WARR-01 installed base and warranty money (EP11-01, EP11-07):
//
//   import-keeps-close-dates-and-terms          homes that closed before Arc come in with their actual closing date and the
//                                               terms they were sold with, and no invoice, journal or outbox job
//   reimport-never-double-enrolls               a second import matches every home; a conflicting date is refused; a home whose
//                                               enrollment died part-way is repaired, not duplicated
//   reconciliation-finds-gaps-and-duplicates    the report names a home with no coverage, one covered twice and one whose
//                                               dates disagree with closing plus term, and is clean for a clean import
//   warranty-money-reconciles-and-reversal-is-idempotent
//                                               reserve, approved cost, vendor credit and recovery tie to accepted work;
//                                               reversing and repeating change nothing twice
//
// Expected values are hand-derived in expected/WARR-01.json. SQL writes only fixtures no service creates here (a community,
// a second program, a half-finished enrollment, the data a faulty import would leave) and reads the outcome.
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const { app, project } = require("./shared.cjs")

const home01 = () => require("./home-01.cjs").helpers
const EVIDENCE = "https://evidence.acceptance.example.test/warr-01"
const HEADERS = ["community", "lot_number", "block", "address", "buyer_name", "buyer_email", "closing_date", "program", "workmanship_months", "systems_months", "structural_months"]
const refusal = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }

function homeRow(inputs, lot) {
  return { community: inputs.community, lot_number: lot.lot, block: "", address: `${lot.lot} Maple Ridge Dr`, buyer_name: lot.buyer, buyer_email: `buyer${lot.lot.toLowerCase().replace(/[^a-z0-9]/g, "")}@acceptance.example.test`, closing_date: lot.closed, program: lot.program ?? "", workmanship_months: lot.workmanship ?? "", systems_months: lot.systems ?? "", structural_months: lot.structural ?? "" }
}
const fileOf = (inputs, lots) => seed.csv(HEADERS, lots.map((lot) => homeRow(inputs, lot)))

/** A production builder with Maple Ridge and a second program, "Premier", that a row can name. */
async function installedOrg(kit, inputs, name) {
  const org = await seed.productionBuilder(kit, { name, periods: ["2026-06", "2026-07"] })
  const premier = randomUUID(), q = kit.q
  await kit.service(() => app("warranty-operations").ensureWarrantyDefaults(org.orgId))
  org.communityId = randomUUID()
  kit.sql(`begin;
insert into public.communities(id,org_id,name,time_zone) values(${q(org.communityId)},${q(org.orgId)},${q(inputs.community)},'America/Chicago');
insert into public.warranty_programs(id,org_id,name,is_default,is_active) values(${q(premier)},${q(org.orgId)},'Premier',false,true);
insert into public.warranty_coverage_terms(org_id,program_id,key,label,duration_months,is_structural,sort_order) values
  (${q(org.orgId)},${q(premier)},'workmanship','Workmanship & materials',24,false,0),
  (${q(org.orgId)},${q(premier)},'systems','Major systems',36,false,1),
  (${q(org.orgId)},${q(premier)},'structural','Structural',180,true,2);
commit;`)
  return org
}

const stage = (kit, org, csvText) => kit.as(org.team.warranty, () => app("imports").stageImportBatch({ importer: "warranty_homes", csvText, sourceFilename: "installed-homes.csv" }, { expectedImporter: "warranty_homes" }))
const commit = (kit, org, batchId) => kit.as(org.team.warranty, () => app("imports").commitImportBatch(batchId, { expectedImporter: "warranty_homes" }))
const rowIssues = (kit, batchId) => kit.rows(`select r.parsed->>'lot_number' lot, r.status, r.issues from public.import_rows r where r.batch_id=${kit.q(batchId)} order by r.row_number`)
  .map((row) => [row.lot, row.status, row.issues.map((issue) => issue.code)])

/** Each closed home with the coverage it has, in lot order. */
function homes(kit, org) {
  return kit.rows(`select l.lot_number, c.actual_date::text closed, p.status project_status, l.status lot_status, w.effective_date::text effective, w.effective_source source, pr.name program, w.terms_snapshot terms
    from public.lots l join public.projects p on p.id=l.project_id join public.closings c on c.project_id=p.id and c.status='closed'
    left join public.project_warranty_coverage w on w.project_id=p.id and w.voided_at is null left join public.warranty_programs pr on pr.id=w.program_id
    where l.org_id=${kit.q(org.orgId)} order by l.lot_number::int, p.created_at`)
    .map((row) => ({ lot: row.lot_number, closed: row.closed, project: row.project_status, lotStatus: row.lot_status, effective: row.effective, source: row.source, program: row.program,
      terms: row.terms ? row.terms.map((term) => [term.key, term.duration_months, term.expires_on]) : null }))
}

/** What booking a sale would have produced: none of it exists for a home that closed before Arc. */
function sideEffects(kit, org) {
  const count = (sql) => Number(kit.rows(sql)[0].n)
  const id = kit.q(org.orgId)
  return {
    invoices: count(`select count(*) n from public.invoices where org_id=${id}`),
    journalEntries: count(`select count(*) n from public.journal_entries where org_id=${id} and (source_type like 'warranty%' or source_type like 'inventory%' or source_type like 'home%')`),
    outboxJobs: count(`select count(*) n from public.outbox where org_id=${id} and job_type in ('warranty_enroll_coverage','closing_posting')`),
    reserves: count(`select count(*) n from public.project_financial_settings where org_id=${id} and books_warranty_provisioned_on is not null`),
  }
}

async function importKeepsCloseDatesAndTerms(kit, spec, check) {
  const { inputs, expected } = spec
  const org = await installedOrg(kit, inputs, "WARR-01 installed homes")
  const batch = await stage(kit, org, fileOf(inputs, inputs.lots))
  const stagedRows = rowIssues(kit, batch.id)
  const refused = await refusal(() => kit.as(org.team.sales, () => app("imports").stageImportBatch({ importer: "warranty_homes", csvText: fileOf(inputs, inputs.lots), sourceFilename: "x.csv" })))
  const committed = await commit(kit, org, batch.id)
  const reconciliation = committed.report.reconciliation
  check.equal("each closed home keeps its actual closing date and the terms it was sold with, and booking no sale", expected, {
    stagedRows,
    stagingByASalesAgent: refused === "allowed" ? "allowed" : "refused",
    homes: homes(kit, org),
    sideEffects: sideEffects(kit, org),
    committed: { actions: committed.report.actions, reconciliation: { homes: reconciliation.homes, covered: reconciliation.covered, active: reconciliation.active, expired: reconciliation.expired, exceptions: reconciliation.exception_count } },
    buyers: kit.rows(`select count(*)::int n from public.contacts where org_id=${kit.q(org.orgId)} and email like 'buyer%@acceptance.example.test'`)[0].n,
  })
  return { orgId: org.orgId, batchId: batch.id }
}

async function reimportNeverDoubleEnrolls(kit, spec, check) {
  const { inputs, expected } = spec
  const org = await installedOrg(kit, inputs, "WARR-01 reimport")
  const first = await stage(kit, org, fileOf(inputs, inputs.lots))
  await commit(kit, org, first.id)
  const counts = () => ({
    projects: Number(kit.rows(`select count(*) n from public.projects where org_id=${kit.q(org.orgId)} and metadata->>'installed_home_import'='true'`)[0].n),
    closings: Number(kit.rows(`select count(*) n from public.closings where org_id=${kit.q(org.orgId)}`)[0].n),
    lots: Number(kit.rows(`select count(*) n from public.lots where org_id=${kit.q(org.orgId)}`)[0].n),
    coverages: Number(kit.rows(`select count(*) n from public.project_warranty_coverage where org_id=${kit.q(org.orgId)} and voided_at is null`)[0].n),
    buyers: Number(kit.rows(`select count(*) n from public.contacts where org_id=${kit.q(org.orgId)} and email like 'buyer%@acceptance.example.test'`)[0].n),
    enrollmentEvents: Number(kit.rows(`select count(*) n from public.events where org_id=${kit.q(org.orgId)} and event_type='warranty_coverage_enrolled'`)[0].n),
  })
  const afterFirst = counts()
  const again = await stage(kit, org, fileOf(inputs, inputs.lots))
  const againRows = rowIssues(kit, again.id)
  const second = await commit(kit, org, again.id)
  const afterSecond = counts()
  // A different closing date for a home Arc already holds is a conflict, never a second enrollment.
  const conflict = await stage(kit, org, fileOf(inputs, [{ ...inputs.lots[0], closed: inputs.conflictingClosing }]))
  const conflictRows = rowIssues(kit, conflict.id)
  const conflictCommit = await refusal(() => commit(kit, org, conflict.id))
  // An enrollment that died after the home was recorded leaves a closed home with no coverage; a re-import repairs it.
  const crashed = inputs.lots[inputs.lots.length - 1]
  kit.sql(`begin;
delete from public.events where org_id=${kit.q(org.orgId)} and event_type='warranty_coverage_enrolled' and entity_id in (select id from public.project_warranty_coverage where project_id in (select project_id from public.lots where org_id=${kit.q(org.orgId)} and lot_number=${kit.q(crashed.lot)}));
delete from public.project_warranty_coverage where project_id in (select project_id from public.lots where org_id=${kit.q(org.orgId)} and lot_number=${kit.q(crashed.lot)});
commit;`)
  const uncovered = counts().coverages
  const repair = await stage(kit, org, fileOf(inputs, inputs.lots))
  const repairRows = rowIssues(kit, repair.id)
  const repaired = await commit(kit, org, repair.id)
  // A lot written with other case or spacing is the same lot: it matches the existing home.
  const caseFirst = await stage(kit, org, fileOf(inputs, [inputs.caseLot]))
  await commit(kit, org, caseFirst.id)
  const afterCaseLot = counts()
  const caseAgain = await stage(kit, org, fileOf(inputs, [{ ...inputs.caseLot, lot: inputs.caseVariant }]))
  const caseRows = rowIssues(kit, caseAgain.id)
  const caseCommit = await commit(kit, org, caseAgain.id)
  check.equal("a re-import matches every home, refuses a conflicting date, and repairs an unenrolled home once", expected, {
    afterCaseLot,
    caseVariantRows: caseRows,
    caseVariantActions: caseCommit.report.actions,
    afterCaseVariant: counts(),
    afterFirstImport: afterFirst,
    secondImportRows: againRows,
    secondImportActions: second.report.actions,
    afterSecondImport: afterSecond,
    conflictRows,
    conflictCommit: /fixed or explicitly skipped/.test(conflictCommit) ? "refused" : conflictCommit,
    coveragesAfterCrash: uncovered,
    repairStagedRows: repairRows,
    repairActions: repaired.report.actions,
    afterRepair: counts(),
  })
  return { orgId: org.orgId }
}

async function reconciliationFindsGapsAndDuplicates(kit, spec, check) {
  const { inputs, expected } = spec
  const org = await installedOrg(kit, inputs, "WARR-01 reconciliation")
  const batch = await stage(kit, org, fileOf(inputs, inputs.lots))
  await commit(kit, org, batch.id)
  const { getWarrantyInstalledBaseReconciliation } = app("warranty-installed-base")
  const report = (batchId) => kit.as(org.owner, () => getWarrantyInstalledBaseReconciliation(batchId))
  const clean = await report()
  // What a faulty migration would leave, each recorded through the same function the import uses.
  const faultBatch = randomUUID()
  const place = (lot, closing) => kit.rows(`select public.import_installed_warranty_home(${kit.q(org.orgId)}, ${kit.q(org.owner.userId)}, ${kit.q(faultBatch)}, ${kit.q(JSON.stringify({ community_id: org.communityId, lot_number: lot, buyer_name: `Buyer ${lot}`, closing_date: closing }))}::jsonb) r`)[0].r
  const cover = (projectId, effective, terms) => kit.sql(`insert into public.project_warranty_coverage(org_id,project_id,program_id,effective_date,effective_source,terms_snapshot)
    select ${kit.q(org.orgId)}, ${kit.q(projectId)}, id, ${kit.q(effective)}, 'closing', ${kit.q(JSON.stringify(terms))}::jsonb from public.warranty_programs where org_id=${kit.q(org.orgId)} and is_default`)
  place(inputs.gap.lot, inputs.gap.closed)
  const late = place(inputs.mismatch.lot, inputs.mismatch.closed)
  cover(late.projectId, inputs.mismatch.coverageStart, [{ key: "workmanship", label: "Workmanship", duration_months: 12, is_structural: false, description: null, expires_on: inputs.mismatch.coverageEnd }])
  // A second home on a lot that already has one, each with correct coverage of its own.
  const twin = kit.rows(`select public.import_installed_warranty_home(${kit.q(org.orgId)}, ${kit.q(org.owner.userId)}, ${kit.q(faultBatch)}, ${kit.q(JSON.stringify({ community_id: org.communityId, lot_number: "9999", buyer_name: "Twin buyer", closing_date: inputs.twin.closed }))}::jsonb) r`)[0].r
  // The twin's closing is pointed at the first home's lot, which no service allows; the trigger is stood down for this fixture only.
  kit.sql(`begin; set local session_replication_role = replica;
update public.closings set lot_id=(select id from public.lots where org_id=${kit.q(org.orgId)} and lot_number=${kit.q(inputs.lots[0].lot)}) where project_id=${kit.q(twin.projectId)} and status='closed';
commit;`)
  cover(twin.projectId, inputs.twin.closed, inputs.twin.terms)
  // A lot recorded twice, once with a trailing space in its number: same lot once spacing is ignored.
  const dup = place("7", inputs.duplicateLot.closed)
  kit.sql(`update public.lots set lot_number='1 ' where project_id=${kit.q(dup.projectId)}`)
  cover(dup.projectId, inputs.duplicateLot.closed, inputs.duplicateLot.terms)
  const faulty = await report()
  const shape = (value) => ({ homes: value.homes, covered: value.covered, active: value.active, expired: value.expired, exceptions: value.exceptions.map((item) => [item.home.replace(/^.*Lot /, ""), item.kind]).sort(([a, x], [b, y]) => `${a}${x}`.localeCompare(`${b}${y}`)) })
  check.equal("reconciliation is clean for a clean import and names every gap, duplicate and date disagreement", expected, {
    clean: shape(clean),
    faulty: shape(faulty),
    importBatchScope: shape(await report(batch.id)),
  })
  return { orgId: org.orgId }
}

async function warrantyMoneyReconcilesAndReversalIsIdempotent(kit, spec, check) {
  const { inputs, expected } = spec
  const org = await home01().builder(kit, "WARR-01 warranty money", [{ name: "Lot 1 — Aspen plan", priceCents: inputs.priceCents }], undefined, seed.defaultPeriods())
  const home = org.homes[0], accounting = app("books/warranty-accounting"), q = kit.q
  await kit.as(org.owner, () => accounting.setWarrantyReserveEstimate({ projectId: home.projectId, date: "2026-07-01", amountCents: inputs.reserveCents, evidenceUrl: `${EVIDENCE}/estimate` }))
  kit.sql(`select public.post_books_warranty_reserve(${q(org.orgId)}, ${q(home.projectId)}, '2026-07-01', true, ${q(org.owner.userId)})`)
  const requestId = randomUUID(), visitId = randomUUID(), backchargeId = randomUUID()
  const stages = {}
  kit.sql(`begin;
insert into public.warranty_requests(id,org_id,project_id,title,request_number) values(${q(requestId)},${q(org.orgId)},${q(home.projectId)},'Drywall crack',1);
insert into public.warranty_service_visits(id,org_id,request_id,project_id,visit_number,assignee_kind,assigned_user_id,window_start,window_end,status) values(${q(visitId)},${q(org.orgId)},${q(requestId)},${q(home.projectId)},1,'tech',${q(org.owner.userId)},'2026-08-10 14:00Z','2026-08-10 16:00Z','completed');
commit;`)
  await home01().bill(kit, org, home.projectId, "2026-08-10", inputs.repairCents, "Drywall repair")
  const source = kit.rows(`select id from public.job_cost_entries where org_id=${q(org.orgId)} and project_id=${q(home.projectId)} and status='posted' and incurred_on='2026-08-10' and cost_cents>0`)[0].id
  const approve = (date) => kit.as(org.owner, () => accounting.approveWarrantyAccounting({ visitId, date, evidenceUrl: `${EVIDENCE}/visit`, sources: [{ jobCostEntryId: source, amountCents: inputs.repairCents }] }))
  const reverse = (date) => kit.as(org.owner, () => accounting.reverseWarrantyAccounting({ visitId, date, reason: "Visit was not accepted work yet" }))
  const net = (code) => Number(kit.rows(`select coalesce(sum(l.debit_cents-l.credit_cents),0)::bigint n from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id join public.gl_accounts a on a.id=l.account_id
    where l.org_id=${q(org.orgId)} and l.project_id=${q(home.projectId)} and e.status in ('posted','reversed') and a.code=${q(code)}`)[0].n)
  const recoveryEntries = () => Number(kit.rows(`select count(*) n from public.journal_entries where org_id=${q(org.orgId)} and source_type='warranty_reserve_recovery'`)[0].n)
  const control = async () => (await kit.service(() => app("books/verifier").runLedgerTieOuts(org.orgId, "2099-12-31"))).find((row) => row.code === "warranty_reserve_control").status
  const jobCost = () => Number(kit.rows(`select coalesce(sum(l.debit_cents-l.credit_cents),0)::bigint n from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id join public.gl_accounts a on a.id=l.account_id
    where l.org_id=${q(org.orgId)} and l.project_id=${q(home.projectId)} and e.status in ('posted','reversed') and a.account_type='cogs' and a.code<>'5050'`)[0].n)
  const position = async () => ({ reserve: -net("2260"), warrantyExpense: net("5050"), jobCost: jobCost(), recoveryEntries: recoveryEntries(), control: await control() })
  stages.provisioned = await position()
  await approve("2026-08-12")
  stages.approved = await position()
  // The trade's backcharge is issued as a vendor credit; the books restore the reserve for it once.
  const credit = await kit.as(org.owner, () => app("vendor-bills").createProjectVendorCredit({ projectId: home.projectId, companyId: org.vendorId, billNumber: "WB-1", billDate: "2026-08-15", description: "Warranty backcharge", lines: [{ description: "Drywall repair", amount_cents: -inputs.creditCents, cost_code_id: org.costCodeId }] }))
  kit.sql(`insert into public.warranty_backcharges(id,org_id,project_id,warranty_request_id,company_id,backcharge_number,status,amount_cents,reason,vendor_credit_bill_id) values(${q(backchargeId)},${q(org.orgId)},${q(home.projectId)},${q(requestId)},${q(org.vendorId)},1,'issued',${inputs.creditCents},'Drywall repair',${q(credit.id)})`)
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  stages.recovered = await position()
  await project(kit, org)
  await project(kit, org)
  stages.sweptAgain = await position()
  await reverse("2026-08-25")
  stages.approvalReversed = await position()
  const secondReversal = await reverse("2026-08-26")
  await project(kit, org)
  stages.reversalRepeated = await position()
  await approve("2026-08-28")
  const identicalRetry = await approve("2026-08-28")
  await project(kit, org)
  stages.approvedAgain = await position()
  const repeatedApproval = await refusal(() => approve("2026-08-29"))
  await project(kit, org)
  check.equal("reserve, approved cost, vendor credit and recovery reconcile to accepted work, and reversing or repeating posts nothing twice", expected, {
    stages,
    secondReversalChangedNothing: secondReversal.reversed === true && stages.reversalRepeated.reserve === stages.approvalReversed.reserve,
    identicalApprovalRetry: identicalRetry.approved,
    changedApprovalRefused: /Reverse the prior cost approval/.test(repeatedApproval) ? "refused" : repeatedApproval,
    finalPosition: await position(),
  })
  return { orgId: org.orgId, visitId }
}

/** Two visits on one request, one credit: reversing the earlier visit leaves the recovery the later one supports. */
async function reversalKeepsLaterVisitsRecovery(kit, spec, check) {
  const { inputs, expected } = spec
  const org = await home01().builder(kit, "WARR-01 two visits", [{ name: "Lot 1 — Aspen plan", priceCents: inputs.priceCents }], undefined, seed.defaultPeriods())
  const home = org.homes[0], accounting = app("books/warranty-accounting"), q = kit.q
  await kit.as(org.owner, () => accounting.setWarrantyReserveEstimate({ projectId: home.projectId, date: "2026-07-01", amountCents: inputs.reserveCents, evidenceUrl: `${EVIDENCE}/estimate` }))
  kit.sql(`select public.post_books_warranty_reserve(${q(org.orgId)}, ${q(home.projectId)}, '2026-07-01', true, ${q(org.owner.userId)})`)
  const requestId = randomUUID(), visits = [randomUUID(), randomUUID()]
  kit.sql(`begin;
insert into public.warranty_requests(id,org_id,project_id,title,request_number) values(${q(requestId)},${q(org.orgId)},${q(home.projectId)},'Drywall',1);
${visits.map((id, index) => `insert into public.warranty_service_visits(id,org_id,request_id,project_id,visit_number,assignee_kind,assigned_user_id,window_start,window_end,status) values(${q(id)},${q(org.orgId)},${q(requestId)},${q(home.projectId)},${index + 1},'tech',${q(org.owner.userId)},'2026-08-1${index} 14:00Z','2026-08-1${index} 16:00Z','completed');`).join("\n")}
commit;`)
  const sources = []
  for (const [index, visit] of inputs.visits.entries()) {
    await home01().bill(kit, org, home.projectId, visit.billDate, visit.cents, `Repair ${index + 1}`)
    sources.push(kit.rows(`select id from public.job_cost_entries where org_id=${q(org.orgId)} and project_id=${q(home.projectId)} and status='posted' and incurred_on=${q(visit.billDate)} and cost_cents>0`)[0].id)
  }
  const book = (index) => kit.as(org.owner, () => accounting.approveWarrantyAccounting({ visitId: visits[index], date: inputs.visits[index].approvedOn, evidenceUrl: `${EVIDENCE}/visit`, sources: [{ jobCostEntryId: sources[index], amountCents: inputs.visits[index].cents }] }))
  await book(0)
  await book(1)
  const credit = await kit.as(org.owner, () => app("vendor-bills").createProjectVendorCredit({ projectId: home.projectId, companyId: org.vendorId, billNumber: "WB-2", billDate: inputs.creditDate, description: "Warranty backcharge", lines: [{ description: "Drywall", amount_cents: -inputs.creditCents, cost_code_id: org.costCodeId }] }))
  kit.sql(`insert into public.warranty_backcharges(id,org_id,project_id,warranty_request_id,company_id,backcharge_number,status,amount_cents,reason,vendor_credit_bill_id) values(${q(randomUUID())},${q(org.orgId)},${q(home.projectId)},${q(requestId)},${q(org.vendorId)},1,'issued',${inputs.creditCents},'Drywall',${q(credit.id)})`)
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  const sum = (where) => Number(kit.rows(`select coalesce(sum(l.debit_cents-l.credit_cents),0)::bigint n from public.journal_lines l join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id join public.gl_accounts a on a.id=l.account_id
    where l.org_id=${q(org.orgId)} and l.project_id=${q(home.projectId)} and e.status in ('posted','reversed') and ${where}`)[0].n)
  const position = async () => ({ reserve: -sum("a.code='2260'"), warrantyExpense: sum("a.code='5050'"), jobCost: sum("a.account_type='cogs' and a.code<>'5050'"),
    recoveryEntries: Number(kit.rows(`select count(*) n from public.journal_entries where org_id=${q(org.orgId)} and source_type='warranty_reserve_recovery'`)[0].n),
    control: (await kit.service(() => app("books/verifier").runLedgerTieOuts(org.orgId, "2099-12-31"))).find((row) => row.code === "warranty_reserve_control").status })
  const before = await position()
  await kit.as(org.owner, () => accounting.reverseWarrantyAccounting({ visitId: visits[0], date: inputs.reverseOn, reason: "First visit was not accepted work" }))
  await project(kit, org)
  check.equal("reversing the earlier visit keeps the recovery the later visit's cost supports", expected, { before, afterReversingEarlier: await position() })
  return { orgId: org.orgId }
}

module.exports = {
  subcases: {
    "import-keeps-close-dates-and-terms": importKeepsCloseDatesAndTerms,
    "reimport-never-double-enrolls": reimportNeverDoubleEnrolls,
    "reconciliation-finds-gaps-and-duplicates": reconciliationFindsGapsAndDuplicates,
    "warranty-money-reconciles-and-reversal-is-idempotent": warrantyMoneyReconcilesAndReversalIsIdempotent,
    "reversal-keeps-later-visits-recovery": reversalKeepsLaterVisitsRecovery,
  },
}
