// DELAY-01 — a sold home whose permit and supply run late (EP14-04). One production builder,
// one home on lot 2, each step by the role that owns it through Arc's real services:
//
//   permit-delay-holds-the-start-and-flags-close-risk
//                                   the permit decision is overdue: the permit gate holds the package (it cannot be
//                                   attested past), the release is refused, the permit queue shows the decision
//                                   overdue, and the starts desk reports the promised close at risk on the permit
//   delayed-start-moves-its-capacity-week
//                                   the starts desk moves the start a week; the permit lands, the house releases into
//                                   the new week's slot and the original week's slot is left unfilled
//   late-delivery-opens-one-shortage
//                                   the framing order's need-by date passes undelivered: the sweep opens one late
//                                   shortage however often it runs, and the schedule is not moved by it
//   late-delivery-advises-the-released-schedule
//                                   the release codes each trade task from the template; a late concrete line advises the
//                                   foundation, which starts within the window, and the late framing lines wait
//   slip-pushes-dependents-and-guards-the-close
//                                   the release wrote the template's task logic; framing slipping forty days pushes the
//                                   work that follows it and the move needs the promised close accepted
//   moving-past-the-promised-close-needs-acceptance
//                                   moving the home's last task past its promised close is refused to a superintendent
//                                   and to an unacknowledged move; a starts coordinator who accepts it with a reason
//                                   moves it; the promised close itself is never rewritten
//   approved-change-order-amends-price-and-budget-once
//                                   a buyer change order is refused without the signed copy; approved, it amends the
//                                   agreement once, the closing prices it once, and it revises the budget once
//   change-order-delay-reaches-the-schedule
//                                   the approved change order's ten days reach the schedule as a pending impact on the
//                                   framing task (its cost code), which the superintendent applies once
//
// The subcases share one organisation and one home, staged once. Expected values are in expected/DELAY-01.json.
const seed = require("../production-seed.cjs")
const { app } = require("./shared.cjs")
const fx = require("./lot-01-sales-fixtures.cjs")

const attempt = (work) => work().then(() => "done", (error) => error.message)
const DAY = 86400000
const monday = (iso) => { const day = new Date(`${iso}T12:00:00Z`); day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7)); return day.toISOString().slice(0, 10) }
const daysFromToday = (iso) => Math.round((Date.parse(`${iso}T12:00:00Z`) - Date.parse(`${seed.isoDay(0)}T12:00:00Z`)) / DAY)

const STAGES = new WeakMap()
function stage(kit, name) {
  const state = STAGES.get(kit) ?? (STAGES.set(kit, { done: new Map() }), STAGES.get(kit))
  if (!state.done.has(name)) state.done.set(name, STEPS[name](kit, state))
  return state.done.get(name)
}
const scheduleOf = (kit, projectId) => kit.rows(`select id, name, start_date::text s, end_date::text e from public.schedule_items where project_id=${kit.q(projectId)} order by start_date, name`)
const closingOf = (kit, projectId) => kit.rows(`select id, status, scheduled_date::text d from public.closings where project_id=${kit.q(projectId)} and status<>'cancelled'`)[0]

