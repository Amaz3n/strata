// SALE-01 subcases for EP05-04 (contingencies), EP05-05 (lender and title milestones) and
// EP05-10 (closing to warranty handoff). Composed into sale-01.cjs by the lead; each subcase is
// `async (kit, expected, check)` and acts through `kit.as`, so permissions and row security are
// the real ones:
//
//   contingencies-come-from-the-signed-agreement  EP05-04  execution seeds the signed contingencies and the lender/title set once; sales cannot resolve them
//   required-milestones-block-close               EP05-04  an open or failed milestone required before closing refuses clear-to-close, in the service and in SQL
//   lender-title-dependencies-aging-and-desk      EP05-05  prerequisites hold, a late milestone ages on the workbench, ranks first on the Sales desk and is reminded once
//   signed-update-reconciles-and-mismatch-refused EP05-05  a signed lender update reconciles to the agreement, buyer and home; a mismatch is refused, kept and visible
//   co-gate-needs-evidence                        EP05-10  the certificate of occupancy gate completes only with a file on this home and is never waived
//   settlement-enrolls-once-and-reversal-reenrolls EP05-10 settlement enrolls the agreement's program once; a reversal voids it and the re-closing enrolls again
//
// Lots: these subcases sell homes in an org of their own (`milestoneOrg`, built once per run with
// Cypress Landing's first tranche taken down), one developed lot each (SALE_LOTS below), so they
// never share a lot with LOT-01's land chain when every scenario runs on one stack.
//
// SQL is used only for what a subcase is not about and says so: evidence file records (the stack
// has no file storage), the direct writes the database must refuse, a re-opened closing row after a
// reversal, and reads that check outcomes.
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const { app } = require("./shared.cjs")

const lot = () => require("./lot-01.cjs").helpers
const equal = (check, label, expected, observed) => lot().equal(check, label, expected, observed)
const attempt = async (work) => {
  try { await work(); return "allowed" } catch (error) { return error.issues ? `invalid: ${error.issues.map((issue) => issue.message).join("; ")}` : error.message }
}
const sqlAttempt = (kit, statement) => {
  try { kit.sql(statement); return "allowed" } catch (error) { const line = /ERROR:\s+([^\n]+)/.exec(error.message); return line ? line[1].trim() : error.message }
}
const SALE_LOTS = { seeded: 0, blocked: 1, aging: 2, feed: 3, coGate: 4, warranty: 5, closed: 6 }

const MILESTONE_ORGS = new WeakMap()
/** A production builder with Cypress Landing, its plans and tranche 1 (lots 1-10) owned and developed. */
function milestoneOrg(kit) {
  if (!MILESTONE_ORGS.has(kit)) MILESTONE_ORGS.set(kit, (async () => {
    const org = await seed.productionBuilder(kit, { name: "SALE-01 contingencies and milestones" })
    await seed.seedCommunity(kit, org)
    await seed.seedProduct(kit, org)
    await seed.takeDownTranche(kit, org)
    return org
  })())
  return MILESTONE_ORGS.get(kit)
}

/**
 * A buyer's executed agreement on one developed lot, the closing projected. `terms` are the
 * financing and contingencies the seller wrote on the agreement sheet; financed with none by default.
 */
async function soldHome(kit, key, buyer, terms = {}) {
  const org = await milestoneOrg(kit)
  const target = org.lots[SALE_LOTS[key]]
  const prospect = await seed.registerBuyer(kit, org, buyer)
  const { reservation } = await seed.reserveLot(kit, org, { prospect, lotId: target.id, depositCents: 1000000, receivedOn: "2026-06-06" })
  const sale = await seed.signAgreement(kit, org, { reservationId: reservation.id, config: { ...seed.configuration(org, { lotId: target.id, plan: org.plans[0], swing: "right", skus: [] }), ...terms } })
  const closingId = kit.rows(`select id from public.closings where project_id=${kit.q(sale.projectId)} and status<>'cancelled'`)[0].id
  return { org, lot: target, buyer, ...sale, closingId }
}

const milestonesOf = (kit, contractId) =>
  kit.rows(`select id, template_key, kind, status, required_before, evidence_required, is_contingency, version, due_on::text due_on from public.agreement_milestones where contract_id=${kit.q(contractId)} order by sort_order`)
