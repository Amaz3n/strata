// SUPPLY-01 subcases for EP08-10 (material delivery and shortage workflow). Composed into supply-01.cjs
// by the lead; each subcase is `async (kit, expected, check)` and acts through `kit.as`, so permissions
// and row security are the real ones:
//
//   partial-receipts-and-shortage-by-home-and-line     two partial tickets and a close-short give received / outstanding / shortage by line for one home; the second home is untouched; untracked lines stay off the desk
//   receipts-are-written-only-through-the-service      a member's data-API writes to receipts, receipt lines and shortages are refused; the service path records them (audit and event once each)
//   receipt-capture-is-idempotent-and-races            the same key twice and from two sessions is one receipt; two keys racing for the last unit yield one acceptance and one over-receipt refusal
//   late-delivery-sweep-opens-one-shortage-and-an-advisory
//                                                      an overdue line gets one late shortage however often the sweep runs (one notification), the home's task on the same cost code gets an advisory, the schedule is not written, a full receipt closes both
//   shortage-resolution-reaches-purchasing             back-order restarts the clock, a VPO is raised and linked, accept-short stops the sweep; a reader without po_exception.resolve and a coordinator of another division are refused
//   deliveries-desk-is-scoped-and-capped               the desk shows the reader's divisions only, with the total when the page is cut; a role without price_book.read is refused
//
// Fixture: one production builder (`supplyOrg`, built once per run) with two divisions. Every home is a
// project in division A with the superintendent as a project member, an approved purchase order, and
// a framing task on the cost code the order's lines carry. SQL is used only for those fixture rows (the
// stack has no service that writes an approved order and its schedule in one step), for the member's
// direct data-API attempts the database must refuse, and for reads that check outcomes. Dates are days
// from today so expectations do not depend on the day the stack runs.
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const { app } = require("./shared.cjs")

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value
const equal = (check, label, expected, observed) => check.equal(label, canonical(expected), canonical(observed))
const attempt = async (work) => { try { await work(); return "allowed" } catch (error) { return error.issues ? `invalid: ${error.issues.map((issue) => issue.message).join("; ")}` : error.message } }
const labelled = (outcome, pattern, label = "refused") => outcome === "allowed" ? "allowed" : pattern.test(outcome) ? label : String(outcome).slice(0, 300)
const day = (offset) => seed.isoDay(offset)
const receipts = () => app("po-receipts")

/** A write through the member's own session, as PostgREST would run it. */
async function viaDataApi(kit, actor, write) {
  return attempt(() => kit.as(actor, async () => {
    const { supabase } = await require("../../../lib/services/context").requireOrgContext()
    const { data, error } = await write(supabase)
    if (error) throw new Error(/42501|permission denied|row-level security/i.test(`${error.code} ${error.message}`) ? "refused" : error.message)
    if (Array.isArray(data) && data.length === 0) throw new Error("refused: no row visible to change")
  }))
}

const SUPPLY_ORGS = new WeakMap()
async function supplyOrg(kit) {
  if (!SUPPLY_ORGS.has(kit)) SUPPLY_ORGS.set(kit, (async () => {
    const org = await seed.productionBuilder(kit, { name: "SUPPLY-01 delivery" })
    org.divisions = { a: randomUUID(), b: randomUUID() }
    kit.sql(`insert into public.divisions(id,org_id,name) values(${kit.q(org.divisions.a)},${kit.q(org.orgId)},'SUPPLY-01 A'),(${kit.q(org.divisions.b)},${kit.q(org.orgId)},'SUPPLY-01 B');`)
    // A purchasing manager who works division B only: the division wall, not a missing permission, refuses them.
    const scoped = kit.addMember(org, "org_purchasing_manager", {})
    const membership = kit.rows(`select id from public.memberships where org_id=${kit.q(org.orgId)} and user_id=${kit.q(scoped.userId)}`)[0].id
    kit.sql(`update public.memberships set division_scope='assigned' where id=${kit.q(membership)}; insert into public.membership_divisions(membership_id,division_id) values(${kit.q(membership)},${kit.q(org.divisions.b)});`)
    org.divisionBBuyer = scoped
    return org
  })())
  return SUPPLY_ORGS.get(kit)
}

