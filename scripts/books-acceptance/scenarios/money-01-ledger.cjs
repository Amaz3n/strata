// MONEY-01 ledger (EP10-02, plus the superintendent's read grant) — land and house cost corrections.
//
//   reversed-land-acquisition-corrects-and-balances  a mis-keyed land purchase is reversed, its lot is released and the
//                                                    right acquisition posts under the same settlement reference
//   reversed-start-transfer-reposts-once             a redated start reverses and posts again; a retry changes nothing
//   spec-home-adopted-by-books                       a spec home opens with no placeholder contract and Books adopts it;
//                                                    an untouched placeholder beside an agreement is repaired away
//   reversed-debt-funded-acquisition-nets-the-loan   a loan-funded acquisition is reversed and re-recorded; register and ledger agree
//   superintendent-reads-scope-and-options           the superintendent reads a home's released scope and options, never amounts
//
// Expected values are hand-derived in expected/MONEY-01.json. SQL writes only fixtures no service creates here
// (the lot's delivery, a purchase agreement, legacy placeholder contracts) and reads the outcome.
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const { app, project } = require("./shared.cjs")

const home01 = () => require("./home-01.cjs").helpers
const field01 = () => require("./field-01-documents.cjs").helpers
const EVIDENCE = "https://evidence.acceptance.example.test/money-01"
const glId = (kit, org, code) => kit.rows(`select id from public.gl_accounts where org_id=${kit.q(org.orgId)} and code=${kit.q(code)}`)[0].id
const refusal = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }

/** Journal entries that carry a lot's land lines (oldest first unless told): kind, status and the debit side. */
function landEntries(kit, org, lotId, order = "e.created_at, e.id") {
  return kit.rows(`select e.id, e.entry_kind, e.status, e.entry_date::text d,
      (select sum(debit_cents) from public.journal_lines where entry_id=e.id)::bigint debit, (select sum(credit_cents) from public.journal_lines where entry_id=e.id)::bigint credit
    from public.journal_entries e where e.org_id=${kit.q(org.orgId)} and (e.id in (select entry_id from public.journal_lines where org_id=${kit.q(org.orgId)} and dimensions->>'lot_id'=${kit.q(lotId)})
      or e.reversal_of_entry_id in (select entry_id from public.journal_lines where org_id=${kit.q(org.orgId)} and dimensions->>'lot_id'=${kit.q(lotId)})) order by ${order}`)
}
const shape = (rows) => rows.map((row) => [row.entry_kind, row.status, Number(row.debit)])
const balanced = (rows) => rows.every((row) => Number(row.debit) === Number(row.credit))

function lotState(kit, org, home) {
  const lot = kit.rows(`select status, books_acquisition_entry_id, cost_basis_cents from public.lots where id=${kit.q(home.lotId)}`)[0]
  return { status: lot.status, linkedToAcquisition: lot.books_acquisition_entry_id !== null, basisCents: lot.cost_basis_cents === null ? null : Number(lot.cost_basis_cents), landCents: home01().balances(kit, org, { lotId: home.lotId, codes: ["1120"] })["1120"] }
}