const homeFile = (kit, org, projectId, name) =>
  kit.rows(`insert into public.files(org_id,project_id,file_name,storage_path,metadata) values(${kit.q(org.orgId)},${kit.q(projectId)},${kit.q(name)},${kit.q(`acceptance/${randomUUID()}`)},'{}') returning id`)[0].id

async function contingenciesComeFromTheSignedAgreement(kit, expected, check) {
  // Written on the agreement sheet: the sale of the buyer's current home, due 45 days after signing, holds closing.
  const home = await soldHome(kit, "seeded", { name: "Ana Ruiz", email: "ana.ruiz@acceptance.example.test" }, {
    financing: "financed",
    contingencies: [{ kind: "home_sale", title: "Sale of 41 Palm Ave", required_before: "closing", due_in_days: 45, evidence_required: true }],
  })
  const seeded = milestonesOf(kit, home.contractId)
  kit.sql(`select public.seed_agreement_milestones(${kit.q(home.contractId)})`)
  const afterRerun = milestonesOf(kit, home.contractId).length
  const salesResolves = await attempt(() => kit.as(home.org.team.sales, () => app("agreement-milestones").resolveAgreementMilestone({
    milestoneId: seeded[0].id, version: seeded[0].version, resolution: "waived", resolvedOn: seed.isoDay(0), note: "Buyer is paying cash after all",
  })))
  const program = kit.rows(`select warranty_program_id is not null bound from public.contracts where id=${kit.q(home.contractId)}`)[0].bound
  equal(check, "execution seeds the signed contingency and the lender and title milestones once, with deadlines, gates and evidence rules, and binds the warranty program", expected.expected.seeded, {
    milestones: seeded.map((row) => ({ key: row.template_key, requiredBefore: row.required_before, evidence: row.evidence_required, contingency: row.is_contingency })),
    contingencyDueIn45Days: seeded.find((row) => row.is_contingency)?.due_on === seed.isoDay(45),
    afterRerun, programBound: program, salesResolves: /closing\.manage|Missing permission/.test(salesResolves) ? "refused" : salesResolves,
  })
  return { orgId: home.org.orgId, projectId: home.projectId }
}

async function requiredMilestonesBlockClose(kit, expected, check) {
  const home = await soldHome(kit, "blocked", { name: "Ben Ortiz", email: "ben.ortiz@acceptance.example.test" })
  const closings = app("closings"), milestones = app("agreement-milestones"), owner = home.org.owner
  await kit.as(owner, () => closings.scheduleClosing({ closingId: home.closingId, scheduledDate: seed.isoDay(30) }))
  for (const item of kit.rows(`select id, evidence_required from public.closing_checklist_items where closing_id=${kit.q(home.closingId)} and is_gate`)) {
    if (item.evidence_required) await kit.as(owner, () => closings.updateClosingChecklistItem({ itemId: item.id, status: "complete", fileId: homeFile(kit, home.org, home.projectId, "co.pdf") }))
    else await kit.as(owner, () => closings.updateClosingChecklistItem({ itemId: item.id, status: "waived", notes: "Verified at the closing table by the title agent." }))
  }
  const serviceRefusal = await attempt(() => kit.as(owner, () => closings.markClearedToClose(home.closingId)))
  const sqlRefusal = sqlAttempt(kit, `update public.closings set status='cleared_to_close' where id=${kit.q(home.closingId)}`)
  const appraisal = milestonesOf(kit, home.contractId).find((row) => row.kind === "appraisal")
  const shortWaiver = await attempt(() => kit.as(owner, () => milestones.resolveAgreementMilestone({ milestoneId: appraisal.id, version: appraisal.version, resolution: "waived", resolvedOn: seed.isoDay(0), note: "ok" })))
  const noEvidence = await attempt(() => kit.as(owner, () => milestones.resolveAgreementMilestone({ milestoneId: appraisal.id, version: appraisal.version, resolution: "satisfied", resolvedOn: seed.isoDay(0), evidenceFileId: null })))
  await kit.as(owner, () => milestones.resolveAgreementMilestone({ milestoneId: appraisal.id, version: appraisal.version, resolution: "satisfied", resolvedOn: seed.isoDay(0), evidenceFileId: homeFile(kit, home.org, home.projectId, "appraisal.pdf") }))
  await seed.prepareClosingGates(kit, home.org, home.closingId)
  const cleared = await kit.as(owner, () => closings.markClearedToClose(home.closingId))
  const history = kit.rows(`select source, to_status, actor_id is not null attributed from public.agreement_milestone_history where milestone_id=${kit.q(appraisal.id)} order by created_at`)
  equal(check, "an open milestone required before closing refuses clear-to-close in the service and in SQL; a waiver needs a reason and satisfaction its evidence", expected.expected.blocked, {
    serviceRefusal: /milestone before closing/.test(serviceRefusal) ? "refused" : serviceRefusal,
    sqlRefusal: /milestone before closing/.test(sqlRefusal) ? "refused" : sqlRefusal,
    shortWaiver: /at least 10 characters/.test(shortWaiver) ? "refused" : shortWaiver,
    noEvidence: /evidence file/.test(noEvidence) ? "refused" : noEvidence,
    cleared: cleared.status, history,
  })
  return { orgId: home.org.orgId, projectId: home.projectId }
}