const STEPS = {
  /** The sold home, its promised close, and a start package waiting on an overdue permit decision. */
  async waiting(kit, state) {
    const org = state.org = await seed.productionBuilder(kit, { name: "DELAY-01 delayed home" })
    await seed.seedCommunity(kit, org)
    await seed.seedProduct(kit, org)
    await seed.takeDownTranche(kit, org)
    const permits = app("permits"), starts = app("starts")
    const thisWeek = monday(seed.isoDay(0)), nextWeek = new Date(Date.parse(`${thisWeek}T12:00:00Z`) + 7 * DAY).toISOString().slice(0, 10)
    for (const week of [thisWeek, nextWeek]) await kit.as(org.owner, () => app("even-flow").setReleaseSlot(org.communityId, week, { targetStarts: 1, notes: "DELAY-01 drumbeat" }))
    const lot = org.lots[1]
    const buyer = await fx.reservedBuyer(kit, org, { name: "Celia Baptiste", depositCents: 2000000, receivedOn: "2026-06-11", lot })
    const sale = await fx.agreementFor(kit, org, buyer)
    await seed.chooseDesign(kit, org, { projectId: sale.projectId })
    const closing = closingOf(kit, sale.projectId)
    await kit.as(org.owner, () => app("closings").scheduleClosing({ closingId: closing.id, scheduledDate: seed.isoDay(150) }))
    // The start: everything a person owns is cleared except the permit, submitted 45 days ago and still undecided.
    const pkg = await kit.as(org.team.starts, () => starts.openStartPackage(lot.id, { isFinanced: false, targetWeek: thisWeek }))
    await seed.proveFinancing(kit, org, { projectId: sale.projectId })
    await kit.as(org.team.starts, () => starts.setProjectSuperintendent(sale.projectId, org.team.superintendent.userId))
    await kit.as(org.owner, () => permits.setCommunityPermitAuthority({ communityId: org.communityId, companyId: seed.permitAuthority(kit, org) }))
    const { applicationId } = await kit.as(org.team.starts, () => permits.createPermitApplication({ projectId: sale.projectId, jurisdictionCompanyId: seed.permitAuthority(kit, org), permitType: "building" }))
    await kit.as(org.team.starts, () => permits.setPermitDocument({ applicationId, documentKind: "plot_plan", fileId: seed.homeFile(kit, org, sale.projectId, "plot-plan.pdf") }))
    await kit.as(org.team.starts, () => permits.recordPermitSubmission({ applicationId, submittedOn: seed.isoDay(-45), reference: "CYP-PLAN-REVIEW" }))
    await kit.as(org.team.starts, () => app("po-generation").generatePurchaseOrders({ projectId: sale.projectId, mode: "dry_run" }))
    const gates = await kit.as(org.team.starts, () => starts.refreshAutoGates(pkg.id))
    const finalApproval = await attempt(() => kit.as(org.team.starts, () => starts.attestGate(pkg.id, gates.find((gate) => gate.key === "final_approval").id, { notes: "Approved for the week's release" })))
    const release = await attempt(() => kit.as(org.team.starts, () => starts.releaseStart(pkg.id, { scheduledStartDate: thisWeek < seed.isoDay(0) ? seed.isoDay(0) : thisWeek })))
    return { org, lot, buyer, sale, projectId: sale.projectId, contractId: sale.contractId, closingId: closing.id, packageId: pkg.id, applicationId, thisWeek, nextWeek, gates, finalApproval, release }
  },

  /** The starts desk moves the start a week; the permit is approved; the house releases into the new week. */
  async released(kit) {
    const w = await stage(kit, "waiting")
    const { org } = w
    const starts = app("starts"), permits = app("permits")
    const moved = await kit.as(org.team.starts, () => starts.updateStartPackage(w.packageId, { targetWeek: w.nextWeek, scheduledStartDate: w.nextWeek }))
    await kit.as(org.team.starts, () => permits.recordPermitDecision({
      applicationId: w.applicationId, decision: "approved", decidedOn: seed.isoDay(0), permitNumber: `BLD-${w.projectId.slice(0, 8).toUpperCase()}`,
      issuedPermitFileId: seed.homeFile(kit, org, w.projectId, "building-permit.pdf"), approvedPlansFileId: seed.homeFile(kit, org, w.projectId, "approved-plans.pdf"),
    }))
    const gates = await kit.as(org.team.starts, () => starts.refreshAutoGates(w.packageId))
    await kit.as(org.team.starts, () => starts.attestGate(w.packageId, gates.find((gate) => gate.key === "final_approval").id, { notes: "Permit issued; approved for next week's release" }))
    const release = await seed.releaseHome(kit, org, { packageId: w.packageId, projectId: w.projectId, startInDays: daysFromToday(w.nextWeek) })
    await kit.drainOutbox(org.orgId)
    // The trades hold their orders: purchasing approves each one the release drafted.
    for (const order of kit.rows(`select id from public.commitments where project_id=${kit.q(w.projectId)} and commitment_type='purchase_order' and status='draft' order by contract_number`))
      await kit.as(org.owner, () => app("commitments").updateCommitment({ commitmentId: order.id, input: { status: "approved", prequal_override_note: "Acceptance trade: no prequalification on file for this vendor." } }))
    return { moved, release }
  },

  /** The framing order's lines were needed two days ago and have not arrived. */
  async late(kit) {
    const w = await stage(kit, "waiting")
    await stage(kit, "released")
    const { org } = w
    const receipts = app("po-receipts")
    const framing = kit.rows(`select l.id from public.commitment_lines l join public.commitments c on c.id=l.commitment_id
      where c.project_id=${kit.q(w.projectId)} and c.commitment_type='purchase_order' and c.company_id=${kit.q(org.vendorIds["Palmetto Framing"])} order by l.sort_order, l.id`)
    for (const line of framing) await kit.as(org.team.purchasing, () => receipts.setLineNeededBy({ commitmentLineId: line.id, neededBy: seed.isoDay(-2) }))
    const before = scheduleOf(kit, w.projectId)
    await kit.service(() => receipts.sweepLateDeliveries())
    await kit.service(() => receipts.sweepLateDeliveries())
    const after = scheduleOf(kit, w.projectId)
    const advisories = await kit.as(org.team.superintendent, () => receipts.listHomeDeliveryAdvisories(w.projectId))
    return { framingLines: framing.length, before, after, advisories }
  },
}