async function reversedLandAcquisitionCorrectsAndBalances(kit, spec, check) {
  const { inputs, expected } = spec
  const org = await home01().builder(kit, "MONEY-01 land correction", [{ name: "Lot 1 — Aspen plan", priceCents: inputs.priceCents }])
  const home = org.homes[0], inventory = app("books/inventory")
  const acquire = (cents) => kit.as(org.owner, () => inventory.acquireLandInventory({ date: "2026-06-02", allocations: [{ lotId: home.lotId, amountCents: cents }], cashAccountId: glId(kit, org, "1000"), cashCents: cents, debtInstrumentId: null, debtCents: 0, reference: "Lot 1 settlement", evidenceUrl: `${EVIDENCE}/land` }))
  await acquire(inputs.wrongCents)
  const wrongEntryId = kit.rows(`select books_acquisition_entry_id id from public.lots where id=${kit.q(home.lotId)}`)[0].id
  const reverse = () => kit.as(org.owner, () => inventory.reverseLandAcquisition({ entryId: wrongEntryId, date: "2026-06-05", reason: "Settlement keyed with the wrong amount" }))
  const reversal = await reverse()
  const afterReversal = lotState(kit, org, home)
  const retry = await reverse()
  const corrected = await acquire(inputs.rightCents)
  const retriedCorrection = await acquire(inputs.rightCents)
  const entries = landEntries(kit, org, home.lotId)
  const cashNet = Number(kit.rows(`select coalesce(sum(l.debit_cents-l.credit_cents),0)::bigint n from public.journal_lines l join public.gl_accounts a on a.id=l.account_id where l.org_id=${kit.q(org.orgId)} and a.code='1000' and l.entry_id in (${entries.map((row) => kit.q(row.id)).join(",")})`)[0].n)
  await project(kit, org)
  check.equal("a reversed acquisition releases its lot and the corrected one posts once, original, reversal and replacement all kept and balanced", expected, {
    afterReversal,
    reversalRetrySame: retry.reversalEntryId === reversal.reversalEntryId,
    afterCorrection: lotState(kit, org, home),
    correctionRetrySame: retriedCorrection.id === corrected.id,
    entries: shape(entries),
    everyEntryBalances: balanced(entries),
    cashNetCents: cashNet,
  })
  return { orgId: org.orgId, lotId: home.lotId }
}

async function reversedDebtFundedAcquisitionNetsTheLoan(kit, spec, check) {
  const { inputs, expected } = spec
  const org = await home01().builder(kit, "MONEY-01 debt-funded land", [{ name: "Lot 1 — Aspen plan", priceCents: inputs.priceCents }])
  const home = org.homes[0], inventory = app("books/inventory")
  const loan = await kit.as(org.owner, () => app("books/registers").createDebtInstrument({ name: "Land loan", openedOn: "2026-06-01", originalPrincipalCents: 0, annualInterestBps: 800, paymentFrequency: "monthly",
    liabilityAccountId: glId(kit, org, "2500"), cashAccountId: glId(kit, org, "1000"), interestExpenseAccountId: glId(kit, org, "6060") }))
  const instrumentId = loan.id ?? loan
  const acquire = ({ cashCents, debtCents }) => kit.as(org.owner, () => inventory.acquireLandInventory({ date: "2026-06-02", allocations: [{ lotId: home.lotId, amountCents: cashCents + debtCents }], cashAccountId: glId(kit, org, "1000"), cashCents, debtInstrumentId: instrumentId, debtCents, reference: "Lot 1 loan settlement", evidenceUrl: `${EVIDENCE}/land-loan` }))
  await acquire(inputs.wrong)
  const wrongEntryId = kit.rows(`select books_acquisition_entry_id id from public.lots where id=${kit.q(home.lotId)}`)[0].id
  await kit.as(org.owner, () => inventory.reverseLandAcquisition({ entryId: wrongEntryId, date: "2026-06-05", reason: "Settlement keyed with the wrong cash amount" }))
  await acquire(inputs.right)
  const entries = landEntries(kit, org, home.lotId)
  const ids = entries.map((row) => kit.q(row.id)).join(",")
  const net = (code) => Number(kit.rows(`select coalesce(sum(l.debit_cents-l.credit_cents),0)::bigint n from public.journal_lines l join public.gl_accounts a on a.id=l.account_id where l.org_id=${kit.q(org.orgId)} and a.code=${kit.q(code)} and l.entry_id in (${ids})`)[0].n)
  const events = kit.rows(`select event_type, principal_cents from public.books_debt_events where org_id=${kit.q(org.orgId)} and instrument_id=${kit.q(instrumentId)} order by created_at, id`)
  const registerCents = events.reduce((total, row) => total + (row.event_type === "draw" ? 1 : -1) * Number(row.principal_cents), 0)
  await project(kit, org)
  check.equal("a reversed loan-funded acquisition leaves the loan register and the ledger agreeing on the replacement draw, every journal balanced", expected, {
    debtEvents: events.map((row) => [row.event_type, Number(row.principal_cents)]),
    loanRegisterCents: registerCents,
    loanLiabilityCents: -net("2500"),
    cashNetCents: net("1000"),
    landCents: home01().balances(kit, org, { lotId: home.lotId, codes: ["1120"] })["1120"],
    entries: shape(entries),
    everyEntryBalances: balanced(entries),
  })
  return { orgId: org.orgId, lotId: home.lotId }
}