async function lenderTitleDependenciesAgingAndDesk(kit, expected, check) {
  const home = await soldHome(kit, "aging", { name: "Carla Diaz", email: "carla.diaz@acceptance.example.test" })
  const milestones = app("agreement-milestones"), owner = home.org.owner
  const rows = milestonesOf(kit, home.contractId)
  const ctc = rows.find((row) => row.kind === "clear_to_close"), approval = rows.find((row) => row.kind === "loan_approval")
  const ctcEarly = await attempt(() => kit.as(owner, () => milestones.resolveAgreementMilestone({ milestoneId: ctc.id, version: ctc.version, resolution: "satisfied", resolvedOn: seed.isoDay(0), evidenceFileId: homeFile(kit, home.org, home.projectId, "ctc.pdf") })))
  const noReason = await attempt(() => kit.as(owner, () => milestones.updateAgreementMilestone({ milestoneId: approval.id, version: approval.version, dueOn: seed.isoDay(-4) })))
  await kit.as(owner, () => milestones.updateAgreementMilestone({ milestoneId: approval.id, version: approval.version, dueOn: seed.isoDay(-4), ownerUserId: owner.userId, reason: "Lender moved underwriting to this date" }))
  const workbench = await kit.as(owner, () => milestones.getHomeAgreementMilestones(home.projectId))
  const late = workbench.milestones.find((row) => row.id === approval.id)
  const signals = await kit.as(home.org.team.sales, () => milestones.readMilestoneDeskSignals([home.projectId]))
  const { nextActionFor } = require("../../../lib/sales/next-action")
  const desk = nextActionFor({ stage: "building", nextFollowUpAt: null, closingScheduledDate: seed.isoDay(40), projectId: home.projectId, contractStatus: "active", openGateCount: 0, createdAt: seed.isoDay(-60) }, new Date(), signals[home.projectId] ?? null)
  await milestones.sweepAgreementMilestoneDeadlines()
  await milestones.sweepAgreementMilestoneDeadlines()
  const reminders = Number(kit.rows(`select count(*)::int n from public.events where entity_id=${kit.q(approval.id)} and event_type='agreement_milestone.due'`)[0].n)
  equal(check, "clear to close waits on its prerequisites; a late approval ages on the workbench, leads the Sales desk and is reminded once per threshold", expected.expected.aging, {
    ctcEarly: /first; this milestone depends on it/.test(ctcEarly) ? "refused" : ctcEarly,
    noReason: /needs a reason/.test(noReason) ? "refused" : noReason,
    overdueDays: late.aging.overdueDays, blockedBy: workbench.milestones.find((row) => row.id === ctc.id).blockedBy.length > 0,
    desk: { label: desk.label, tone: desk.tone }, reminders,
  })
  return { orgId: home.org.orgId, projectId: home.projectId }
}