async function permitDelayHoldsTheStart(kit, expected, check) {
  const w = await stage(kit, "waiting")
  const { org } = w
  const [row] = (await kit.as(org.team.starts, () => app("starts").listStartPackages({ id: w.packageId }))).packages
  const queue = await kit.as(org.team.starts, () => app("permits").listPermitQueue({ communityId: org.communityId }))
  const permit = queue.rows.find((item) => item.projectId === w.projectId)
  check.equal("an overdue permit holds the start: the gate cannot be attested past, the release is refused, the queue shows the decision overdue and the starts desk says the promised close is at risk on the permit", expected.expected, {
    permitGate: w.gates.find((gate) => gate.key === "permit").status,
    finalApproval: /gate|permit|order|before/i.test(w.finalApproval) && w.finalApproval !== "done" ? "refused" : w.finalApproval,
    release: w.release,
    package: { status: row.status, blocker: row.blocker?.key ?? null, risk: row.risk, mustStartInDays: row.mustStartBy ? daysFromToday(row.mustStartBy) : null, cycleDays: row.cycleDays },
    permitQueue: permit ? { attention: permit.aging.attention, decisionDaysLate: permit.aging.decision ? -permit.aging.decision.daysOut : null, startTargetWeekIsThisWeek: permit.startTargetWeek === w.thisWeek } : "missing",
  })
  return { orgId: org.orgId, projectId: w.projectId, packageId: w.packageId, finalApproval: w.finalApproval }
}

async function delayedStartMovesItsCapacityWeek(kit, expected, check) {
  const w = await stage(kit, "waiting")
  const r = await stage(kit, "released")
  const { org } = w
  const weeks = await kit.as(org.owner, () => app("even-flow").getEvenFlowAdherence({ communityId: org.communityId, from: w.thisWeek, to: w.nextWeek }))
  const week = (start) => { const slot = weeks.find((item) => item.weekStart === start); return slot ? { planned: slot.plannedStarts, started: slot.actualStarts } : "missing" }
  const pkg = kit.rows(`select status, target_week::text week, scheduled_start_date::text start from public.start_packages where id=${kit.q(w.packageId)}`)[0]
  const foundation = kit.rows(`select start_date::text s from public.schedule_items where project_id=${kit.q(w.projectId)} and name='Foundation'`)[0]
  check.equal("the starts desk moves the delayed start a week; once the permit lands the house releases into that week's slot, the original week is left unfilled, and the build starts on the new date", expected.expected, {
    movedTo: { targetWeekIsNextWeek: r.moved.targetWeek === w.nextWeek },
    package: { status: pkg.status, targetWeekIsNextWeek: pkg.week === w.nextWeek, startsOnNextWeek: pkg.start === w.nextWeek },
    capacity: { thisWeek: week(w.thisWeek), nextWeek: week(w.nextWeek) },
    foundationStartsOnTheReleaseDate: foundation?.s === w.nextWeek,
  })
  return { orgId: org.orgId, projectId: w.projectId }
}

async function lateDeliveryOpensOneShortage(kit, expected, check) {
  const w = await stage(kit, "waiting")
  const l = await stage(kit, "late")
  const shortages = kit.rows(`select s.reason, s.status from public.po_shortages s join public.commitments c on c.id=s.commitment_id where c.project_id=${kit.q(w.projectId)} order by s.created_at`)
  check.equal("the framing lines pass their need-by date undelivered: the sweep, run twice, opens one late shortage per line and the schedule is not moved by it", expected.expected, {
    framingLines: l.framingLines,
    shortages,
    scheduleUnchanged: JSON.stringify(l.before) === JSON.stringify(l.after),
  })
  return { orgId: w.org.orgId, projectId: w.projectId }
}