/** A home in division A with an approved order of lines that carry no need-by date yet, and a task on their cost code. */
function home(kit, org, label, { lines = [["Studs", 100]], taskStartsIn = 3 } = {}) {
  const { q } = kit
  const tag = randomUUID().slice(0, 8)
  const projectId = randomUUID(), orderId = randomUUID(), taskId = randomUUID()
  const costCodeId = Object.values(org.costCodeIds)[0]
  const vendorId = Object.values(org.vendorIds)[0]
  const lineIds = lines.map(() => randomUUID())
  const superintendentRole = kit.rows(`select id from public.roles where key='org_superintendent'`)[0].id
  kit.sql([
    "begin;",
    `insert into public.projects(id,org_id,name,property_type,status,division_id) values(${q(projectId)},${q(org.orgId)},${q(`${label} ${tag}`)},'production','active',${q(org.divisions.a)});`,
    `insert into public.project_members(org_id,project_id,user_id,role_id) values(${q(org.orgId)},${q(projectId)},${q(org.team.superintendent.userId)},${q(superintendentRole)});`,
    `insert into public.commitments(id,org_id,project_id,company_id,title,commitment_type,status) values(${q(orderId)},${q(org.orgId)},${q(projectId)},${q(vendorId)},${q(`Framing package ${tag}`)},'purchase_order','draft');`,
    ...lines.map(([description, quantity], index) =>
      `insert into public.commitment_lines(id,org_id,commitment_id,description,quantity,unit,unit_cost_cents,cost_code_id,sort_order) values(${q(lineIds[index])},${q(org.orgId)},${q(orderId)},${q(description)},${quantity},'ea',500,${q(costCodeId)},${index});`),
    `update public.commitments set status='approved' where id=${q(orderId)};`,
    `insert into public.schedule_items(id,org_id,project_id,name,trade,status,start_date,end_date,cost_code_id) values(${q(taskId)},${q(org.orgId)},${q(projectId)},${q(`Framing ${tag}`)},'framing','planned',${q(day(taskStartsIn))},${q(day(taskStartsIn + 6))},${q(costCodeId)});`,
    "commit;",
  ].join("\n"))
  return { projectId, orderId, taskId, lineIds, tag }
}

const setNeededBy = (kit, org, h, offset, indexes = h.lineIds.map((_, index) => index)) => Promise.all(indexes.map((index) =>
  kit.as(org.team.purchasing, () => receipts().setLineNeededBy({ commitmentLineId: h.lineIds[index], neededBy: day(offset) }))))

const receive = (kit, org, h, quantities, { key = randomUUID(), condition = "ok", actor = org.team.superintendent, ticketNumber } = {}) =>
  kit.as(actor, () => receipts().recordPoReceipt({
    commitmentId: h.orderId, idempotencyKey: key, ticketNumber,
    lines: Object.entries(quantities).map(([index, quantity]) => ({ commitmentLineId: h.lineIds[Number(index)], quantity, condition })),
  }))

const desk = (kit, actor, filters = {}) => kit.as(actor, () => receipts().listPoDeliveries(filters))
const line = (row) => ({ ordered: row.ordered, received: row.received, outstanding: row.outstanding, state: row.state, shortage: row.shortageReason })
const mine = (rows, h) => rows.filter((row) => row.commitmentId === h.orderId)

