// TRADE-01 subcases for EP07-05, 06 and 07: what a trade's look-ahead holds, notices that cannot send
// twice or say something other than what was reserved, digests that coalesce under contention, and
// failed notices a coordinator can see. Composed into trade-01.cjs by the lead; each subcase is
// `async (kit, expected, check)` and acts through `kit.as`, so permissions and row security are real.
//
//   trade-lookahead-scope               EP07-06  cancelled/completed out, running work in, draft PO no vendor, inferred never emailed
//   trade-notice-snapshot-and-crash     EP07-07  one provider message across a lost response, a double send and a schedule edit; >24h goes ambiguous and a coordinator resolves it
//   schedule-digest-coalescing          EP07-07  concurrent moves land in one digest with the first old date; a claimed digest opens the next
//   trade-failed-notices-visible        EP07-05  failed digest and package alerts and an unresolved delivery appear on the package sheet and the desk, and the digest retries
//
// The mail provider is replaced in-process by one that honours Idempotency-Key as Resend does. The
// house is the LOT-01 released house; every row a subcase adds is tagged and named for it, so the
// house's own template schedule never enters an observation.
const { randomUUID } = require("node:crypto")
const { app } = require("./shared.cjs")

const lot = () => require("./lot-01.cjs").helpers
const eq = (check, label, expected, observed) => lot().equal(check, label, expected, observed)
const day = (offset) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
/** A trade contact as the directory has it: the person, linked to the company through contact_company_links. */
function contactSql(org, companyId, name, email) {
  const contactId = randomUUID()
  const q = (value) => `'${String(value).replaceAll("'", "''")}'`
  return `insert into public.contacts(id,org_id,full_name,email) values(${q(contactId)},${q(org.orgId)},${q(name)},${q(email)});
    insert into public.contact_company_links(org_id,contact_id,company_id,is_primary) values(${q(org.orgId)},${q(contactId)},${q(companyId)},true);`
}
const attempt = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }

/** Resend's contract: one message per Idempotency-Key. `loseResponse` stores the message and reports a failure, as a dropped connection would. */
function provider() {
  const state = { calls: 0, messages: new Map(), loseResponse: false }
  const mailer = app("mailer")
  const original = mailer.sendEmail
  mailer.sendEmail = async (payload) => {
    state.calls += 1
    if (!state.messages.has(payload.idempotencyKey)) state.messages.set(payload.idempotencyKey, { id: `msg-${state.messages.size + 1}`, html: payload.html, to: payload.to })
    if (state.loseResponse) return false
    await payload.onAccepted?.(state.messages.get(payload.idempotencyKey).id)
    return true
  }
  state.restore = () => { mailer.sendEmail = original }
  return state
}

async function house(kit) {
  const { org } = await lot().stage(kit, "release")
  const projectId = kit.rows(`select project_id from public.start_packages where id=${kit.q(org.packageId)}`)[0].project_id
  const tag = randomUUID().slice(0, 8)
  const company = (name) => {
    const id = randomUUID()
    kit.sql(`insert into public.companies(id,org_id,name) values(${kit.q(id)},${kit.q(org.orgId)},${kit.q(`${name} ${tag}`)});
      ${contactSql(org, id, "Foreman", `foreman-${tag}@acceptance.example.test`)}`)
    return id
  }
  const costCode = Object.values(org.costCodeIds)[0]
  const task = (name, start, end, { status = "planned", company = null, cost = false } = {}) => {
    const id = randomUUID()
    kit.sql(`insert into public.schedule_items(id,org_id,project_id,name,trade,status,start_date,end_date,cost_code_id)
      values(${kit.q(id)},${kit.q(org.orgId)},${kit.q(projectId)},${kit.q(`QA-${tag} ${name}`)},${kit.q(`QA-${tag}`)},${kit.q(status)},${kit.q(day(start))},${kit.q(day(end))},${cost ? kit.q(costCode) : "null"})`)
    if (company) kit.sql(`insert into public.schedule_assignments(org_id,project_id,schedule_item_id,company_id) values(${kit.q(org.orgId)},${kit.q(projectId)},${kit.q(id)},${kit.q(company)})`)
    return id
  }
  const purchaseOrder = (company, status) => {
    const id = randomUUID()
    kit.sql(`insert into public.commitments(id,org_id,project_id,title,company_id,commitment_type,status) values(${kit.q(id)},${kit.q(org.orgId)},${kit.q(projectId)},${kit.q(`QA-${tag} PO ${status}`)},${kit.q(company)},'purchase_order',${kit.q(status)});
      insert into public.commitment_lines(org_id,commitment_id,description,cost_code_id) values(${kit.q(org.orgId)},${kit.q(id)},'QA',${kit.q(costCode)})`)
  }
  const mine = (rows) => rows.flatMap((row) => row.items).filter((item) => item.name.startsWith(`QA-${tag} `)).map((item) => [item.name.slice(`QA-${tag} `.length), item.assignment])
  return { org, projectId, tag, company, task, purchaseOrder, mine, coordinator: org.team.starts }
}