async function reversedStartTransferRepostsOnce(kit, spec, check) {
  const { inputs, expected } = spec
  const org = await home01().builder(kit, "MONEY-01 start correction", [{ name: "Lot 1 — Aspen plan", priceCents: inputs.priceCents }])
  const home = org.homes[0], inventory = app("books/inventory")
  await home01().landAndStart(kit, org, home, { date: "2026-06-02", startDate: "2026-06-03", cents: inputs.landCents })
  const state = () => ({
    constructionCents: home01().balances(kit, org, { projectId: home.projectId, codes: ["1160"] })["1160"],
    landCents: home01().balances(kit, org, { lotId: home.lotId, codes: ["1120"] })["1120"],
    receipts: kit.rows(`select status, cost_cents from public.job_cost_entries where org_id=${kit.q(org.orgId)} and project_id=${kit.q(home.projectId)} and source_type='inventory_event' order by created_at, id`).map((row) => [row.status, Number(row.cost_cents)]),
  })
  const before = state()
  const acquisitionEntryId = kit.rows(`select books_acquisition_entry_id id from public.lots where id=${kit.q(home.lotId)}`)[0].id
  const acquisitionAfterStart = (await refusal(() => kit.as(org.owner, () => inventory.reverseLandAcquisition({ entryId: acquisitionEntryId, date: "2026-06-04", reason: "Try to reverse land already moved into the house" })))).includes("later land entries") ? "refused" : "allowed"
  const correct = () => kit.as(org.owner, () => inventory.correctLandStartTransfer({ lotId: home.lotId, reversalDate: "2026-06-10", reason: "The start was redated to June 10", repostDate: "2026-06-10" }))
  const first = await correct()
  const after = state()
  const byDate = "e.entry_date, e.entry_kind desc, e.id"
  const entriesAfterFirst = landEntries(kit, org, home.lotId, byDate)
  const retry = await correct()
  const entriesAfterRetry = landEntries(kit, org, home.lotId, byDate)
  await project(kit, org)
  check.equal("a redated start reverses and posts again, keeping every receipt, and a retry posts nothing more", expected, {
    before, acquisitionAfterStart, after,
    entries: shape(entriesAfterFirst),
    startDates: kit.rows(`select status, entry_date::text d from public.journal_entries where org_id=${kit.q(org.orgId)} and source_type='inventory_start' and source_id=${kit.q(home.lotId)} order by created_at, id`).map((row) => [row.status, row.d]),
    everyEntryBalances: balanced(entriesAfterFirst),
    retrySameEntries: retry.reversalEntryId === first.reversalEntryId && retry.transferEntryId === first.transferEntryId,
    entriesAfterRetry: entriesAfterRetry.length,
    entriesAfterFirst: entriesAfterFirst.length,
  })
  return { orgId: org.orgId, lotId: home.lotId }
}

/**
 * A home whose start was reversed and posted again is sold: the reversal carries no source type of its
 * own, so the sale relief classifies it by the entry it reverses and the land leaves as one line.
 */