async function lateDeliveryAdvisesTheReleasedSchedule(kit, expected, check) {
  const w = await stage(kit, "waiting")
  const l = await stage(kit, "late")
  const { org } = w
  const receipts = app("po-receipts")
  // The foundation's concrete is late too, and the foundation starts within the advisory window.
  const concrete = kit.rows(`select l.id from public.commitment_lines l join public.commitments c on c.id=l.commitment_id
    where c.project_id=${kit.q(w.projectId)} and c.commitment_type='purchase_order' and c.company_id=${kit.q(org.vendorIds["Gulf Concrete"])} order by l.sort_order, l.id`)
  for (const line of concrete) await kit.as(org.team.purchasing, () => receipts.setLineNeededBy({ commitmentLineId: line.id, neededBy: seed.isoDay(-2) }))
  await kit.service(() => receipts.sweepLateDeliveries())
  const advisories = await kit.as(org.team.superintendent, () => receipts.listHomeDeliveryAdvisories(w.projectId))
  const task = (name) => kit.rows(`select cost_code_id, start_date::text s from public.schedule_items where project_id=${kit.q(w.projectId)} and name=${kit.q(name)}`)[0]
  const codeOf = (row) => Object.entries(org.costCodeIds).find(([, id]) => id === row.cost_code_id)?.[0] ?? row.cost_code_id
  check.equal("a late order line advises the released home's task under its cost code once that task starts within the window; the framing task, weeks out, is not yet advised", expected.expected, {
    taskCostCodes: { Foundation: codeOf(task("Foundation")), Framing: codeOf(task("Framing")) },
    framingStartsPastTheWindow: daysFromToday(task("Framing").s) > require("../../../lib/purchasing/delivery-advisory").ADVISORY_WINDOW_DAYS,
    framingLateLinesAdvised: (l.advisories ?? []).length,
    advisories: (advisories ?? []).map((advisory) => ({ task: advisory.scheduleItemName, state: advisory.state })),
  })
  return { orgId: org.orgId, projectId: w.projectId }
}

async function slipPushesDependentsAndGuardsTheClose(kit, expected, check) {
  const w = await stage(kit, "waiting")
  await stage(kit, "released")
  const { org } = w
  const schedule = app("schedule")
  const before = scheduleOf(kit, w.projectId)
  const framing = before.find((item) => item.name === "Framing")
  const shift = (iso, days) => new Date(Date.parse(`${iso}T12:00:00Z`) + days * DAY).toISOString().slice(0, 10)
  const move = [{ id: framing.id, start_date: shift(framing.s, expected.inputs.slipDays), end_date: shift(framing.e, expected.inputs.slipDays) }]
  const preview = await kit.as(org.team.starts, () => schedule.previewScheduleReschedule(move))
  // The move is only previewed and refused here: the later subcases read the home's dates as released.
  const unacknowledged = await attempt(() => kit.as(org.team.starts, () => schedule.bulkUpdateScheduleItems({ items: move })))
  const after = scheduleOf(kit, w.projectId)
  const dependencies = Number(kit.rows(`select count(*)::int n from public.schedule_dependencies where project_id=${kit.q(w.projectId)}`)[0].n)
  const punch = before.find((item) => item.name === "Punch and close")
  const punchChange = preview.changes.find((change) => change.id === punch.id)
  check.equal("framing slipping forty days pushes the work that follows it, and the move cannot pass the promised close without a starts coordinator accepting it", expected.expected, {
    dependencies,
    previewMoves: preview.changes.map((change) => change.name),
    passesThePromisedClose: preview.closeImpacts.length === 1,
    unacknowledgedMove: /pushes the promised close/.test(unacknowledged) ? "refused: accept the close impact" : unacknowledged,
    punchPushedDays: punchChange ? Math.round((Date.parse(`${punchChange.newStart}T12:00:00Z`) - Date.parse(`${punch.s}T12:00:00Z`)) / DAY) : 0,
    refusedMoveChangedNothing: JSON.stringify(after) === JSON.stringify(before),
  })
  return { orgId: org.orgId, projectId: w.projectId }
}

