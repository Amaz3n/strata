// PERMIT-01 — permits (EP06-06, EP06-07, EP06-08). One production builder (Cypress Landing in
// the Gulf Coast division, The Mangrove offered, the first tranche bought and developed),
// whose community pulls building permits from Collier County Growth Management: a directory
// company with a plan-review profile (21 days) and a checklist (construction plans before
// submission, energy calculations before the decision). A second division, Treasure Coast,
// has a starts coordinator limited to it. Every subcase acts through `kit.as`, so row-level
// security and permission checks are the real ones:
//
//   application-needs-its-documents                  EP06-06  submissions, revisions, required documents and the decision's evidence
//   corrections-keep-history                         EP06-07  correction rounds keep owner, due date and status history
//   coordinator-queue-shows-overdue-and-unresolved   EP06-07  late decisions and unresolved rounds reach the Starts desk band and the owner
//   fees-reconcile-to-payments                       EP06-08  fees reconcile to the bills and expenses that paid them on the home
//   starts-require-the-right-permit                  EP06-08  the start gate reads the approved permit for the lot's plan, never a waiver
//
// Homes are given out once at build: lot 1 to subcase 1, 2 to subcase 2, 3-5 to subcase 3,
// 6 to subcase 4; subcase 5 opens lot 7 itself.
//
// SQL is used only for what a subcase is not about and says so where it happens: evidence
// file records (the stack has no file storage), the authority's company record, a pin moved
// by hand in subcase 5 (the plan-change review that moves pins is PROD-01's subject), and
// the direct writes the database guards must refuse. Reads that check the outcome are SQL as
// the stack superuser.
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const { app } = require("./shared.cjs")

