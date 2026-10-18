// WARR-02 — the warranty lifecycle on an imported home and a newly closed one (EP14-05). One
// production builder: a home that closed before Arc comes in through the installed-base import,
// and a home sold, built and closed in Arc. Each goes through the same desk, by the role that owns
// each step, through the real services:
//
//   imported-home-coverage-classifies-claims   the imported home's coverage starts on its real closing date; a claim under a
//                                              term that has ended is out of warranty, one under a live term is in
//   imported-home-request-to-recovery          request, dispatch to a technician, visit, verification by a second person,
//                                              backcharge issued, disputed and settled for less; the vendor credit and its
//                                              reversal are the receipts
//   new-home-request-to-recovery               the same lifecycle on a home the closing desk closed in Arc, from the coverage
//                                              its closing enrolled
//   new-home-reserve-ties                      the repair is approved against the reserve the closing provided and the settled
//                                              recovery restores it: the warranty reserve control and the home controls pass
//
// Field visits are completed through the desktop service, as the office records them; the mobile
// visit flow (EP09-01) is out of scope for this desktop acceptance. Expected values are in expected/WARR-02.json.
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const { app, project } = require("./shared.cjs")
const { helpers: home } = require("./home-01.cjs")

const ops = () => app("warranty-operations")
const attempt = (work) => work().then(() => "done", (error) => error.message)
const EVIDENCE = "https://evidence.acceptance.example.test/warr-02"
const IMPORT_HEADERS = ["community", "lot_number", "block", "address", "buyer_name", "buyer_email", "closing_date", "program", "workmanship_months", "systems_months", "structural_months"]

const STAGES = new WeakMap()
function stage(kit, name) {
  const state = STAGES.get(kit) ?? (STAGES.set(kit, { done: new Map() }), STAGES.get(kit))
  if (!state.done.has(name)) state.done.set(name, STEPS[name](kit, state))
  return state.done.get(name)
}

const STEPS = {
  async org(kit, state) {
    // HOME-01's builder: a community, its framing trade and cost code, and a sold home whose closing the
    // closing desk records on a past date (a home released today cannot close in the past; LOT-01 and
    // SPEC-01 prove that lifecycle, and a claim filed before a closing date would book to work in progress).
    const org = state.org = await home.builder(kit, "WARR-02 warranty lifecycle", [{ name: "Lot 1 — Aspen plan", priceCents: 40000000 }], undefined, seed.defaultPeriods())
    // HOME-01's fixture is a custom-home org; this one is a production builder, whose default warranty
    // program carries the workmanship, systems and structural terms.
    kit.sql(`update public.orgs set product_tier='production' where id=${kit.q(org.orgId)}`)
    for (const actor of [org.owner, org.reviewer]) actor.productTier = "production"
    await kit.service(() => ops().ensureWarrantyDefaults(org.orgId))
    // The owner keys in and approves the build's payables while the office is one person; the desk comes after.
    org.closedHome = await buildAndClose(kit, org)
    // The warranty desk: its manager dispatches and verifies, a technician does the work; the bookkeeper enters payables.
    org.team = { warranty: kit.addMember(org, "org_warranty_manager") }
    org.techA = kit.addMember(org, "org_warranty_manager")
    org.bookkeeper = kit.addMember(org, "org_office_admin")
    const plumber = randomUUID(), plumbing = randomUUID()
    kit.sql(`insert into public.companies(id,org_id,name) values(${kit.q(plumber)},${kit.q(org.orgId)},'Cedar Ridge plumbing');
insert into public.cost_codes(id,org_id,code,name) values(${kit.q(plumbing)},${kit.q(org.orgId)},'22-100','Plumbing')`)
    org.vendorIds = { "Cedar Ridge framing": org.vendorId, "Cedar Ridge plumbing": plumber }
    org.costCodeIds = { "06-100": org.costCodeId, "22-100": plumbing }
    return org
  },

  /** A home that closed before Arc, imported with its closing date and the terms it was sold with. */
  async imported(kit, state) {
    const org = await stage(kit, "org")
    const input = state.importInput
    // The legacy community the installed base sits in: a community row, as WARR-01's fixture.
    org.legacyCommunityId = randomUUID()
    kit.sql(`insert into public.communities(id,org_id,name,time_zone) values(${kit.q(org.legacyCommunityId)},${kit.q(org.orgId)},${kit.q(input.community)},'America/New_York')`)
    const csvText = seed.csv(IMPORT_HEADERS, [{ community: input.community, lot_number: input.lot, block: "", address: `${input.lot} Heron Bay Ct`, buyer_name: input.buyer,
      buyer_email: "heron.bay.buyer@acceptance.example.test", closing_date: input.closed, program: "", workmanship_months: input.workmanship, systems_months: input.systems, structural_months: input.structural }])
    const imports = app("imports")
    const batch = await kit.as(org.team.warranty, () => imports.stageImportBatch({ importer: "warranty_homes", csvText, sourceFilename: "installed-homes.csv" }, { expectedImporter: "warranty_homes" }))
    const committed = await kit.as(org.team.warranty, () => imports.commitImportBatch(batch.id, { expectedImporter: "warranty_homes" }))
    const projectId = kit.rows(`select project_id from public.lots where org_id=${kit.q(org.orgId)} and community_id=${kit.q(org.legacyCommunityId)} and lot_number=${kit.q(input.lot)}`)[0].project_id
    return { projectId, committed }
  },

  async closed(kit) {
    return (await stage(kit, "org")).closedHome
  },
}