async function tradeLookaheadScope(kit, expected, check) {
  const h = await house(kit)
  const framer = h.company("Framer")
  h.task("Starts next week", 7, 9, { company: framer })
  h.task("Started last week", -3, 4, { company: framer, status: "in_progress" })
  h.task("Cancelled slab", 2, 3, { company: framer, status: "cancelled" })
  h.task("Completed footings", -10, -8, { company: framer, status: "completed" })
  h.task("Finished long ago", -60, -50, { company: framer, status: "in_progress" })
  const vendorless = h.company("Awarded vendor")
  h.task("Inferred from PO", 3, 4, { cost: true })
  h.purchaseOrder(vendorless, "draft")
  const lookahead = app("trade-lookahead")
  const rowsOf = (companyId) => kit.as(h.coordinator, () => lookahead.getTradeLookahead({ weeks: 4, companyId }))
  const framerRows = await rowsOf(framer)
  const draftOnly = await kit.as(h.coordinator, () => lookahead.getTradeLookahead({ weeks: 4 }))
  const draftVendor = h.mine(draftOnly.rows).find(([name]) => name === "Inferred from PO")
  h.purchaseOrder(vendorless, "approved")
  const awarded = await rowsOf(vendorless)
  const mail = provider()
  let inferredEmailed
  try {
    await kit.as(h.coordinator, () => lookahead.sendTradeLookahead(vendorless, { weeks: 4 })).catch(() => null)
    inferredEmailed = mail.messages.size
    await kit.as(h.coordinator, () => lookahead.sendTradeLookahead(framer, { weeks: 4 }))
  } finally { mail.restore() }
  const body = [...mail.messages.values()].map((message) => message.html).join("")
  eq(check, "cancelled and completed work is out, work under way is in, and a vendor with only a draft order is not inferred", expected.expected.scope, {
    framer: h.mine(framerRows.rows).sort(),
    draftOrderVendor: draftVendor ? draftVendor[1] : "none",
    approvedOrderVendor: h.mine(awarded.rows),
  })
  eq(check, "inferred work is never emailed; the assigned work is", expected.expected.email, {
    inferredVendorMessages: inferredEmailed,
    framerEmailMentions: ["Starts next week", "Started last week"].filter((name) => body.includes(name)),
    leaksInferred: body.includes("Inferred from PO"),
    leaksCancelled: body.includes("Cancelled slab"),
  })
  return { orgId: h.org.orgId, projectId: h.projectId }
}