async function correctedStartSellsAsOneLandLine(kit, spec, check) {
  const { inputs, expected } = spec
  const org = await home01().builder(kit, "MONEY-01 corrected start sale", [{ name: "Lot 1 — Aspen plan", priceCents: inputs.priceCents }])
  const home = org.homes[0]
  await home01().landAndStart(kit, org, home, { date: "2026-06-02", startDate: "2026-06-03", cents: inputs.landCents })
  await kit.as(org.owner, () => app("books/inventory").correctLandStartTransfer({ lotId: home.lotId, reversalDate: "2026-06-10", reason: "The start was redated to June 10", repostDate: "2026-06-10" }))
  await home01().bill(kit, org, home.projectId, "2026-06-12", inputs.constructionCents)
  await kit.as(org.owner, () => app("books/inventory").completeProjectInventory({ projectId: home.projectId, date: "2026-07-01", evidenceUrl: `${EVIDENCE}/completion` }))
  await home01().settle(kit, org, home, inputs.saleDate)
  const lines = kit.rows(`select coalesce(l.dimensions->>'cost_component','unlabeled') component, (l.debit_cents-l.credit_cents)::bigint n from public.journal_lines l
    join public.journal_entries e on e.id=l.entry_id and e.org_id=l.org_id join public.gl_accounts a on a.id=l.account_id and a.org_id=l.org_id
    where l.org_id=${kit.q(org.orgId)} and l.project_id=${kit.q(home.projectId)} and a.code='5000' and e.source_type='inventory_sale_relief' order by 1, 2`).map((row) => [row.component, Number(row.n)])
  check.equal("the corrected start leaves inventory as one land-and-development line beside construction, and nothing is left behind", expected, {
    reliefLines: lines,
    inventoryLeft: home01().balances(kit, org, { projectId: home.projectId, codes: ["1160", "1170"] }),
  })
  return { orgId: org.orgId, projectId: home.projectId }
}

/** A production home with a purchase agreement; `placeholder` adds the fixed contract project setup used to open beside it. */
function homeWithAgreement(kit, org, name, { placeholder, agreement = "active", allowance = false }) {
  const { q } = kit
  const projectId = randomUUID(), placeholderId = randomUUID()
  kit.sql(`begin;
insert into public.projects(id,org_id,name,property_type,created_by) values(${q(projectId)},${q(org.orgId)},${q(name)},'production',${q(org.owner.userId)});
insert into public.project_financial_settings(org_id,project_id) values(${q(org.orgId)},${q(projectId)}) on conflict do nothing;
${agreement ? `insert into public.contracts(id,org_id,project_id,title,status,total_cents,currency,contract_type,effective_date,signed_at) values(${q(randomUUID())},${q(org.orgId)},${q(projectId)},'Purchase agreement',${q(agreement)},40000000,'usd','purchase_agreement','2026-06-01','2026-06-01T12:00:00Z');` : ""}
${placeholder ? `insert into public.contracts(id,org_id,project_id,title,status,total_cents,currency,contract_type,snapshot) values(${q(placeholderId)},${q(org.orgId)},${q(projectId)},${q(`${name} Contract`)},'active',null,'usd','fixed','{"billing_setup_source":"project_settings"}'::jsonb);` : ""}
${allowance ? `insert into public.allowances(org_id,project_id,name,budget_cents,contract_id) values(${q(org.orgId)},${q(projectId)},'Flooring',100000,${q(placeholderId)});` : ""}
commit;`)
  return projectId
}
const contractTypes = (kit, projectId) => kit.rows(`select contract_type from public.contracts where project_id=${kit.q(projectId)} order by contract_type`).map((row) => row.contract_type)