/** The sold home built, completed with its $6,500 reserve and closed by the closing desk on July 25. */
async function buildAndClose(kit, org) {
  const [sold] = org.homes
  await home.landAndStart(kit, org, sold, { date: "2026-06-02", startDate: "2026-06-03", cents: 7200000 })
  await home.bill(kit, org, sold.projectId, "2026-06-10", 25160000)
  await kit.as(org.owner, () => app("books/warranty-accounting").setWarrantyReserveEstimate({ projectId: sold.projectId, date: "2026-07-01", amountCents: 650000, evidenceUrl: `${EVIDENCE}/reserve` }))
  await kit.as(org.owner, () => app("books/inventory").completeProjectInventory({ projectId: sold.projectId, date: "2026-07-01", evidenceUrl: `${EVIDENCE}/completion` }))
  await home.deposit(kit, org, sold, { date: "2026-06-05", cents: 2000000 })
  const closingId = await home.settle(kit, org, sold, "2026-07-25")
  return { projectId: sold.projectId, closingId }
}

const recoveryEntries = (kit, org, projectId) => Number(kit.rows(`select count(distinct e.id)::int n from public.journal_entries e join public.journal_lines l on l.entry_id=e.id and l.org_id=e.org_id
  where e.org_id=${kit.q(org.orgId)} and l.project_id=${kit.q(projectId)} and e.source_type='warranty_reserve_recovery' and e.status in ('posted','reversed')`)[0].n)
const coverageOf = (kit, projectId) => kit.rows(`select effective_date::text effective, effective_source source, terms_snapshot terms from public.project_warranty_coverage where project_id=${kit.q(projectId)} and voided_at is null`)

/**
 * One claim through the desk: the manager logs it and dispatches the technician, the technician
 * records the visit, cannot verify their own work, the manager verifies it; the trade at fault is
 * backcharged, disputes it, and the manager settles for less. Returns what each step left behind.
 */