async function partialReceiptsAndShortageByHomeAndLine(kit, expected, check) {
  const org = await supplyOrg(kit)
  const a = home(kit, org, "Lot 1", { lines: [["Studs", 100], ["Sheathing", 40], ["Framing labour", 1]] })
  const b = home(kit, org, "Lot 2", { lines: [["Studs", 80]] })
  // Purchasing dates the lines through the service, on orders that are already approved. The labour line gets none.
  await setNeededBy(kit, org, a, 5, [0, 1])
  await setNeededBy(kit, org, b, 5)
  await receive(kit, org, a, { 0: 30 }, { ticketNumber: "T-1" })
  await receive(kit, org, a, { 0: 20, 1: 40 }, { ticketNumber: "T-2" })
  await kit.as(org.team.superintendent, () => receipts().closePoLineShort({ commitmentLineId: a.lineIds[0], reason: "vendor_short", note: "Mill is out until next week" }))
  const rows = (await desk(kit, org.team.purchasing, { state: "all", pageSize: 100 })).rows
  const [studs, sheathing] = mine(rows, a).sort((x, y) => x.description.localeCompare(y.description)).reverse()
  const [secondHome] = mine(rows, b)
  const counts = kit.rows(`select
      (select count(*)::int from public.po_receipts where project_id=${kit.q(a.projectId)}) receipts,
      (select count(*)::int from public.audit_log where org_id=${kit.q(org.orgId)} and entity_type='po_receipt' and after_data->>'commitment_id'=${kit.q(a.orderId)}) audits,
      (select count(*)::int from public.events where org_id=${kit.q(org.orgId)} and event_type='po_receipt.recorded' and payload->>'commitment_id'=${kit.q(a.orderId)}) events,
      (select count(*)::int from public.po_shortages where project_id=${kit.q(a.projectId)}) shortages`)[0]
  equal(check, "two partial tickets and a close-short leave the studs 50 of 100 received and short, the sheathing received in full, and the other home untouched; the labour line is not tracked", expected.expected.byHomeAndLine, {
    studs: line(studs),
    sheathing: line(sheathing),
    secondHome: line(secondHome),
    tracked: { homeOne: mine(rows, a).length, homeTwo: mine(rows, b).length },
    receiptsAuditedAndAnnounced: { receipts: counts.receipts, audits: counts.audits, events: counts.events, shortages: counts.shortages },
  })
  return { orgId: org.orgId, projectId: a.projectId }
}

async function receiptsAreWrittenOnlyThroughTheService(kit, expected, check) {
  const org = await supplyOrg(kit)
  const h = home(kit, org, "Lot 3")
  await setNeededBy(kit, org, h, 5)
  const delivered = await receive(kit, org, h, { 0: 10 })
  const [receiptLine] = kit.rows(`select id from public.po_receipt_lines where receipt_id=${kit.q(delivered.id)}`)
  const forged = {
    superintendentInsertsReceipt: await viaDataApi(kit, org.team.superintendent, (db) => db.from("po_receipts").insert({ org_id: org.orgId, project_id: h.projectId, commitment_id: h.orderId, idempotency_key: randomUUID() }).select("id")),
    superintendentInsertsLine: await viaDataApi(kit, org.team.superintendent, (db) => db.from("po_receipt_lines").insert({ org_id: org.orgId, project_id: h.projectId, receipt_id: delivered.id, commitment_id: h.orderId, commitment_line_id: h.lineIds[0], quantity_received: 90 }).select("id")),
    superintendentEditsQuantity: await viaDataApi(kit, org.team.superintendent, (db) => db.from("po_receipt_lines").update({ quantity_received: 100 }).eq("id", receiptLine.id).select("id")),
    superintendentVoids: await viaDataApi(kit, org.team.superintendent, (db) => db.from("po_receipts").update({ status: "void" }).eq("id", delivered.id).select("id")),
    superintendentDeletes: await viaDataApi(kit, org.team.superintendent, (db) => db.from("po_receipts").delete().eq("id", delivered.id).select("id")),
    superintendentOpensShortage: await viaDataApi(kit, org.team.superintendent, (db) => db.from("po_shortages").insert({ org_id: org.orgId, project_id: h.projectId, commitment_id: h.orderId, commitment_line_id: h.lineIds[0], short_quantity: 1, reason: "late" }).select("id")),
    purchasingClosesShortage: null,
    ownerEditsQuantity: await viaDataApi(kit, org.owner, (db) => db.from("po_receipt_lines").update({ quantity_received: 100 }).eq("id", receiptLine.id).select("id")),
  }
  // A shortage to forge against: close the line short through the service, then try to resolve it by hand.
  const closed = await kit.as(org.team.superintendent, () => receipts().closePoLineShort({ commitmentLineId: h.lineIds[0], reason: "vendor_short", note: "Mill is out" }))
  forged.purchasingClosesShortage = await viaDataApi(kit, org.team.purchasing, (db) => db.from("po_shortages").update({ status: "accepted_short", resolved_at: new Date().toISOString() }).eq("id", closed.shortageId).select("id"))
  const salesReads = await viaDataApi(kit, org.team.sales, (db) => db.from("po_receipts").select("id").eq("project_id", h.projectId))
  const after = kit.rows(`select (select quantity_received::float from public.po_receipt_lines where id=${kit.q(receiptLine.id)}) quantity,
      (select status from public.po_receipts where id=${kit.q(delivered.id)}) status,
      (select status from public.po_shortages where id=${kit.q(closed.shortageId)}) shortage,
      (select count(*)::int from public.po_receipts where project_id=${kit.q(h.projectId)}) receipts`)[0]
  equal(check, "every direct write to a receipt, its lines or a shortage is refused, for the receiver and for purchasing; a sales agent reads none", expected.expected.dataApi, {
    ...Object.fromEntries(Object.entries(forged).map(([name, outcome]) => [name, labelled(outcome, /^refused/)])),
    salesReadsReceipts: salesReads === "allowed" ? "allowed" : labelled(salesReads, /^refused/),
  })
  equal(check, "after the attempts the ticket stands as the service recorded it: 10 received, recorded, one ticket, the shortage still open", expected.expected.unchanged, { quantity: after.quantity, status: after.status, receipts: after.receipts, shortage: after.shortage })
  return { orgId: org.orgId, projectId: h.projectId }
}