const context = () => require("../../../lib/services/context")
// What a person is told when they are refused, or "allowed". A rejected input reads as its messages.
const attempt = async (work) => {
  try { await work(); return "allowed" } catch (error) { return error.issues ? `invalid: ${error.issues.map((issue) => issue.message).join("; ")}` : error.message }
}
// Permission refusals carry the platform's wording; the subcase only claims who may act.
const outcome = async (work) => ((await attempt(work)) === "allowed" ? "allowed" : "refused")
const one = (kit, sql) => kit.rows(sql)[0]
const count = (kit, sql) => Number(kit.rows(`select count(*)::int n from (${sql}) t`)[0].n)
const day = (offset) => seed.isoDay(offset)
// A date as days from today, so the expectations hold on any run day.
const rel = (date) => (date ? `D${Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${day(0)}T00:00:00Z`)) / 86400000)}` : null)

/** A REST write as the member's own session, as a browser would send it: the error, or "allowed". */
const rest = (kit, actor, write) => attempt(() => kit.as(actor, async () => {
  const { supabase } = await context().requireOrgContext()
  const { error } = await write(supabase)
  if (error) throw new Error(error.message)
}))

// ---------------------------------------------------------------------------
// The builder, built once per run and shared by the subcases.

const WORLDS = new WeakMap()
function world(kit) {
  if (!WORLDS.has(kit)) WORLDS.set(kit, build(kit))
  return WORLDS.get(kit)
}

async function build(kit) {
  const org = await seed.productionBuilder(kit, { name: "PERMIT-01 permits" })
  await seed.seedCommunity(kit, org)
  await seed.seedProduct(kit, org)
  await seed.takeDownTranche(kit, org)
  const permits = app("permits"), starts = app("starts"), lots = app("lots")
  org.bookkeeper = kit.addMember(org, "org_office_admin")
  org.viewer = kit.addMember(org, "org_viewer")
  // Treasure Coast: another division with a starts coordinator limited to it (as SEC-01).
  const divisionId = (await kit.as(org.owner, () => app("divisions").createDivision({ name: "Treasure Coast", code: "TC", region: "Southeast Florida" }))).id
  const treasure = kit.addMember(org, "org_starts_coordinator")
  const membershipId = one(kit, `select id from public.memberships where org_id=${kit.q(org.orgId)} and user_id=${kit.q(treasure.userId)}`).id
  await kit.as(org.owner, () => app("team").updateMemberRole({ membershipId, role: "org_starts_coordinator", divisionScope: "assigned", divisionIds: [divisionId] }))
  org.treasureStarts = treasure
  // The authority is a directory company (fixture row); the coordinator records its review time and checklist.
  const authorityId = seed.permitAuthority(kit, org)
  await kit.as(org.team.starts, () => permits.setPermitJurisdictionProfile({ companyId: authorityId, reviewDays: 21, requirements: [
    { permitType: "building", documentKind: "construction_plans", label: "Construction plans", requiredFor: "submission" },
    { permitType: "building", documentKind: "energy_calcs", label: "Energy calculations", requiredFor: "decision" },
  ] }))
  await kit.as(org.owner, () => permits.setCommunityPermitAuthority({ communityId: org.communityId, companyId: authorityId }))
  // Six spec homes on lots 1-6, each pinned to The Mangrove and opened on the starts desk.
  const plan = org.plans[0]
  org.homes = []
  for (const lot of org.lots.slice(0, 6)) {
    await kit.as(org.team.starts, () => lots.assignPlanToLot(lot.id, { versionId: plan.versionId, elevationId: plan.elevationIds[0] }))
    const pkg = await kit.as(org.team.starts, () => starts.openStartPackage(lot.id, { isFinanced: false }))
    org.homes.push({ lot, packageId: pkg.id, projectId: one(kit, `select project_id from public.start_packages where id=${kit.q(pkg.id)}`).project_id })
  }
  return { org, authorityId }
}

/** Permit steps as the starts coordinator (or `actor`). */
function desk(kit, org, actor = org.team.starts) {
  const permits = app("permits")
  const as = (work, who = actor) => kit.as(who, work)
  return {
    open: (projectId, extra = {}) => as(() => permits.createPermitApplication({ projectId, jurisdictionCompanyId: org.permitAuthorityId, permitType: "building", ...extra })).then((row) => row.applicationId),
    attach: (applicationId, documentKind, fileId) => as(() => permits.setPermitDocument({ applicationId, documentKind, fileId })),
    submit: (applicationId, submittedOn, extra = {}) => as(() => permits.recordPermitSubmission({ applicationId, submittedOn, ...extra })),
    round: (applicationId, input) => as(() => permits.recordCorrectionRound({ applicationId, ...input })).then((row) => row.roundId),
    updateRound: (roundId, input) => as(() => permits.updateCorrectionRound({ roundId, ...input })),
    decide: (applicationId, input) => as(() => permits.recordPermitDecision({ applicationId, decision: "approved", decidedOn: day(-1), ...input })),
    fee: (applicationId, input) => as(() => permits.assessPermitFee({ applicationId, assessedOn: day(-20), ...input })).then((row) => row.feeId),
    view: (projectId) => as(() => permits.getProjectPermits(projectId)),
  }
}

/** Every document an application still lacks, attached as a file on its home. */
async function attachMissing(kit, org, d, applicationId, projectId) {
  for (const row of kit.rows(`select document_kind from public.permit_application_documents where application_id=${kit.q(applicationId)} and file_id is null order by sort_order`))
    await d.attach(applicationId, row.document_kind, seed.homeFile(kit, org, projectId, `${row.document_kind}.pdf`))
}

/** The issued permit and the approved plan set, as files on the home. */
const decisionFiles = (kit, org, projectId) => ({
  issuedPermitFileId: seed.homeFile(kit, org, projectId, "building-permit.pdf"),
  approvedPlansFileId: seed.homeFile(kit, org, projectId, "approved-plans.pdf"),
})

// ---------------------------------------------------------------------------
// 1. EP06-06: an application tracks its submissions, revisions, required documents and
//    decision; missing evidence holds the submission and the approval, in the database.

async function applicationNeedsItsDocuments(kit, expected, check) {
  const { org } = await world(kit)
  const d = desk(kit, org)
  const home = org.homes[0]
  const applicationId = await d.open(home.projectId)
  const observed = {
    checklist: kit.rows(`select document_kind, required_for from public.permit_application_documents where application_id=${kit.q(applicationId)} order by sort_order`),
    submitWithoutDocuments: await attempt(() => d.submit(applicationId, day(-40))),
  }
  await d.attach(applicationId, "plot_plan", seed.homeFile(kit, org, home.projectId, "plot-plan.pdf"))
  observed.anotherHomesFile = await attempt(() => d.attach(applicationId, "construction_plans", seed.homeFile(kit, org, org.homes[1].projectId, "construction-plans.pdf")))
  await d.attach(applicationId, "construction_plans", seed.homeFile(kit, org, home.projectId, "construction-plans.pdf"))
  observed.viewerSubmits = await outcome(() => desk(kit, org, org.viewer).submit(applicationId, day(-40)))
  observed.submit = await attempt(() => d.submit(applicationId, day(-40)))
  observed.revision = await attempt(() => d.submit(applicationId, day(-35), { note: "Revised truss layout" }))
  observed.submissions = kit.rows(`select submission_no, kind, expected_decision_on = submitted_on + 21 as on_the_authority_clock from public.permit_submissions where application_id=${kit.q(applicationId)} order by submission_no`)
  observed.reviewedPlanIsTheLotsPin = one(kit, `select a.house_plan_version_id = l.house_plan_version_id and a.house_plan_elevation_id = l.house_plan_elevation_id ok from public.permit_applications a join public.lots l on l.id = a.lot_id where a.id=${kit.q(applicationId)}`).ok
  const files = decisionFiles(kit, org, home.projectId)
  observed.approveWithoutEnergyCalcs = await attempt(() => d.decide(applicationId, { permitNumber: "BLD-26-1001", ...files }))
  await d.attach(applicationId, "energy_calcs", seed.homeFile(kit, org, home.projectId, "energy-calcs.pdf"))
  observed.approveWithoutApprovedPlans = await attempt(() => d.decide(applicationId, { permitNumber: "BLD-26-1001", issuedPermitFileId: files.issuedPermitFileId }))
  observed.approveWithoutPermitNumber = await attempt(() => d.decide(applicationId, { ...files }))
  observed.approve = await attempt(() => d.decide(applicationId, { permitNumber: "BLD-26-1001", ...files }))
  observed.decided = one(kit, `select decision, permit_number, decided_by=${kit.q(org.team.starts.userId)} by_the_coordinator from public.permit_applications where id=${kit.q(applicationId)}`)
  observed.decidedIsARecord = await attempt(() => d.attach(applicationId, "plot_plan", null))
  observed.directInsert = await rest(kit, org.team.starts, (supabase) => supabase.from("permit_applications").insert({ org_id: org.orgId, project_id: home.projectId, jurisdiction_company_id: org.permitAuthorityId, permit_type: "pool" }))
  observed.directApproval = await rest(kit, org.team.starts, (supabase) => supabase.from("permit_applications").update({ decision: "denied" }).eq("id", applicationId))
  observed.audited = count(kit, `select 1 from public.audit_log where org_id=${kit.q(org.orgId)} and entity_type='permit_application' and entity_id=${kit.q(applicationId)}`)
  check.equal("a building application snapshots the authority's checklist with the plot plan; it is not submitted without its submission documents (on this home), records each submission against the authority's clock and the plan reviewed, and is approved only with every document, the issued permit, the approved plans and a number — then it is a record; members cannot write permits directly", expected.expected, observed)
  return { orgId: org.orgId, applicationId }
}

// ---------------------------------------------------------------------------
// 2. EP06-07: correction rounds keep their history, owner and due date.

async function correctionsKeepHistory(kit, expected, check) {
  const { org } = await world(kit)
  const d = desk(kit, org)
  const home = org.homes[1]
  const applicationId = await d.open(home.projectId)
  await attachMissing(kit, org, d, applicationId, home.projectId)
  await d.submit(applicationId, day(-30))
  const first = await d.round(applicationId, { receivedOn: day(-20), comments: "Show the truss uplift connectors on sheet S-2", dueOn: day(-10) })
  await d.updateRound(first, { ownerUserId: org.team.superintendent.userId, dueOn: day(-6), note: "Superintendent takes the field redraw" })
  const observed = { resolveUnanswered: await attempt(() => d.updateRound(first, { status: "resolved", note: "Looks fine" })) }
  await d.submit(applicationId, day(-8), { respondsToRoundId: first })
  await d.updateRound(first, { status: "resolved", note: "Accepted by plan review" })
  await d.round(applicationId, { receivedOn: day(-5), comments: "Provide the flood elevation certificate", dueOn: day(5) })
  const files = decisionFiles(kit, org, home.projectId)
  observed.approveWithRoundOpen = await attempt(() => d.decide(applicationId, { permitNumber: "BLD-26-1002", ...files }))
  const role = new Map([[org.team.starts.userId, "starts coordinator"], [org.team.superintendent.userId, "superintendent"]])
  observed.rounds = kit.rows(`select round_no, status, owner_user_id, due_on::text from public.permit_correction_rounds where application_id=${kit.q(applicationId)} order by round_no`)
    .map((row) => ({ round: row.round_no, status: row.status, owner: role.get(row.owner_user_id) ?? row.owner_user_id, due: rel(row.due_on) }))
  observed.firstRoundHistory = kit.rows(`select actor_id, from_status, to_status, from_owner_user_id, to_owner_user_id, from_due_on::text, to_due_on::text, note
    from public.permit_correction_round_history where round_id=${kit.q(first)} order by created_at`).map((row) => ({
    actor: role.get(row.actor_id) ?? row.actor_id, from: row.from_status, to: row.to_status,
    fromOwner: row.from_owner_user_id ? role.get(row.from_owner_user_id) : null, toOwner: role.get(row.to_owner_user_id) ?? row.to_owner_user_id,
    fromDue: rel(row.from_due_on), toDue: rel(row.to_due_on), note: row.note,
  }))
  observed.editHistory = await rest(kit, org.team.starts, (supabase) => supabase.from("permit_correction_round_history").update({ note: "rewritten" }).eq("round_id", first))
  observed.editRound = await rest(kit, org.team.starts, (supabase) => supabase.from("permit_correction_rounds").update({ due_on: day(30) }).eq("id", first))
  check.equal("a correction round answers the latest submission and keeps who owned it, when it was due and where it stood every time any of those moved, and who moved them; it resolves only once answered, an open round holds the approval, and nobody edits rounds or their history directly", expected.expected, observed)
  return { orgId: org.orgId, applicationId, roundId: first }
}

// ---------------------------------------------------------------------------
// 3. EP06-07: overdue applications and unresolved corrections reach the coordinator.

async function coordinatorQueueShowsOverdueAndUnresolved(kit, expected, check) {
  const { org } = await world(kit)
  const d = desk(kit, org), permits = app("permits")
  const [late, waiting, fine] = org.homes.slice(2, 5)
  const lateApp = await d.open(late.projectId)
  await attachMissing(kit, org, d, lateApp, late.projectId)
  await d.submit(lateApp, day(-60))
  const waitingApp = await d.open(waiting.projectId)
  await attachMissing(kit, org, d, waitingApp, waiting.projectId)
  await d.submit(waitingApp, day(-20))
  const round = await d.round(waitingApp, { receivedOn: day(-15), comments: "Revise the drainage plan", dueOn: day(-3) })
  const fineApp = await d.open(fine.projectId)
  await attachMissing(kit, org, d, fineApp, fine.projectId)
  await d.submit(fineApp, day(-5))

  const mine = new Map([[lateApp, "lot 3"], [waitingApp, "lot 4"], [fineApp, "lot 5"]])
  const band = async (actor) => (await kit.as(actor, () => permits.listPermitQueue({ communityId: org.communityId }))).rows
    .filter((row) => mine.has(row.id))
    .map((row) => ({ home: mine.get(row.id), stage: row.stageLabel, decision: row.aging.decision && rel(row.aging.decision.dueOn), response: row.aging.response && rel(row.aging.response.dueOn), attention: row.aging.attention, href: row.href.endsWith(`?permit=${row.id}`) }))
  const observed = { coordinatorBand: await band(org.team.starts), treasureCoastBand: await band(org.treasureStarts) }

  const sweep = () => kit.service(() => permits.sweepPermitDeadlines())
  const announced = () => ({
    correctionDue: count(kit, `select 1 from public.events where org_id=${kit.q(org.orgId)} and event_type='permit_correction.due' and entity_id=${kit.q(round)}`),
    decisionOverdue: count(kit, `select 1 from public.events where org_id=${kit.q(org.orgId)} and event_type='permit_application.decision_overdue' and entity_id=${kit.q(lateApp)}`),
    onTrack: count(kit, `select 1 from public.events where org_id=${kit.q(org.orgId)} and entity_id=${kit.q(fineApp)} and event_type like 'permit_%' and event_type not like 'permit_application.%ed'`),
  })
  await sweep()
  observed.firstSweep = announced()
  await sweep()
  observed.secondSweep = announced()
  await kit.drainOutbox(org.orgId)
  observed.roundOwnerNotified = count(kit, `select 1 from public.notifications where org_id=${kit.q(org.orgId)} and user_id=${kit.q(org.team.starts.userId)} and notification_type='permit_correction_due'`)
  observed.applicationOwnerNotified = count(kit, `select 1 from public.notifications where org_id=${kit.q(org.orgId)} and user_id=${kit.q(org.team.starts.userId)} and notification_type='permit_decision_overdue'`)
  check.equal("the Starts desk band lists the application past the authority's review time and the round whose response is late, latest first, and not the one on schedule; a coordinator limited to another division sees none; the daily sweep announces each once to its owner", expected.expected, observed)
  return { orgId: org.orgId, applicationIds: [lateApp, waitingApp, fineApp] }
}

// ---------------------------------------------------------------------------
// 4. EP06-08: fee obligations reconcile to the bills and expenses that paid them.

async function feesReconcileToPayments(kit, expected, check) {
  const { org, authorityId } = await world(kit)
  const d = desk(kit, org), permits = app("permits"), bills = app("vendor-bills"), costPlus = app("cost-plus")
  const home = org.homes[5]
  const applicationId = await d.open(home.projectId)
  await attachMissing(kit, org, d, applicationId, home.projectId)
  await d.submit(applicationId, day(-20))
  const review = await d.fee(applicationId, { kind: "plan_review", amountCents: 45000, dueBefore: "submission" })
  const permit = await d.fee(applicationId, { kind: "permit", amountCents: 218000, dueBefore: "issuance" })
  await d.fee(applicationId, { kind: "impact", amountCents: 650000, dueBefore: "certificate_of_occupancy" })
  const position = async () => {
    const totals = (await d.view(home.projectId)).applications.find((row) => row.id === applicationId).feeTotals
    return { obligated: totals.obligatedCents, paid: totals.paidCents, owed: totals.varianceCents, reconciled: totals.reconciled }
  }
  const observed = { assessed: await position() }
  const roles = () => kit.rows(`select t.key from public.party_roles r join public.directory_relationship_types t on t.id=r.relationship_type_id where r.company_id=${kit.q(authorityId)} and r.status='active' order by t.key`).map((row) => row.key)
  observed.authorityRolesBefore = roles()

  // Plan review: paid at the counter, recorded by the office as an expense with its receipt, approved by the owner.
  observed.coordinatorPaysByBill = await outcome(() => kit.as(org.team.starts, () => permits.payPermitFee({ via: "bill", feeId: review, billNumber: "CC-PR-1", billDate: day(-19) })))
  const counter = await kit.as(org.bookkeeper, () => permits.payPermitFee({ via: "expense", feeId: review, paidOn: day(-19), paymentMethod: "check", receiptFileId: seed.homeFile(kit, org, home.projectId, "plan-review-receipt.pdf") }))
  observed.counterPaymentRecorded = await position()
  await kit.as(org.owner, () => costPlus.approveProjectExpense(counter.projectExpenseId))
  observed.counterPaymentApproved = await position()
  observed.authorityRolesAfter = roles()

  // Permit fee: the county's invoice entered as a bill on the home, approved, and paid in two parts.
  const approveTooEarly = () => attempt(() => d.decide(applicationId, { permitNumber: "BLD-26-1006", ...decisionFiles(kit, org, home.projectId) }))
  observed.approveBeforePermitFeePaid = await approveTooEarly()
  const { vendorBillId } = await kit.as(org.bookkeeper, () => permits.payPermitFee({ via: "bill", feeId: permit, billNumber: "CC-2026-0412", billDate: day(-10) }))
  observed.billOnTheHome = one(kit, `select b.project_id=${kit.q(home.projectId)} and b.company_id=${kit.q(authorityId)} and b.total_cents=218000 and bool_and(l.project_id=${kit.q(home.projectId)}) ok from public.vendor_bills b join public.bill_lines l on l.bill_id=b.id where b.id=${kit.q(vendorBillId)} group by b.id`).ok
  await kit.as(org.owner, () => bills.approveVendorBillsAtomic([{ id: vendorBillId }]))
  const pay = (status, cents, check) => kit.as(org.owner, () => bills.updateVendorBillStatus({ billId: vendorBillId, input: { status, payment_amount_cents: cents, payment_method: "check",
    check_number: check, payment_date: day(-5), books_payment_account_id: seed.glId(kit, org, "1000"), payment_idempotency_key: `permit-01-${check}-${org.orgId}` } }))
  await pay("partial", 100000, "5101")
  observed.billPaidInPart = await position()
  observed.approveWithPermitFeePartlyPaid = await approveTooEarly()
  await pay("paid", 118000, "5102")
  observed.billPaid = await position()

  // The linked bill keeps its amount and home; a payable on another home is not this fee's.
  observed.editLinkedBill = await rest(kit, org.owner, (supabase) => supabase.from("vendor_bills").update({ total_cents: 200000 }).eq("id", vendorBillId))
  // A posted bill may meet the Books delete guard first; either way it stays.
  observed.deleteLinkedBill = (await rest(kit, org.owner, (supabase) => supabase.from("vendor_bills").delete().eq("id", vendorBillId))) === "allowed" ? "allowed" : "refused"
  observed.linkedBillAsLinked = one(kit, `select total_cents::int as cents, status from public.vendor_bills where id=${kit.q(vendorBillId)}`)
  const other = await d.fee(applicationId, { kind: "other", amountCents: 30000, description: "Re-inspection" })
  const elsewhere = await kit.as(org.bookkeeper, () => bills.createProjectVendorBill({ projectId: org.homes[0].projectId, input: { company_id: authorityId, bill_number: "CC-ELSEWHERE", bill_date: day(-3), total_cents: 30000,
    actual_lines: [{ description: "Re-inspection", amount_cents: 30000, project_id: org.homes[0].projectId }] } }))
  observed.linkAnotherHomesBill = await attempt(() => kit.as(org.team.starts, () => permits.linkPermitFeePayment({ feeId: other, vendorBillId: elsewhere.id })))
  // Assessed wrong: voided with its reason and assessed again; both stay on the record.
  await kit.as(org.team.starts, () => permits.voidPermitFee({ feeId: other, reason: "The county assessed the re-inspection twice" }))
  await d.fee(applicationId, { kind: "other", amountCents: 25000, description: "Re-inspection", replacesFeeId: other })
  observed.reassessed = kit.rows(`select status, amount_cents::int as cents, replaces_fee_id is not null replaces from public.permit_fees where application_id=${kit.q(applicationId)} and kind='other' order by created_at`)
  observed.final = await position()
  observed.approveOncePreIssuanceFeesPaid = await approveTooEarly()
  check.equal("each fee shows what was obligated against what its linked payables paid: a counter expense counts once approved, a bill as it is paid; the jurisdiction becomes a vendor by being paid; the approval waits for the fees due before issuance and not the impact fee; a linked bill keeps its amount and cannot be deleted; another home's payable is refused; a fee is corrected by voiding and re-assessing", expected.expected, observed)
  return { orgId: org.orgId, applicationId, vendorBillId, projectExpenseId: counter.projectExpenseId }
}

// ---------------------------------------------------------------------------
// 5. EP06-08: a start needs the approved permit for the lot's plan, under the community's
//    authority, with its issued plans; it is never waived and the gate never switched off.

async function startsRequireTheRightPermit(kit, expected, check) {
  const { org } = await world(kit)
  const d = desk(kit, org), starts = app("starts"), lots = app("lots"), generation = app("po-generation")
  const plan = org.plans[0], lot = org.lots[6]
  await kit.as(org.team.starts, () => lots.assignPlanToLot(lot.id, { versionId: plan.versionId, elevationId: plan.elevationIds[0] }))
  const pkg = await kit.as(org.team.starts, () => starts.openStartPackage(lot.id, { isFinanced: false }))
  const projectId = one(kit, `select project_id from public.start_packages where id=${kit.q(pkg.id)}`).project_id
  const gates = async () => {
    const rows = await kit.as(org.team.starts, () => starts.refreshAutoGates(pkg.id))
    const of = (key) => rows.find((gate) => gate.key === key)
    return { permit: of("permit").status, plotPlan: of("plot_plan").status, permitWaivable: of("permit").waivable }
  }
  const permitGateId = (await kit.as(org.team.starts, () => starts.getStartPackage(pkg.id))).gates.find((gate) => gate.key === "permit").id
  const observed = { opened: await gates() }
  observed.waive = await attempt(() => kit.as(org.team.starts, () => starts.waiveGate(pkg.id, permitGateId, { reason: "The county issues it over the counter on start day" })))
  observed.attest = await attempt(() => kit.as(org.team.starts, () => starts.attestGate(pkg.id, permitGateId, { notes: "Permit 26-0412" })))
  const deactivate = (supabase) => supabase.from("start_gate_definitions").update({ is_active: false }).eq("org_id", org.orgId).eq("key", "permit").select("id")
  observed.coordinatorSwitchesTheGateOff = await rest(kit, org.team.starts, deactivate)
  observed.viewerSwitchesTheGateOff = await kit.as(org.viewer, async () => {
    const { supabase } = await context().requireOrgContext()
    const { data, error } = await deactivate(supabase)
    return error ? error.message : `${data.length} rows changed`
  })

  // Approved by the wrong authority: the city, not the community's county.
  kit.sql(`insert into public.companies(id,org_id,name) values(${kit.q(randomUUID())},${kit.q(org.orgId)},'City of Naples Building Division')`)
  const city = one(kit, `select id from public.companies where org_id=${kit.q(org.orgId)} and name='City of Naples Building Division'`).id
  const approveRevision = async (supersedesId, jurisdictionCompanyId, { submittedOn, number, expiresOn = null, issuedOn = null }) => {
    const id = await d.open(projectId, { jurisdictionCompanyId, supersedesId })
    await attachMissing(kit, org, d, id, projectId)
    await d.submit(id, submittedOn)
    await d.decide(id, { permitNumber: number, expiresOn, issuedOn, ...decisionFiles(kit, org, projectId) })
    return id
  }
  const cityPermit = await approveRevision(null, city, { submittedOn: day(-40), number: "NAP-26-77" })
  observed.otherAuthority = (await gates()).permit
  // Approved by the county, but expired yesterday.
  const expired = await approveRevision(cityPermit, org.permitAuthorityId, { submittedOn: day(-38), number: "BLD-26-1007", issuedOn: day(-30), expiresOn: day(-1) })
  observed.expired = (await gates()).permit
  const current = await approveRevision(expired, org.permitAuthorityId, { submittedOn: day(-20), number: "BLD-26-1007-R1" })
  observed.approved = await gates()
  // The lot's elevation changes (fixture: the plan-change review is PROD-01's subject): the approval no longer names the plan to build.
  kit.sql(`update public.lots set house_plan_elevation_id=${kit.q(plan.elevationIds[1])} where id=${kit.q(lot.id)}`)
  observed.afterPinMoves = (await gates()).permit
  await approveRevision(current, org.permitAuthorityId, { submittedOn: day(-3), number: "BLD-26-1007-R2" })
  observed.revisionApproved = (await gates()).permit
  observed.applications = kit.rows(`select permit_number, decision, superseded_at is not null superseded from public.permit_applications where project_id=${kit.q(projectId)} order by created_at`)

  // The rest of the start: a spec home waives its selections, the price book is run, final approval, release.
  await kit.as(org.team.starts, () => generation.generatePurchaseOrders({ projectId, mode: "dry_run" }))
  const rows = await kit.as(org.team.starts, () => starts.refreshAutoGates(pkg.id))
  const gateId = (key) => rows.find((gate) => gate.key === key).id
  await kit.as(org.team.starts, () => starts.waiveGate(pkg.id, gateId("selections_locked"), { reason: "Spec home: the builder makes the selections, no buyer to lock them." }))
  await kit.as(org.team.starts, () => starts.attestGate(pkg.id, gateId("final_approval"), { notes: "Approved for the week's release" }))
  const released = await seed.releaseHome(kit, org, { packageId: pkg.id, projectId })
  observed.released = released.released.status
  check.equal("a package waits on the permit gate until the live building application for its lot is approved by the community's authority for the plan pinned today, unexpired, with its issued permit and plans on file; the gate cannot be waived, attested or switched off by any member; a pin change reopens it until the revision is approved; release re-derives it and proceeds", expected.expected, observed)
  return { orgId: org.orgId, packageId: pkg.id, projectId }
}

module.exports = {
  id: "PERMIT-01",
  subcases: {
    "application-needs-its-documents": applicationNeedsItsDocuments,
    "corrections-keep-history": correctionsKeepHistory,
    "coordinator-queue-shows-overdue-and-unresolved": coordinatorQueueShowsOverdueAndUnresolved,
    "fees-reconcile-to-payments": feesReconcileToPayments,
    "starts-require-the-right-permit": startsRequireTheRightPermit,
  },
}