async function lifecycle(kit, org, projectId, input) {
  const desk = ops()
  const manager = org.team.warranty, tech = org.techA
  const trade = org.vendorIds[input.trade]
  const request = await kit.as(manager, () => desk.createWarrantyRequest({ input: { project_id: projectId, title: input.title, severity: "routine_30", coverage_term_key: input.termKey } }))
  const window = input.window ?? { start: `${seed.isoDay(input.windowInDays)}T14:00:00Z`, end: `${seed.isoDay(input.windowInDays)}T16:00:00Z` }
  const visit = await kit.as(manager, () => desk.scheduleWarrantyVisit({ request_id: request.id, assignee_kind: "tech", assigned_user_id: tech.userId, window_start: window.start, window_end: window.end }))
  await kit.as(tech, () => desk.completeWarrantyVisit({ visit_id: visit.id, outcome: "resolved", outcome_note: input.workDone }))
  const selfVerify = await attempt(() => kit.as(tech, () => desk.verifyWarrantyVisit(visit.id)))
  await kit.as(manager, () => desk.verifyWarrantyVisit(visit.id))
  const backcharge = await kit.as(manager, () => desk.createWarrantyBackcharge({
    project_id: projectId, warranty_request_id: request.id, company_id: trade, cost_code_id: org.costCodeIds[input.costCode], amount_cents: input.backchargeCents, reason: input.backchargeReason, confirm_no_ap_history: true,
    cost_basis: input.costBasis,
  }))
  const issued = await kit.as(manager, () => desk.issueWarrantyBackcharge({ backchargeId: backcharge.id }))
  await kit.as(manager, () => desk.disputeWarrantyBackcharge({ backchargeId: backcharge.id, note: input.dispute }))
  const settled = await kit.as(manager, () => desk.resolveWarrantyBackcharge({ backchargeId: backcharge.id, resolution: "settled", recoveredCents: input.recoveredCents, note: input.settlementNote }))
  // The reversal of the written-off part is a payable like any other: the owner approves it so it posts.
  const reversal = kit.rows(`select id, status from public.vendor_bills where org_id=${kit.q(org.orgId)} and bill_number=${kit.q(`WB-${issued.backcharge_number}-R`)}`)[0]
  const reversalWaited = reversal?.status ?? null
  if (reversal) await kit.as(org.owner, () => app("vendor-bills").approveVendorBillsAtomic([{ id: reversal.id }]))
  const bills = (number) => kit.rows(`select total_cents::bigint total from public.vendor_bills where org_id=${kit.q(org.orgId)} and company_id=${kit.q(trade)} and bill_number=${kit.q(number)}`).map((row) => Number(row.total))
  const requestRow = kit.rows(`select status, coverage_status, metadata from public.warranty_requests where id=${kit.q(request.id)}`)[0]
  const visitRow = kit.rows(`select status, completed_by from public.warranty_service_visits where id=${kit.q(visit.id)}`)[0]
  return {
    request, visit, backcharge, issued, settled,
    observed: {
      request: { status: requestRow.status, coverage: requestRow.coverage_status, verifiedByTheManager: requestRow.metadata?.verified_by === manager.userId },
      visit: { status: visitRow.status, completedByTheTechnician: visitRow.completed_by === tech.userId },
      selfVerify: /second person/.test(selfVerify) ? "refused: a second person verifies" : selfVerify,
      backcharge: {
        status: settled.status, recoveredCents: settled.recovered_cents, writtenOffCents: settled.settlement.written_off_cents,
        creditCents: bills(`WB-${issued.backcharge_number}`), reversalCents: bills(`WB-${issued.backcharge_number}-R`), reversalWaitedForApproval: reversalWaited,
        events: kit.rows(`select event_type from public.events where entity_id=${kit.q(backcharge.id)} and event_type like 'warranty_backcharge%' order by created_at, id`).map((row) => row.event_type),
      },
    },
  }
}

async function importedHomeCoverageClassifiesClaims(kit, spec, check) {
  STAGES.get(kit) ?? STAGES.set(kit, { done: new Map() })
  STAGES.get(kit).importInput = spec.inputs.home
  const org = await stage(kit, "org")
  const { projectId, committed } = await stage(kit, "imported")
  const [coverage] = coverageOf(kit, projectId)
  const claim = (termKey, title) => kit.as(org.team.warranty, () => ops().createWarrantyRequest({ input: { project_id: projectId, title, severity: "routine_30", coverage_term_key: termKey } }))
  const ended = await claim("workmanship", "Grout cracking in the guest bath")
  const live = await claim("systems", "Water heater relief valve weeping")
  const recon = committed.report.reconciliation
  check.equal("the imported home is covered from its real closing date with the terms it was sold with, and each claim is classified against the term it falls under", spec.expected, {
    coverage: { effective: coverage.effective, source: coverage.source, terms: coverage.terms.map((term) => [term.key, term.duration_months, term.expires_on]) },
    reconciliation: { homes: recon.homes, covered: recon.covered, active: recon.active, exceptions: recon.exception_count },
    claims: { workmanship: ended.coverage_status, systems: live.coverage_status },
    reserve: home.balances(kit, org, { projectId, codes: ["2260"] })["2260"],
  })
  return { orgId: org.orgId, projectId }
}

async function importedHomeRequestToRecovery(kit, spec, check) {
  STAGES.get(kit) ?? STAGES.set(kit, { done: new Map() })
  STAGES.get(kit).importInput ??= spec.inputs.home
  const org = await stage(kit, "org")
  const { projectId } = await stage(kit, "imported")
  const run = await lifecycle(kit, org, projectId, spec.inputs.claim)
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  check.equal("the imported home's claim is dispatched, visited, verified by a second person, backcharged, disputed and settled for less, with the vendor credit and its reversal as receipts", spec.expected, {
    ...run.observed,
    books: { ...home.balances(kit, org, { projectId, codes: ["2260", "5000"] }), recoveryEntries: recoveryEntries(kit, org, projectId) },
  })
  return { orgId: org.orgId, projectId, backchargeId: run.backcharge.id }
}