async function receiptCaptureIsIdempotentAndRaces(kit, expected, check) {
  const org = await supplyOrg(kit)
  const h = home(kit, org, "Lot 4")
  await setNeededBy(kit, org, h, 5)
  const count = (key) => Number(kit.rows(`select count(*)::int n from public.po_receipts where org_id=${kit.q(org.orgId)} and idempotency_key=${kit.q(key)}`)[0].n)
  const retryKey = randomUUID()
  const first = await receive(kit, org, h, { 0: 10 }, { key: retryKey })
  const again = await receive(kit, org, h, { 0: 10 }, { key: retryKey })
  const sessionKey = randomUUID()
  const [left, right] = await Promise.all([receive(kit, org, h, { 0: 10 }, { key: sessionKey }), receive(kit, org, h, { 0: 10 }, { key: sessionKey })])
  const received = () => Number(kit.rows(`select coalesce(sum(l.quantity_received),0)::float q from public.po_receipt_lines l join public.po_receipts r on r.id=l.receipt_id where l.commitment_line_id=${kit.q(h.lineIds[0])} and r.status='recorded'`)[0].q)
  const afterKeys = received()
  const movedKey = await attempt(() => kit.as(org.team.superintendent, () => receipts().recordPoReceipt({
    commitmentId: home(kit, org, "Lot 4b").orderId, idempotencyKey: retryKey, lines: [{ commitmentLineId: h.lineIds[0], quantity: 1 }] })))
  // 80 of the 100 are in; two sessions each receive 15 of the last 20 under different keys.
  await receive(kit, org, h, { 0: 60 })
  const settled = await Promise.allSettled([receive(kit, org, h, { 0: 15 }), receive(kit, org, h, { 0: 15 })])
  const refused = settled.filter((result) => result.status === "rejected").map((result) => labelled(result.reason.message, /over the 100 ordered; say why/, "refused: over the ordered quantity, needs a reason"))
  equal(check, "the same key is one receipt, whether retried or sent from two sessions at once, and a key cannot be reused for another order", expected.expected.sameKey, {
    retry: { receipts: count(retryKey), secondReplayed: again.replayed, sameTicket: again.id === first.id },
    twoSessions: { receipts: count(sessionKey), bothReplied: left.id === right.id, replayedOne: [left.replayed, right.replayed].filter(Boolean).length },
    receivedAfterKeys: afterKeys,
    keyForAnotherOrder: labelled(movedKey, /already used for another purchase order|not on this purchase order/, "refused: key belongs to another order"),
  })
  equal(check, "two sessions racing for the last 20 units with different keys: one lands, the other is refused as an over-receipt, and the line is never over-received without a reason", expected.expected.lastUnits, {
    accepted: settled.filter((result) => result.status === "fulfilled").length,
    refused,
    received: received(),
  })
  return { orgId: org.orgId, projectId: h.projectId }
}