async function movingPastThePromisedCloseNeedsAcceptance(kit, expected, check) {
  const w = await stage(kit, "waiting")
  await stage(kit, "released")
  const { org } = w
  const schedule = app("schedule")
  const punch = scheduleOf(kit, w.projectId).find((item) => item.name === "Punch and close")
  const move = [{ id: punch.id, start_date: seed.isoDay(expected.inputs.punchStartsInDays), end_date: seed.isoDay(expected.inputs.punchStartsInDays + 13) }]
  const preview = await kit.as(org.team.starts, () => schedule.previewScheduleReschedule(move))
  const reason = "Framing crew lost two weeks to the late lumber delivery"
  const noticeJobs = () => Number(kit.rows(`select count(*)::int n from public.outbox where org_id=${kit.q(org.orgId)} and job_type='schedule_reschedule_notify' and payload::text like ${kit.q(`%${w.projectId}%`)}`)[0].n)
  const jobsBefore = noticeJobs()
  const superintendent = await attempt(() => kit.as(org.team.superintendent, () => schedule.bulkUpdateScheduleItems({ items: move, acknowledge_close_impacts: [w.projectId], reason })))
  const unacknowledged = await attempt(() => kit.as(org.team.starts, () => schedule.bulkUpdateScheduleItems({ items: move })))
  const unexplained = await attempt(() => kit.as(org.team.starts, () => schedule.bulkUpdateScheduleItems({ items: move, acknowledge_close_impacts: [w.projectId] })))
  const accepted = await attempt(() => kit.as(org.team.starts, () => schedule.bulkUpdateScheduleItems({ items: move, acknowledge_close_impacts: [w.projectId], reason })))
  const after = kit.rows(`select start_date::text s, end_date::text e from public.schedule_items where id=${kit.q(punch.id)}`)[0]
  const audits = kit.rows(`select after_data from public.audit_log where entity_id=${kit.q(punch.id)} and source='schedule.bulk_update' and after_data->>'start_date'=${kit.q(seed.isoDay(expected.inputs.punchStartsInDays))}`)
  const notices = noticeJobs() - jobsBefore
  check.equal("moving the home's last task past its promised close is refused to a superintendent and to a move that does not accept it or say why; a starts coordinator who accepts it with a reason moves it once, and the promised close is not rewritten", expected.expected, {
    preview: { closeImpacts: preview.closeImpacts.map((impact) => ({ daysLate: impact.daysLate })), canApprove: preview.canApproveCloseImpacts },
    superintendent: /starts coordinator \(start\.release\)/.test(superintendent) ? "refused: start.release" : superintendent,
    unacknowledged: /pushes the promised close/.test(unacknowledged) ? "refused: accept the close impact" : unacknowledged,
    unexplained: /Say why/.test(unexplained) ? "refused: a reason" : unexplained,
    accepted,
    moved: { startsInDays: daysFromToday(after.s), endsInDays: daysFromToday(after.e) },
    audited: audits.length,
    tradeNoticeJobs: notices,
    promisedClose: { inDays: daysFromToday(closingOf(kit, w.projectId).d), status: closingOf(kit, w.projectId).status },
  })
  return { orgId: org.orgId, projectId: w.projectId }
}

/** The buyer's change order on the released home, staged once: price, budget and schedule are read from it. */
function changeOrder(kit) {
  const state = STAGES.get(kit)
  if (!state.changeOrder) state.changeOrder = (async () => {
    const w = await stage(kit, "waiting")
    await stage(kit, "released")
    const { org } = w
    const changes = app("change-orders")
    const finishBefore = scheduleOf(kit, w.projectId).reduce((latest, item) => (item.e > latest ? item.e : latest), "")
    const co = await kit.as(org.owner, () => changes.createChangeOrder({ input: { project_id: w.projectId, title: "Add screened lanai", summary: "Buyer added a screened lanai after the start",
      tax_rate: 0, markup_percent: 0, markup_mode: "percent", requires_signature: true, days_impact: 10,
      lines: [{ description: "Screened lanai", quantity: 1, unit_cost: 12000, internal_cost_cents: 800000, cost_code_id: org.costCodeIds["06-100"], taxable: false }] } }))
    const unsigned = await attempt(() => kit.as(org.owner, () => changes.approveChangeOrder({ changeOrderId: co.id, approval: { signerName: "Celia Baptiste", note: "Agreed by phone" } })))
    const signedFileId = seed.signedCopyFile(kit, org, w.projectId, "screened-lanai-signed.pdf")
    await kit.as(org.owner, () => changes.approveChangeOrder({ changeOrderId: co.id, approval: { signerName: "Celia Baptiste", note: "Signed at the design center", signedFileId } }))
    await kit.drainOutbox(org.orgId)
    return { w, co, unsigned, finishBefore }
  })()
  return state.changeOrder
}