/** The new home's claim and its accounting, staged once: the lifecycle and the reserve both read it. */
function newHomeClaim(kit, spec) {
  const state = STAGES.get(kit) ?? (STAGES.set(kit, { done: new Map() }), STAGES.get(kit))
  if (!state.newClaim) state.newClaim = (async () => {
    const org = await stage(kit, "org")
    const { projectId, closingId } = await stage(kit, "closed")
    const input = spec.inputs
    const closedOn = kit.rows(`select actual_date::text d from public.closings where id=${kit.q(closingId)}`)[0].d
    const before = home.balances(kit, org, { projectId, codes: ["2260", "5050", "5000"] })
    const run = await lifecycle(kit, org, projectId, input.claim)
    // The repair crew's bill for the visit: the bookkeeper enters it, the owner approves it.
    const bills = app("vendor-bills")
    const repairDate = seed.isoDay(input.repairInDays)
    org.bookkeeper ??= kit.addMember(org, "org_office_admin")
    const repair = await kit.as(org.bookkeeper, () => bills.createProjectVendorBill({ projectId, input: {
      company_id: org.vendorIds[input.repairVendor], bill_number: `WR-${projectId.slice(0, 6)}`, bill_date: repairDate, due_date: repairDate, total_cents: input.repairCents,
      actual_lines: [{ cost_code_id: org.costCodeIds[input.repairCostCode], description: "Warranty repair: drywall and paint after the leak", amount_cents: input.repairCents, project_id: projectId }] } }))
    await kit.as(org.owner, () => bills.approveVendorBillsAtomic([{ id: repair.id }]))
    await kit.drainOutbox(org.orgId)
    await project(kit, org)
    const source = kit.rows(`select id from public.job_cost_entries where org_id=${kit.q(org.orgId)} and project_id=${kit.q(projectId)} and status='posted' and incurred_on=${kit.q(repairDate)} and cost_code_id=${kit.q(org.costCodeIds[input.repairCostCode])} and cost_cents>0`)
    await kit.as(org.owner, () => app("books/warranty-accounting").approveWarrantyAccounting({ visitId: run.visit.id, date: repairDate, evidenceUrl: `${EVIDENCE}/visit`, sources: source.map((row) => ({ jobCostEntryId: row.id, amountCents: input.repairCents })) }))
    await kit.drainOutbox(org.orgId)
    await project(kit, org)
    await project(kit, org)
    return { org, projectId, closedOn, before, run, sources: source.length }
  })()
  return state.newClaim
}

async function newHomeRequestToRecovery(kit, spec, check) {
  const { org, projectId, closedOn, run } = await newHomeClaim(kit, spec)
  const [coverage] = coverageOf(kit, projectId)
  check.equal("the home closed in Arc is covered from its closing, and its claim goes request, dispatch, visit, verification by a second person, backcharge, dispute and a settlement for less", spec.expected, {
    coverage: { startsOnClosing: coverage.effective === closedOn, source: coverage.source, terms: coverage.terms.map((term) => [term.key, term.duration_months]) },
    ...run.observed,
  })
  return { orgId: org.orgId, projectId, backchargeId: run.backcharge.id }
}

async function newHomeReserveTies(kit, spec, check) {
  const { org, projectId, before, sources } = await newHomeClaim(kit, spec)
  const after = home.balances(kit, org, { projectId, codes: ["2260", "5050", "5000"] })
  check.equal("the repair is approved against the reserve the closing provided, the settled recovery restores part of it, and the reserve and home controls tie", spec.expected, {
    reserveProvidedAtClosing: -before["2260"],
    repairSources: sources,
    change: Object.fromEntries(Object.keys(after).map((code) => [code, after[code] - before[code]])),
    reserveLeft: -after["2260"],
    recoveryEntries: recoveryEntries(kit, org, projectId),
    controls: await home.controls(kit, org, seed.isoDay(60)),
  })
  return { orgId: org.orgId, projectId }
}

module.exports = {
  subcases: {
    "imported-home-coverage-classifies-claims": importedHomeCoverageClassifiesClaims,
    "imported-home-request-to-recovery": importedHomeRequestToRecovery,
    "new-home-request-to-recovery": newHomeRequestToRecovery,
    "new-home-reserve-ties": newHomeReserveTies,
  },
}