async function specHomeAdoptedByBooks(kit, spec, check) {
  const { expected } = spec
  const org = await seed.productionBuilder(kit, { name: "MONEY-01 spec home" })
  await seed.seedCommunity(kit, org)
  await seed.takeDownTranche(kit, org)
  const lotId = org.trancheLotIds[0]
  // Delivery of the lot is LAND-01's subject, so it is recorded directly.
  kit.sql(`update public.lots set delivered_at=coalesce(delivered_at, now()) where id=${kit.q(lotId)}`)
  const opened = await kit.as(org.team.starts, () => app("starts").openStartPackage(lotId, { isFinanced: false }))
  const homeId = kit.rows(`select project_id id from public.lots where id=${kit.q(lotId)}`)[0].id
  const openedContracts = contractTypes(kit, homeId)
  // The sale later signs the home's purchase agreement; Books then adopts the home as inventory.
  kit.sql(`insert into public.contracts(id,org_id,project_id,title,status,total_cents,currency,contract_type,effective_date,signed_at) values(${kit.q(randomUUID())},${kit.q(org.orgId)},${kit.q(homeId)},'Purchase agreement','active',40000000,'usd','purchase_agreement','2026-06-01','2026-06-01T12:00:00Z');`)
  const adoption = await refusal(() => kit.as(org.owner, () => app("books/inventory").enableProjectInventory({ projectId: homeId, effectiveOn: "2026-06-01", evidenceUrl: `${EVIDENCE}/spec-ownership` })))
  // Homes created before the fix: a placeholder beside an agreement, one a bill or allowance already uses, one with no agreement.
  const untouched = homeWithAgreement(kit, org, "MONEY-01 untouched placeholder", { placeholder: true })
  const inUse = homeWithAgreement(kit, org, "MONEY-01 placeholder in use", { placeholder: true, allowance: true })
  const noAgreement = homeWithAgreement(kit, org, "MONEY-01 placeholder only", { placeholder: true, agreement: null })
  const repair = () => Number(kit.rows("select public.repair_placeholder_home_contracts() n")[0].n)
  const removed = repair(), removedAgain = repair()
  check.equal("a spec home opens without a placeholder and Books adopts it; only an untouched placeholder beside an agreement is repaired, once", expected, {
    packageOpened: Boolean(opened.id),
    contractsAtOpening: openedContracts,
    booksAdoption: adoption === "allowed" ? "adopted" : adoption,
    repair: { removed, removedAgain, untouched: contractTypes(kit, untouched), inUse: contractTypes(kit, inUse), noAgreement: contractTypes(kit, noAgreement) },
    repairAudited: Number(kit.rows(`select count(*)::int n from public.audit_log where org_id=${kit.q(org.orgId)} and source='ep10_placeholder_contract_repair'`)[0].n),
  })
  return { orgId: org.orgId, homeId }
}

async function superintendentReadsScopeAndOptions(kit, spec, check) {
  const { expected } = spec
  const { documentsOrg, releasedHome, scopeRows } = field01()
  const org = await documentsOrg(kit)
  const projectId = await releasedHome(kit, org, "MONEY-01 superintendent")
  const read = (actor) => kit.as(actor, () => app("released-field-documents").getReleasedForHome(projectId))
  const seen = (dto) => ({ sheets: dto.sheets.length, options: dto.options?.map((option) => [option.categoryName, option.optionName]) ?? null, scope: dto.scope ? scopeRows(dto) : null })
  const outside = await refusal(() => read(org.superB))
  const amounts = await refusal(() => kit.as(org.team.superintendent, () => app("po-positions").getProjectPoPositions(projectId)))
  check.equal("the superintendent role reads the awarded scope and confirmed options, within division scope", expected, {
    superintendent: seen(await read(org.team.superintendent)),
    commitmentAmounts: amounts === "allowed" ? "allowed" : "refused",
    divisionLimitedSuperintendent: seen(await read(org.superA)),
    otherDivisionSuperintendent: outside === "allowed" ? "allowed" : "refused",
  })
  return { orgId: org.orgId, projectId }
}

module.exports = {
  subcases: {
    "reversed-land-acquisition-corrects-and-balances": reversedLandAcquisitionCorrectsAndBalances,
    "reversed-debt-funded-acquisition-nets-the-loan": reversedDebtFundedAcquisitionNetsTheLoan,
    "reversed-start-transfer-reposts-once": reversedStartTransferRepostsOnce,
    "corrected-start-sells-as-one-land-line": correctedStartSellsAsOneLandLine,
    "spec-home-adopted-by-books": specHomeAdoptedByBooks,
    "superintendent-reads-scope-and-options": superintendentReadsScopeAndOptions,
  },
}