async function approvedChangeOrderAmendsPriceAndBudgetOnce(kit, expected, check) {
  await stage(kit, "waiting")
  const { w, co, unsigned } = await changeOrder(kit)
  const { org } = w
  const versions = kit.rows(`select v.kind, v.price_delta_cents::bigint delta, v.authorized_total_cents::bigint total from public.purchase_agreement_versions v where v.contract_id=${kit.q(w.contractId)} order by v.version_number`)
  const original = versions.find((row) => row.kind === "original")
  const preview = await kit.as(org.owner, () => app("closings").buildSettlement(w.closingId))
  const revisions = kit.rows(`select total_cents::bigint total from public.budget_revisions where change_order_id=${kit.q(co.id)}`)
  check.equal("the buyer's change order is refused without the signed copy; approved, it amends the agreement once, the closing prices it once and the budget is revised once", expected.expected, {
    unsignedApproval: /signed/i.test(unsigned) ? "refused: needs the signed copy" : unsigned,
    amendments: versions.filter((row) => row.kind !== "original").map((row) => ({ kind: row.kind, deltaCents: Number(row.delta), authorizedAboveOriginalCents: Number(row.total) - Number(original.total) })),
    settlement: { approvedChangeOrdersCents: preview.components.approvedChangeOrdersCents, finalAboveAgreementCents: preview.finalPriceCents - preview.components.agreementTotalCents },
    budgetRevisions: revisions.map((row) => Number(row.total)),
  })
  return { orgId: org.orgId, projectId: w.projectId, changeOrderId: co.id }
}

async function changeOrderDelayReachesTheSchedule(kit, expected, check) {
  await stage(kit, "waiting")
  const { w, co, finishBefore } = await changeOrder(kit)
  const impactsOf = () => kit.rows(`select i.id, i.days_adjusted, i.applied_at is not null applied, s.name task, s.start_date::text s from public.schedule_item_change_orders i
    join public.schedule_items s on s.id=i.schedule_item_id where i.change_order_id=${kit.q(co.id)}`)
  const pending = impactsOf()
  const finishAfterApproval = scheduleOf(kit, w.projectId).reduce((latest, item) => (item.e > latest ? item.e : latest), "")
  // The superintendent applies it, once.
  const schedule = app("schedule")
  const applied = pending[0] ? await attempt(() => kit.as(w.org.team.superintendent, () => schedule.applyScheduleChangeOrderImpact(pending[0].id))) : "no impact"
  const again = pending[0] ? await attempt(() => kit.as(w.org.team.superintendent, () => schedule.applyScheduleChangeOrderImpact(pending[0].id))) : "no impact"
  const [after] = impactsOf()
  check.equal("the approved change order's ten days reach the schedule as a pending impact on the task under its cost code, which the superintendent applies once", expected.expected, {
    daysImpact: Number(kit.rows(`select days_impact from public.change_orders where id=${kit.q(co.id)}`)[0].days_impact),
    pendingScheduleImpacts: pending.map((row) => ({ task: row.task, days: row.days_adjusted, applied: row.applied })),
    approvalMovedNothing: finishAfterApproval === finishBefore,
    superintendentApplies: applied,
    appliedTwice: /already applied/.test(again) ? "refused: already applied" : again,
    taskMovedDays: after ? Math.round((Date.parse(`${after.s}T12:00:00Z`) - Date.parse(`${pending[0].s}T12:00:00Z`)) / DAY) : null,
  })
  return { orgId: w.org.orgId, projectId: w.projectId, changeOrderId: co.id }
}

module.exports = {
  subcases: {
    "permit-delay-holds-the-start-and-flags-close-risk": permitDelayHoldsTheStart,
    "delayed-start-moves-its-capacity-week": delayedStartMovesItsCapacityWeek,
    "late-delivery-opens-one-shortage": lateDeliveryOpensOneShortage,
    "late-delivery-advises-the-released-schedule": lateDeliveryAdvisesTheReleasedSchedule,
    "slip-pushes-dependents-and-guards-the-close": slipPushesDependentsAndGuardsTheClose,
    "moving-past-the-promised-close-needs-acceptance": movingPastThePromisedCloseNeedsAcceptance,
    "approved-change-order-amends-price-and-budget-once": approvedChangeOrderAmendsPriceAndBudgetOnce,
    "change-order-delay-reaches-the-schedule": changeOrderDelayReachesTheSchedule,
  },
}