async function tradeNoticeSnapshotAndCrash(kit, expected, check) {
  const h = await house(kit)
  const framer = h.company("Framer")
  const item = h.task("Rough framing", 4, 6, { company: framer })
  const lookahead = app("trade-lookahead")
  const send = () => kit.as(h.coordinator, () => lookahead.sendTradeLookahead(framer, { weeks: 4 }))
  const deliveries = () => kit.rows(`select id::text, status, attempts, idempotency_key::text key, provider_message_id from public.trade_notice_deliveries where org_id=${kit.q(h.org.orgId)} and company_id=${kit.q(framer)} order by created_at`)
  const mail = provider()
  const result = {}
  try {
    mail.loseResponse = true
    result.lostResponse = await attempt(send)
    const afterLoss = deliveries()
    // The schedule changes after the notice was reserved, and a contact is added.
    kit.sql(`update public.schedule_items set name=${kit.q(`QA-${h.tag} Moved to the lake house`)} where id=${kit.q(item)};
      ${contactSql(h.org, framer, "Owner", `owner-${h.tag}@acceptance.example.test`)}`)
    mail.loseResponse = false
    result.retry = await send().then((r) => (r.sent ? "sent" : "duplicate"))
    result.doubleClick = await Promise.all([send(), send()]).then((rs) => rs.filter((r) => r.sent).length)
    const [row] = deliveries()
    const message = [...mail.messages.values()][0]
    result.snapshot = {
      afterLoss: afterLoss.map((r) => r.status),
      providerMessages: mail.messages.size,
      sameKeyEveryAttempt: [...mail.messages.keys()].every((key) => key === row.key),
      sentOriginalContent: message.html.includes("Rough framing") && !message.html.includes("lake house"),
      recipientsFrozen: message.to.length === 1,
      finalStatus: row.status,
      events: Number(kit.rows(`select count(*)::int n from public.events where org_id=${kit.q(h.org.orgId)} and event_type='trade_notice.sent' and payload->>'company_id'=${kit.q(framer)}`)[0].n),
    }
    // A reserved notice silent for over a day cannot be known to have been sent.
    const other = h.company("Plumber")
    h.task("Rough plumbing", 5, 6, { company: other })
    mail.loseResponse = true
    await attempt(() => kit.as(h.coordinator, () => lookahead.sendTradeLookahead(other, { weeks: 4 })))
    mail.loseResponse = false
    kit.sql(`update public.trade_notice_deliveries set status='reserved', last_attempt_at=now() - interval '25 hours' where org_id=${kit.q(h.org.orgId)} and company_id=${kit.q(other)}`)
    const before = mail.calls
    result.unknown = await attempt(() => kit.as(h.coordinator, () => lookahead.sendTradeLookahead(other, { weeks: 4 })))
    const ambiguous = kit.rows(`select id::text, status from public.trade_notice_deliveries where org_id=${kit.q(h.org.orgId)} and company_id=${kit.q(other)}`)[0]
    const desk = await kit.as(h.coordinator, () => app("trade-notices").listTradeNoticeAttention())
    result.ambiguous = { status: ambiguous.status, sentWhileUnknown: mail.calls - before, onDesk: desk.rows.some((row) => row.id === ambiguous.id && row.status === "ambiguous") }
    result.shortNote = await attempt(() => kit.as(h.coordinator, () => app("trade-notices").resolveTradeNotice({ deliveryId: ambiguous.id, resolution: "resend", note: "no" })))
    result.salesResolve = await attempt(() => kit.as(h.org.team.sales, () => app("trade-notices").resolveTradeNotice({ deliveryId: ambiguous.id, resolution: "delivered", note: "Confirmed by phone" })))
    await kit.as(h.coordinator, () => app("trade-notices").resolveTradeNotice({ deliveryId: ambiguous.id, resolution: "resend", note: "Foreman never got it" }))
    result.afterResend = await kit.as(h.coordinator, () => lookahead.sendTradeLookahead(other, { weeks: 4 })).then((r) => (r.sent ? "sent" : "duplicate"))
    result.newKey = kit.rows(`select idempotency_key::text key, status from public.trade_notice_deliveries where id=${kit.q(ambiguous.id)}`)[0]
  } finally { mail.restore() }
  eq(check, "a lost response, a retry and a double click reach the provider as one message, sent from what was reserved", expected.expected.once, {
    lostResponse: /not accepted/.test(result.lostResponse) ? "refused: not accepted" : result.lostResponse,
    retry: result.retry, doubleClickSends: result.doubleClick, ...result.snapshot,
  })
  eq(check, "a notice silent for over a day is ambiguous: never re-sent, on the desk, and only a coordinator with a reason resolves it", expected.expected.ambiguous, {
    refusedWhileUnknown: /outcome of this trade notice is unknown/.test(result.unknown) ? "refused: outcome unknown" : result.unknown,
    ...result.ambiguous,
    shortNote: /Say why|at least 5/.test(result.shortNote) ? "refused: needs a reason" : result.shortNote,
    sales: /start\.release|Missing permission/.test(result.salesResolve) ? "refused: needs start.release" : result.salesResolve,
    afterResend: result.afterResend, resentUnderNewKey: result.newKey.status === "accepted",
  })
  return { orgId: h.org.orgId, projectId: h.projectId }
}