async function signedUpdateReconcilesAndMismatchRefused(kit, expected, check) {
  const home = await soldHome(kit, "feed", { name: "Dev Patel", email: "dev.patel@acceptance.example.test" })
  const milestones = app("agreement-milestones"), owner = home.org.owner
  const { signInboundPayload } = require("../../../lib/inbound/signature")
  const salesCreates = await attempt(() => kit.as(home.org.team.sales, () => milestones.createMilestoneSource({ name: "Sales cannot" })))
  const { source, secret } = await kit.as(owner, () => milestones.createMilestoneSource({ name: "First Coast Title" }))
  const number = kit.rows(`select number from public.contracts where id=${kit.q(home.contractId)}`)[0].number
  const post = (delivery, body, key = secret) => {
    const rawBody = JSON.stringify(body), timestamp = String(Math.floor(Date.now() / 1000))
    return kit.service(() => milestones.receiveMilestoneReport({ sourcePublicId: source.public_id, deliveryId: delivery, timestamp, signature: signInboundPayload(key, timestamp, rawBody), rawBody }))
  }
  const base = { agreement_number: number, buyer_email: home.buyer.email, lot_number: home.lot.lot_number, reported_on: seed.isoDay(0) }
  const receipts = {
    application: await post("d-app", { ...base, milestone: "loan_application", status: "satisfied" }),
    appraisal: await post("d-apr", { ...base, milestone: "appraisal", status: "satisfied", reference: "APR-77" }),
    replay: await post("d-apr", { ...base, milestone: "appraisal", status: "satisfied", reference: "APR-77" }),
    altered: await post("d-apr", { ...base, milestone: "appraisal", status: "failed" }),
    wrongBuyer: await post("d-buyer", { ...base, buyer_email: "someone.else@acceptance.example.test", milestone: "title_commitment", status: "in_progress" }),
    wrongHome: await post("d-home", { ...base, lot_number: "999", milestone: "title_commitment", status: "in_progress" }),
    badSignature: await post("d-sig", { ...base, milestone: "title_commitment", status: "in_progress" }, "not-the-secret"),
  }
  const rows = Object.fromEntries(milestonesOf(kit, home.contractId).map((row) => [row.kind, row.status]))
  const appraisal = kit.rows(`select reported_status, reported_reference from public.agreement_milestones where contract_id=${kit.q(home.contractId)} and kind='appraisal'`)[0]
  const feedLog = await kit.as(owner, () => milestones.listMilestoneSources())
  const homeLog = await kit.as(owner, () => milestones.getHomeAgreementMilestones(home.projectId))
  equal(check, "a signed update reconciles to the agreement, buyer and home; a mismatch is refused with its reason, kept and visible on the feed log and the home", expected.expected.feed, {
    salesCreates: /org\.settings\.update|Missing permission/.test(salesCreates) ? "refused" : salesCreates,
    receipts: Object.fromEntries(Object.entries(receipts).map(([key, value]) => [key, { status: value.status, outcome: value.body.outcome ?? value.body.error, reason: value.body.reason_code ?? null }])),
    statuses: { loan_application: rows.loan_application, appraisal: rows.appraisal, title_commitment: rows.title_commitment },
    appraisalReported: appraisal,
    feedRejected: feedLog.sources.find((row) => row.id === source.id).rejected_count,
    feedRefused: feedLog.deliveries.filter((row) => row.outcome === "refused").map((row) => row.reason_code).sort(),
    homeRefused: homeLog.deliveries.filter((row) => row.outcome === "refused").map((row) => row.reason_code).sort(),
  })
  return { orgId: home.org.orgId, projectId: home.projectId }
}

async function coGateNeedsEvidence(kit, expected, check) {
  const home = await soldHome(kit, "coGate", { name: "Eva Chen", email: "eva.chen@acceptance.example.test" })
  const other = await soldHome(kit, "warranty", { name: "Fay Moss", email: "fay.moss@acceptance.example.test" })
  const closings = app("closings"), owner = home.org.owner
  await kit.as(owner, () => closings.scheduleClosing({ closingId: home.closingId, scheduledDate: seed.isoDay(30) }))
  const gate = kit.rows(`select id from public.closing_checklist_items where closing_id=${kit.q(home.closingId)} and key='final_inspection_co'`)[0]
  const complete = (fileId) => attempt(() => kit.as(owner, () => closings.updateClosingChecklistItem({ itemId: gate.id, status: "complete", fileId })))
  const observed = {
    withoutFile: /evidence file/.test(await complete(null)) ? "refused" : "allowed",
    waived: /cannot be waived/.test(await attempt(() => kit.as(owner, () => closings.updateClosingChecklistItem({ itemId: gate.id, status: "waived", notes: "Inspector approved by phone" })))) ? "refused" : "allowed",
    sqlWaive: /cannot be waived/.test(sqlAttempt(kit, `update public.closing_checklist_items set status='waived', notes='Inspector approved by phone', completed_at=now(), completed_by=${kit.q(owner.userId)} where id=${kit.q(gate.id)}`)) ? "refused" : "allowed",
    otherHomesFile: /this home|another home/.test(await complete(homeFile(kit, other.org, other.projectId, "co-elsewhere.pdf"))) ? "refused" : "allowed",
    ownFile: await complete(homeFile(kit, home.org, home.projectId, "co.pdf")),
  }
  equal(check, "the certificate of occupancy gate completes only with a file on this home and cannot be waived", expected.expected.coGate, observed)
  return { orgId: home.org.orgId, projectId: home.projectId }
}