async function lateDeliverySweepOpensOneShortageAndAnAdvisory(kit, expected, check) {
  const org = await supplyOrg(kit)
  const h = home(kit, org, "Lot 5", { taskStartsIn: 3 })
  // The lines were needed three days ago, set through the service like any date.
  await setNeededBy(kit, org, h, -3)
  const task = () => kit.rows(`select name, status, start_date::text s, end_date::text e from public.schedule_items where id=${kit.q(h.taskId)}`)[0]
  const taskBefore = task()
  const sweep = () => kit.service(() => receipts().sweepLateDeliveries())
  await sweep()
  await sweep()
  const shortages = () => kit.rows(`select reason, status from public.po_shortages where commitment_id=${kit.q(h.orderId)} order by created_at`)
  const opened = shortages()
  const notified = (userId) => Number(kit.rows(`select count(*)::int n from public.notifications where org_id=${kit.q(org.orgId)} and user_id=${kit.q(userId)} and notification_type='po_shortage_opened'
    and payload->>'entity_id' in (select id::text from public.po_shortages where commitment_id=${kit.q(h.orderId)})`)[0].n)
  const [late] = mine((await desk(kit, org.team.purchasing, { state: "late", pageSize: 100 })).rows, h)
  const advisories = await kit.as(org.team.superintendent, () => receipts().listHomeDeliveryAdvisories(h.projectId))
  const noAccess = await kit.as(org.team.sales, () => receipts().listHomeDeliveryAdvisories(h.projectId))
  const taskAfter = task()
  await receive(kit, org, h, { 0: 100 })
  const closed = shortages()
  const advisoriesAfter = await kit.as(org.team.superintendent, () => receipts().listHomeDeliveryAdvisories(h.projectId))
  equal(check, "an overdue line gets one late shortage however often the sweep runs, shown late on the desk, with one notification to purchasing", expected.expected.sweep, {
    shortages: opened,
    desk: { state: late.state, daysLate: late.daysLate, outstanding: late.outstanding },
    purchasingNotified: notified(org.team.purchasing.userId),
    receiverNotified: notified(org.team.superintendent.userId),
  })
  equal(check, "the framing task on the same cost code carries one advisory, nothing on the schedule changes, a reader without delivery access sees none, and a full receipt closes the shortage and the advisory", expected.expected.advisory, {
    advisories: advisories.map((advisory) => ({ task: advisory.scheduleItemName.startsWith("Framing"), daysLate: advisory.daysLate, outstanding: advisory.outstanding, state: advisory.state })),
    scheduleUnchanged: JSON.stringify(taskBefore) === JSON.stringify(taskAfter),
    withoutAccess: noAccess === null ? "none" : "visible",
    afterFullReceipt: { shortages: closed, advisories: advisoriesAfter.length },
  })
  return { orgId: org.orgId, projectId: h.projectId }
}

async function shortageResolutionReachesPurchasing(kit, expected, check) {
  const org = await supplyOrg(kit)
  const h = home(kit, org, "Lot 6")
  await setNeededBy(kit, org, h, 5)
  await receive(kit, org, h, { 0: 40 })
  const { shortageId } = await kit.as(org.team.superintendent, () => receipts().closePoLineShort({ commitmentLineId: h.lineIds[0], reason: "vendor_short", note: "Mill is out" }))
  const resolve = (actor, input) => attempt(() => kit.as(actor, () => receipts().resolvePoShortage({ shortageId, ...input })))
  const row = async () => mine((await desk(kit, org.team.purchasing, { state: "all", pageSize: 100 })).rows, h)[0]
  const refusals = {
    superintendent: labelled(await resolve(org.team.superintendent, { resolution: "accepted_short", note: "Build with what arrived" }), /po_exception\.resolve|Missing permission/, "refused: needs po_exception.resolve"),
    otherDivision: labelled(await resolve(org.divisionBBuyer, { resolution: "accepted_short", note: "Build with what arrived" }), /Missing permission|not found|permission/i, "refused: outside the reader's divisions"),
    pastBackorder: labelled(await resolve(org.team.purchasing, { resolution: "backordered", backorderDate: day(-2) }), /passed/, "refused: date has passed"),
    noReason: labelled(await resolve(org.team.purchasing, { resolution: "accepted_short" }), /Say why/, "refused: needs a reason"),
  }
  await resolve(org.team.purchasing, { resolution: "backordered", backorderDate: day(4), note: "Vendor promised Thursday" })
  const backordered = await row()
  const reasons = await kit.as(org.team.purchasing, () => app("purchasing-settings").listVarianceReasonCodes())
  const reason = reasons.find((candidate) => !candidate.is_backcharge)
  const vpoOutcome = await kit.as(org.team.purchasing, () => receipts().resolvePoShortage({ shortageId, resolution: "vpo", vpo: { reasonCodeId: reason.id, quantity: 60, unitCostCents: 500 } }))
  const linked = kit.rows(`select s.status, s.vpo_id=${kit.q(vpoOutcome.vpoId)} linked, v.status vpo_status, v.total_cents::int total, v.commitment_id=${kit.q(h.orderId)} on_order from public.po_shortages s join public.commitment_change_orders v on v.id=s.vpo_id where s.id=${kit.q(shortageId)}`)[0]
  const twice = labelled(await resolve(org.team.purchasing, { resolution: "cancelled", note: "Changed our mind" }), /already resolved/, "refused: already resolved")
  const closedOut = await row()
  await kit.service(() => receipts().sweepLateDeliveries())
  const reopened = Number(kit.rows(`select count(*)::int n from public.po_shortages where commitment_line_id=${kit.q(h.lineIds[0])} and status in ('open','backordered')`)[0].n)
  equal(check, "a reader without po_exception.resolve, a coordinator of another division, a date that has passed and a bare accept-short are all refused", expected.expected.refusals, refusals)
  equal(check, "a back-order restarts the clock: the line (40 of 100 in) reads partial by the promised date, back-ordered, no longer short", expected.expected.backorder, {
    state: backordered.state, expectedIn: Math.round((Date.parse(`${backordered.expectedDate}T00:00:00Z`) - Date.parse(`${day(0)}T00:00:00Z`)) / 86_400_000), shortage: backordered.shortageStatus,
  })
  equal(check, "raising a VPO creates a draft variance order on this order for 60 at $5, linked to the shortage, closes the line out, and a second resolution is refused; the sweep does not reopen it", expected.expected.vpo, {
    shortage: linked.status, linked: linked.linked, vpo: linked.vpo_status, totalCents: linked.total, onTheOrder: linked.on_order,
    desk: closedOut.state, second: twice, reopenedBySweep: reopened,
  })
  return { orgId: org.orgId, projectId: h.projectId }
}