async function scheduleDigestCoalescing(kit, expected, check) {
  const h = await house(kit)
  const framer = h.company("Framer")
  const items = Array.from({ length: 6 }, (_, index) => h.task(`Task ${index}`, 3, 4, { company: framer }))
  const move = (id, from, to) => app("trade-lookahead").enqueueTradeScheduleChange({ orgId: h.org.orgId, actorId: h.coordinator.userId, companyId: framer, projectId: h.projectId, scheduleItemId: id, oldStart: day(from), newStart: day(to) })
  const digests = () => kit.rows(`select id::text, status, payload from public.outbox where org_id=${kit.q(h.org.orgId)} and job_type='trade_schedule_change_notice' and payload->>'company_id'=${kit.q(framer)} order by id`)
  // Six concurrent moves, one of them twice (3 -> 5, then 5 -> 8).
  await Promise.all([...items.map((id) => move(id, 3, 6)), move(items[0], 6, 9)])
  const first = digests()
  const changes = first.flatMap((row) => row.payload.changes)
  const moved = changes.find((change) => change.schedule_item_id === items[0])
  // A worker claims the digest; the next move opens a new one instead of editing the sent job.
  kit.sql(`update public.outbox set status='processing' where id=${first[0].id}`)
  await move(items[1], 6, 12)
  const second = digests()
  // Moving an item back to where it was drops it from its digest.
  await move(items[2], 9, 6)
  await move(items[2], 6, 3)
  const settled = digests().at(-1).payload.changes.map((change) => change.schedule_item_id)
  kit.sql(`update public.outbox set status='completed' where org_id=${kit.q(h.org.orgId)} and job_type='trade_schedule_change_notice' and payload->>'company_id'=${kit.q(framer)}`)
  eq(check, "concurrent moves land in one digest, an item moved twice keeps its first old date, and every item is there", expected.expected.coalesced, {
    digests: first.length, items: new Set(changes.map((change) => change.schedule_item_id)).size,
    movedTwice: { old: moved.old_start === day(3), new: moved.new_start === day(9) },
  })
  eq(check, "a move after the digest was claimed opens the next digest, and a move back drops out", expected.expected.claimed, {
    statuses: second.map((row) => row.status), nextHoldsOnly: second[1].payload.changes.length === 1,
    movedBackDropped: !settled.includes(items[2]),
  })
  return { orgId: h.org.orgId, projectId: h.projectId }
}

async function tradeFailedNoticesVisible(kit, expected, check) {
  const h = await house(kit)
  const framer = h.company("Framer")
  const starts = app("starts")
  const insert = (type, status, payload) => Number(kit.sql(`insert into public.outbox(org_id,job_type,status,payload,retry_count,last_error,run_at) values(${kit.q(h.org.orgId)},${kit.q(type)},${kit.q(status)},${kit.q(JSON.stringify(payload))}::jsonb,3,'Provider unavailable',now() + interval '1 hour') returning id`).split("\n")[0])
  const digest = insert("trade_schedule_change_notice", "failed", { project_id: h.projectId, company_id: framer, changes: [], actor_id: h.coordinator.userId })
  const packageAlert = insert("start_package_notice", "failed", { start_package_id: h.org.packageId, kind: "ready", event_id: randomUUID(), message: null })
  const elsewhere = insert("trade_schedule_change_notice", "failed", { project_id: randomUUID(), company_id: framer, changes: [] })
  const sheet = async () => (await kit.as(h.coordinator, () => starts.getStartPackage(h.org.packageId))).tradeNotices
  const before = await sheet()
  const desk = await kit.as(h.coordinator, () => app("trade-notices").listTradeNoticeAttention())
  await kit.as(h.coordinator, () => starts.retryStartTradeNotice(h.org.packageId, String(digest)))
  const retried = kit.rows(`select status, retry_count from public.outbox where id=${digest}`)[0]
  const foreign = await attempt(() => kit.as(h.coordinator, () => starts.retryStartTradeNotice(h.org.packageId, String(elsewhere))))
  const salesRetry = await attempt(() => kit.as(h.org.team.sales, () => starts.retryStartTradeNotice(h.org.packageId, String(packageAlert))))
  kit.sql(`update public.outbox set status='completed' where id in (${digest},${packageAlert},${elsewhere})`)
  eq(check, "the package sheet lists this house's failed digest and package alert (not another house's), and the desk lists them too", expected.expected.visible, {
    sheet: before.filter((n) => [String(digest), String(packageAlert), String(elsewhere)].includes(n.id)).map((n) => `${n.kind}:${n.status}`).sort(),
    desk: desk.rows.filter((row) => [String(digest), String(packageAlert)].includes(row.id)).map((row) => `${row.kind}:${row.status}`).sort(),
  })
  eq(check, "a failed digest is retried by a coordinator; another house's notice and a role without start.release are refused", expected.expected.retry, {
    retried: { status: retried.status, retryCount: Number(retried.retry_count) },
    anotherHouse: /not found/i.test(foreign) ? "refused: not found" : foreign,
    sales: /start\.release|Missing permission/.test(salesRetry) ? "refused: needs start.release" : salesRetry,
  })
  return { orgId: h.org.orgId, projectId: h.projectId }
}

const subcases = {
  "trade-lookahead-scope": tradeLookaheadScope,
  "trade-notice-snapshot-and-crash": tradeNoticeSnapshotAndCrash,
  "schedule-digest-coalescing": scheduleDigestCoalescing,
  "trade-failed-notices-visible": tradeFailedNoticesVisible,
}

module.exports = { subcases }