async function settlementEnrollsOnceAndReversalReenrolls(kit, expected, check) {
  const org = await milestoneOrg(kit)
  const sale = await seed.presoldThroughClosing(kit, org, { lot: org.lots[SALE_LOTS.closed], plan: org.plans[0], buyer: { name: "Gus Lane", email: "gus.lane@acceptance.example.test" }, skus: [] })
  await kit.drainOutbox(org.orgId)
  const coverage = () => kit.rows(`select effective_date::text effective_date, voided_at is not null voided, program_id = (select warranty_program_id from public.contracts where id=${kit.q(sale.contractId)}) sold_program from public.project_warranty_coverage where project_id=${kit.q(sale.projectId)} order by created_at`)
  const first = coverage()
  await kit.as(org.owner, () => app("closings").recoverClosingCompletion(sale.projectId, sale.closingId)).catch((error) => { if (!/Missing R2/.test(error.message)) throw error })
  await kit.drainOutbox(org.orgId)
  const afterRetry = coverage().length
  const termsEdit = sqlAttempt(kit, `update public.project_warranty_coverage set effective_date=effective_date+1 where project_id=${kit.q(sale.projectId)}`)
  await kit.as(org.owner, () => app("closings").reverseClosing({ closingId: sale.closingId, reason: "Buyer financing fell through after funding; title returned.", date: seed.isoDay(0) }))
  const afterReversal = coverage()
  // A sale that resumes is a new closing on the home; the desk's row for it is written directly.
  const closingId = randomUUID()
  kit.sql(`insert into public.closings(id,org_id,project_id,lot_id,community_id,status,created_by) select ${kit.q(closingId)},org_id,project_id,lot_id,community_id,'projected',${kit.q(org.owner.userId)} from public.closings where id=${kit.q(sale.closingId)}`)
  await seed.closeHome(kit, org, { projectId: sale.projectId, date: seed.isoDay(1) })
  await kit.drainOutbox(org.orgId)
  const events = Number(kit.rows(`select count(*)::int n from public.events where event_type='warranty_coverage_enrolled' and payload->>'project_id'=${kit.q(sale.projectId)}`)[0].n)
  equal(check, "settlement enrolls the program the agreement sold exactly once; a reversal voids it and the re-closing enrolls one new live coverage", expected.expected.warranty, {
    first: first.map((row) => ({ voided: row.voided, soldProgram: row.sold_program })), afterRetry,
    termsEdit: /fixed at enrollment/.test(termsEdit) ? "refused" : termsEdit,
    afterReversal: afterReversal.map((row) => row.voided),
    final: coverage().map((row) => ({ voided: row.voided, newDate: row.effective_date === seed.isoDay(1) })), events,
  })
  return { orgId: org.orgId, projectId: sale.projectId }
}

const subcases = {
  "contingencies-come-from-the-signed-agreement": contingenciesComeFromTheSignedAgreement,
  "required-milestones-block-close": requiredMilestonesBlockClose,
  "lender-title-dependencies-aging-and-desk": lenderTitleDependenciesAgingAndDesk,
  "signed-update-reconciles-and-mismatch-refused": signedUpdateReconcilesAndMismatchRefused,
  "co-gate-needs-evidence": coGateNeedsEvidence,
  "settlement-enrolls-once-and-reversal-reenrolls": settlementEnrollsOnceAndReversalReenrolls,
}
module.exports = { subcases, helpers: { milestoneOrg, soldHome, SALE_LOTS } }