async function deliveriesDeskIsScopedAndCapped(kit, expected, check) {
  const org = await supplyOrg(kit)
  const homes = [home(kit, org, "Lot 7"), home(kit, org, "Lot 8")]
  for (const h of homes) await setNeededBy(kit, org, h, 5)
  const ids = homes.map((h) => h.orderId)
  const ours = (rows) => rows.filter((row) => ids.includes(row.commitmentId))
  const whole = await desk(kit, org.team.purchasing, { state: "open", pageSize: 100 })
  const wholeMine = ours(whole.rows)
  const limited = await desk(kit, org.divisionBBuyer, { state: "open", pageSize: 100 })
  const paged = await desk(kit, org.team.purchasing, { state: "open", projectId: homes[0].projectId, pageSize: 1 })
  const cut = await desk(kit, org.team.purchasing, { state: "open", pageSize: 1 })
  const denied = await attempt(() => desk(kit, org.team.sales, { state: "open" }))
  const lens = await desk(kit, org.team.purchasing, { state: "open", divisionId: org.divisions.b, pageSize: 100 })
  equal(check, "the purchasing manager sees both homes' lines; the manager of division B sees neither, nor does the division B lens; a role without price_book.read is refused", expected.expected.scope, {
    wholeOrg: wholeMine.length,
    divisionB: ours(limited.rows).length,
    divisionBLens: ours(lens.rows).length,
    salesAgent: labelled(denied, /price_book\.read|Missing permission/, "refused: needs price_book.read"),
  })
  equal(check, "a page smaller than the queue says how many there are", expected.expected.capped, {
    oneHomeOnePage: { rows: paged.rows.length, total: paged.total },
    cutAtOne: { rows: cut.rows.length, totalIsAtLeastBothHomes: cut.total >= 2, pageSize: cut.pageSize },
  })
  return { orgId: org.orgId }
}

const subcases = {
  "partial-receipts-and-shortage-by-home-and-line": partialReceiptsAndShortageByHomeAndLine,
  "receipts-are-written-only-through-the-service": receiptsAreWrittenOnlyThroughTheService,
  "receipt-capture-is-idempotent-and-races": receiptCaptureIsIdempotentAndRaces,
  "late-delivery-sweep-opens-one-shortage-and-an-advisory": lateDeliverySweepOpensOneShortageAndAnAdvisory,
  "shortage-resolution-reaches-purchasing": shortageResolutionReachesPurchasing,
  "deliveries-desk-is-scoped-and-capped": deliveriesDeskIsScopedAndCapped,
}

module.exports = { subcases }
