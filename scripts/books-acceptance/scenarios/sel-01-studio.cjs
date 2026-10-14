// SEL-01 subcases for EP06-01 (design studio sessions on consultant and room capacity) and EP06-02
// (buyer approval binds the exact selections and prices). Composed into SEL-01 by sel-01.cjs; each
// subcase is `async (kit, expected, check)` and acts through `kit.as`, so permissions and row
// security are the real ones:
//
//   consultant-cannot-be-double-booked         EP06-01  one consultant, one session at a time; back to back is fine; another consultant is free
//   studio-rooms-are-the-capacity              EP06-01  a two-room studio holds two concurrent sessions, refuses a third, frees a room on cancel
//   competing-bookings-one-wins                EP06-01  two coordinators racing for one consultant's hour: exactly one session lands
//   working-hours-in-studio-time               EP06-01  outside the consultant's hours (studio zone) or on a day off is refused; a DST day inside hours books
//   reschedule-keeps-deadlines-and-tells-buyer EP06-01  a move bumps the revision, never moves the cutoff, cannot land past it; book and move each queue one buyer notice
//   cancel-frees-and-notifies                  EP06-01  a cancellation queues one notice, frees the slot and leaves the desk's week count
//   sessions-only-through-the-studio           EP06-01  a member's direct insert, move, cancel or delete is refused; room setup needs design_studio.manage
//   portal-approval-binds-what-buyer-saw       EP06-02  a stale terms hash approves nothing; the fresh one approves at the shown prices, channel portal
//   esign-approval-binds-sent-terms            EP06-02  a change after sending voids the request and its envelope; the re-sent terms are what the signature confirms, at the sent price
//   unsigned-declined-expired-stay-distinct    EP06-02  never sent, declined on the signing link, expired by the sweep: three states, nothing confirmed, each can be sent again
//   signature-before-cutoff-lands-after-lock   EP06-02  a signature made before the deadline confirms the selections even after the group locked
//   in-person-approval-needs-signed-copy       EP06-02  a coordinator's approval needs the buyer's signed copy filed on the home
//   approval-evidence-cannot-be-forged         EP06-02  a member cannot insert or approve a request, or rewrite what was sent, through the data API
//
// One org (`studioOrg`), built once per run: Cypress Landing, its product and tranche 1, a studio
// ("Gulf Coast Design Center", America/New_York, two rooms) and two consultants with Monday-Saturday
// 9:00-17:00 hours. Every subcase sells its own home, so none reads another's sessions or approvals.
//
// SQL is used only for what a subcase is not about and says so: the e-sign document file (the stack
// has no file storage, so the generated PDF is a file row and a checksum), the buyer's signature on
// the signing link (the signing machinery has its own scenarios), the clock (a request's deadline in
// the past), and reads that check outcomes. Sessions are booked on days counted from today so a run
// on any date stays inside the consultants' hours and ahead of now.
//
// Each subcase's expected observation is in expected/SEL-01.json.
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const fx = require("./lot-01-sales-fixtures.cjs")
const { app } = require("./shared.cjs")

const lot = () => require("./lot-01.cjs").helpers
const equal = (check, label, expected, observed) => lot().equal(check, label, expected, observed)
const slots = () => require("../../../lib/selections/appointment-slots")
const attempt = async (work) => {
  try { await work(); return "allowed" } catch (error) { return error.code && /^[A-Z_]+$/.test(error.code) && !/^AUTH_FORBIDDEN$/.test(error.code) ? error.code : error.message }
}

const STUDIO_ZONE = "America/New_York"
const HOURS = { startMinute: 9 * 60, endMinute: 17 * 60 }

/** The next date (YYYY-MM-DD, studio zone) at least `minDays` out that falls on `weekday` (0 = Sunday). */
function studioDay(weekday, minDays = 7) {
  const base = new Date(Date.now() + minDays * 86400000)
  for (let offset = 0; offset < 7; offset += 1) {
    const day = new Date(base.getTime() + offset * 86400000)
    const local = slots().localSlot({ start: day.toISOString(), end: day.toISOString() }, STUDIO_ZONE)
    if (local.weekday === weekday) return local.date
  }
  throw Error("unreachable")
}
/** The instant of a wall-clock time at the studio. */
const at = (date, hour, minute = 0) => slots().zonedTimeToUtc(date, hour * 60 + minute, STUDIO_ZONE).toISOString()
const addDays = (date, days) => new Date(Date.parse(`${date}T12:00:00Z`) + days * 86400000).toISOString().slice(0, 10)

const STUDIO_ORGS = new WeakMap()
function studioOrg(kit) {
  if (!STUDIO_ORGS.has(kit)) STUDIO_ORGS.set(kit, (async () => {
    const org = await seed.productionBuilder(kit, { name: "SEL-01 design studio" })
    await seed.seedCommunity(kit, org)
    await seed.seedProduct(kit, org)
    await seed.takeDownTranche(kit, org)
    org.team.consultant = kit.addMember(org, "org_design_studio_coordinator")
    // A second flooring choice, priced like the seeded ones, so a coordinator has something to change to.
    const catalog = app("option-catalog")
    const oak = await kit.as(org.team.design, () => catalog.upsertOption({ categoryId: org.categoryIds.Flooring, name: "Engineered oak", optionScope: "design_studio", priceCents: 910000, costCents: 560000, costCodeId: org.costCodeIds["06-100"], sku: "FL-OAK", vendor: "Palmetto Framing", sortOrder: 9, isAvailable: true }))
    for (const plan of org.plans) await kit.as(org.team.design, () => catalog.setCatalogPrice({ optionId: oak.id, housePlanVersionId: plan.versionId, priceCents: 910000, costCents: 560000, isAvailable: true }))
    org.altFlooringId = oak.id
    const studios = app("design-studio-appointments")
    const studio = await kit.as(org.team.design, () => studios.saveStudioLocation({ name: "Gulf Coast Design Center", address: "100 Cypress Landing Blvd", timeZone: STUDIO_ZONE }))
    await kit.as(org.team.design, () => studios.saveStudioRooms({ locationId: studio.id, rooms: [{ name: "Room A", isActive: true }, { name: "Room B", isActive: true }] }))
    for (const consultant of [org.team.design, org.team.consultant]) {
      const windows = [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, ...HOURS }))
      await kit.as(org.team.design, () => studios.saveConsultantHours({ locationId: studio.id, userId: consultant.userId, windows }))
    }
    org.studioId = studio.id
    return org
  })())
  return STUDIO_ORGS.get(kit)
}

/** A sold home with its interior group's selections chosen (not approved). */
async function soldHome(kit, org, name, { choose = true } = {}) {
  const buyer = await fx.reservedBuyer(kit, org, { name, depositCents: 2_000_000, receivedOn: null })
  const sale = await fx.agreementFor(kit, org, buyer)
  if (choose) {
    const selections = app("selections")
    for (const row of designRows(kit, sale.projectId))
      await kit.as(org.team.design, () => selections.selectProjectOption({ orgId: org.orgId, projectId: sale.projectId, selectionId: row.id, optionId: org.optionIds[seed.DESIGN_PICKS[row.category]] }))
  }
  return { ...sale, buyer }
}

const designRows = (kit, projectId) => kit.rows(`select s.id, c.name category, s.status, s.price_cents_snapshot price from public.project_selections s join public.selection_categories c on c.id=s.category_id
  where s.project_id=${kit.q(projectId)} and s.group_id is not null order by c.name`)
const interior = async (kit, org, projectId) => (await kit.as(org.team.design, () => app("selection-approvals").listHomeSelectionApprovals(projectId))).find((group) => group.groupId === org.selectionGroupId)
const book = (kit, org, actor, input) => kit.as(actor, () => app("design-studio-appointments").bookAppointment({ locationId: org.studioId, durationMinutes: 120, ...input }))
const notices = (kit, appointmentId) => kit.rows(`select payload->>'kind' kind, (payload->>'revision')::int revision from public.outbox
  where job_type='send_design_studio_appointment_notice' and payload->>'appointment_id'=${kit.q(appointmentId)} order by id`).map((row) => `${row.kind} r${row.revision}`)

/** A member's write straight through the data API (PostgREST with their session). */
async function viaDataApi(kit, actor, write) {
  return attempt(() => kit.as(actor, async () => {
    const { supabase } = await require("../../../lib/services/context").requireOrgContext()
    const { data, error } = await write(supabase)
    if (error) throw new Error(/42501|design studio|selection service|permission denied/i.test(`${error.code} ${error.message}`) ? "refused" : error.message)
    if (Array.isArray(data) && data.length === 0) throw new Error("refused: no row visible to change")
  }))
}

// ---------------------------------------------------------------------------
// EP06-01

async function consultantCannotBeDoubleBooked(kit, expected, check) {
  const org = await studioOrg(kit)
  const day = studioDay(2)
  const [first, second, third, fourth] = await Promise.all(["Double One", "Double Two", "Double Three", "Double Four"].map((name) => soldHome(kit, org, name, { choose: false })))
  const ten = await book(kit, org, org.team.design, { projectId: first.projectId, consultantUserId: org.team.design.userId, scheduledAt: at(day, 10) })
  const overlapping = await attempt(() => book(kit, org, org.team.design, { projectId: second.projectId, consultantUserId: org.team.design.userId, scheduledAt: at(day, 11) }))
  const backToBack = await book(kit, org, org.team.design, { projectId: third.projectId, consultantUserId: org.team.design.userId, scheduledAt: at(day, 12) })
  const otherConsultant = await book(kit, org, org.team.design, { projectId: fourth.projectId, consultantUserId: org.team.consultant.userId, scheduledAt: at(day, 11) })
  equal(check, "the consultant at 10:00-12:00 is refused at 11:00, booked at 12:00; another consultant takes 11:00", expected.expected, {
    first: ten.status,
    overlapping: /is already in a session then/.test(overlapping) ? "refused: consultant already in a session" : overlapping,
    backToBack: backToBack.status,
    otherConsultant: otherConsultant.status,
    roomsUsed: [ten.roomName, backToBack.roomName, otherConsultant.roomName],
  })
  return { orgId: org.orgId }
}

async function studioRoomsAreTheCapacity(kit, expected, check) {
  const org = await studioOrg(kit)
  const day = studioDay(3)
  const homes = await Promise.all(["Room One", "Room Two", "Room Three"].map((name) => soldHome(kit, org, name, { choose: false })))
  const third = kit.addMember(org, "org_design_studio_coordinator")
  await kit.as(org.team.design, () => app("design-studio-appointments").saveConsultantHours({ locationId: org.studioId, userId: third.userId, windows: [{ weekday: 3, ...HOURS }] }))
  const a = await book(kit, org, org.team.design, { projectId: homes[0].projectId, consultantUserId: org.team.design.userId, scheduledAt: at(day, 13) })
  const b = await book(kit, org, org.team.design, { projectId: homes[1].projectId, consultantUserId: org.team.consultant.userId, scheduledAt: at(day, 13) })
  const full = await attempt(() => book(kit, org, org.team.design, { projectId: homes[2].projectId, consultantUserId: third.userId, scheduledAt: at(day, 13, 30) }))
  await kit.as(org.team.design, () => app("design-studio-appointments").cancelAppointment({ appointmentId: b.id, reason: "Buyer rescheduling with the lender" }))
  const afterCancel = await book(kit, org, org.team.design, { projectId: homes[2].projectId, consultantUserId: third.userId, scheduledAt: at(day, 13, 30) })
  equal(check, "two rooms hold two concurrent sessions; the third is refused until one cancels", expected.expected, {
    rooms: [a.roomName, b.roomName].sort(),
    third: /All 2 rooms at Gulf Coast Design Center are booked then/.test(full) ? "refused: all 2 rooms booked" : full,
    afterCancel: { status: afterCancel.status, room: afterCancel.roomName === b.roomName ? "the freed room" : afterCancel.roomName },
  })
  return { orgId: org.orgId }
}

async function competingBookingsOneWins(kit, expected, check) {
  const org = await studioOrg(kit)
  const day = studioDay(4)
  const [left, right] = await Promise.all(["Race Left", "Race Right"].map((name) => soldHome(kit, org, name, { choose: false })))
  const rival = kit.addMember(org, "org_design_studio_coordinator")
  const results = await Promise.allSettled([
    book(kit, org, org.team.design, { projectId: left.projectId, consultantUserId: org.team.consultant.userId, scheduledAt: at(day, 9) }),
    book(kit, org, rival, { projectId: right.projectId, consultantUserId: org.team.consultant.userId, scheduledAt: at(day, 9) }),
  ])
  const landed = kit.rows(`select count(*)::int n from public.design_studio_appointments where org_id=${kit.q(org.orgId)} and coordinator_user_id=${kit.q(org.team.consultant.userId)}
    and status='scheduled' and scheduled_at=${kit.q(at(day, 9))}`)[0].n
  equal(check, "two coordinators booking one consultant's hour at once: exactly one session lands, the other is told why", expected.expected, {
    outcomes: results.map((result) => result.status).sort(),
    refusal: results.filter((result) => result.status === "rejected").map((result) => /is already in a session then/.test(result.reason.message) ? "consultant already in a session" : result.reason.message),
    landed,
  })
  return { orgId: org.orgId }
}

async function workingHoursInStudioTime(kit, expected, check) {
  const org = await studioOrg(kit)
  const home = await soldHome(kit, org, "Hours Buyer", { choose: false })
  const day = studioDay(5)
  const evening = await attempt(() => book(kit, org, org.team.design, { projectId: home.projectId, consultantUserId: org.team.design.userId, scheduledAt: at(day, 16) }))
  const sunday = await attempt(() => book(kit, org, org.team.design, { projectId: home.projectId, consultantUserId: org.team.design.userId, scheduledAt: at(studioDay(0), 10) }))
  // The 2027 spring-forward Saturday-to-Sunday change is not a working day; the Monday after reads in EDT.
  const afterChange = await book(kit, org, org.team.design, { projectId: home.projectId, consultantUserId: org.team.design.userId, scheduledAt: at("2027-03-15", 9), durationMinutes: 60 })
  equal(check, "16:00-18:00 runs past 17:00 at the studio and Sunday is a day off; 9:00 the Monday after the clocks change books", expected.expected, {
    evening: /does not work at Gulf Coast Design Center at that time/.test(evening) ? "refused: outside the consultant's hours" : evening,
    sunday: /does not work at Gulf Coast Design Center at that time/.test(sunday) ? "refused: outside the consultant's hours" : sunday,
    afterChange: { status: afterChange.status, utc: afterChange.scheduledAt.slice(11, 16) },
  })
  return { orgId: org.orgId }
}

async function rescheduleKeepsDeadlinesAndTellsBuyer(kit, expected, check) {
  const org = await studioOrg(kit)
  const home = await soldHome(kit, org, "Moving Buyer", { choose: false })
  const day = studioDay(1, 8), later = addDays(day, 1)
  await kit.as(org.team.design, () => app("selection-cutoffs").overrideGroupCutoff({ projectId: home.projectId, groupId: org.selectionGroupId, cutoffDate: later, reason: "Interior selections due the day after the second session" }))
  const deadline = () => kit.rows(`select cutoff_date::text cutoff, cutoff_source source, status from public.project_selection_groups where project_id=${kit.q(home.projectId)} and group_id=${kit.q(org.selectionGroupId)}`)[0]
  const before = deadline()
  const studios = app("design-studio-appointments")
  const booked = await book(kit, org, org.team.design, { projectId: home.projectId, consultantUserId: org.team.design.userId, scheduledAt: at(day, 10) })
  const moved = await kit.as(org.team.design, () => studios.rescheduleAppointment({ appointmentId: booked.id, locationId: org.studioId, consultantUserId: org.team.design.userId, scheduledAt: at(later, 14), durationMinutes: 120 }))
  const pastCutoff = await attempt(() => kit.as(org.team.design, () => studios.rescheduleAppointment({ appointmentId: booked.id, locationId: org.studioId, consultantUserId: org.team.design.userId, scheduledAt: at(addDays(day, 2), 10), durationMinutes: 120 })))
  const queued = notices(kit, booked.id)
  await kit.drainOutbox(org.orgId)
  const sent = kit.rows(`select payload->>'kind' kind, payload->>'skipped' skipped from public.events where entity_id=${kit.q(booked.id)} and event_type='design_studio_appointment_notice_sent' order by created_at`)
  equal(check, "moving the session bumps its revision and never its cutoff, cannot land past the cutoff, and the buyer is told of the booking and the move once each", expected.expected, {
    revision: moved.revision,
    deadlineUnchanged: JSON.stringify(deadline()) === JSON.stringify(before),
    deadlineSource: before.source,
    pastCutoff: /after the .* selection cutoff/.test(pastCutoff) ? "refused: lands after the cutoff" : pastCutoff,
    queued,
    noticesSent: sent.map((row) => `${row.kind}${row.skipped ? ` (${row.skipped})` : ""}`),
  })
  return { orgId: org.orgId, appointmentId: booked.id }
}

async function cancelFreesAndNotifies(kit, expected, check) {
  const org = await studioOrg(kit)
  const [home, next] = await Promise.all(["Cancel Buyer", "Cancel Next"].map((name) => soldHome(kit, org, name, { choose: false })))
  const day = studioDay(6)
  const studios = app("design-studio-appointments")
  const booked = await book(kit, org, org.team.design, { projectId: home.projectId, consultantUserId: org.team.consultant.userId, scheduledAt: at(day, 15) })
  const window = { from: at(day, 0), to: at(day, 23, 59) }
  const countBefore = await kit.as(org.team.design, () => studios.countAppointments(window))
  const canceled = await kit.as(org.team.design, () => studios.cancelAppointment({ appointmentId: booked.id, reason: "Buyer travelling that week" }))
  const again = await attempt(() => kit.as(org.team.design, () => studios.cancelAppointment({ appointmentId: booked.id, reason: "Again" })))
  const rebooked = await book(kit, org, org.team.design, { projectId: next.projectId, consultantUserId: org.team.consultant.userId, scheduledAt: at(day, 15) })
  const countAfter = await kit.as(org.team.design, () => studios.countAppointments(window))
  equal(check, "a cancellation is told to the buyer once, frees the consultant, and leaves the day's count", expected.expected, {
    status: canceled.status,
    again: /already canceled/.test(again) ? "refused: already canceled" : again,
    notices: notices(kit, booked.id),
    slotRebooked: rebooked.status,
    dayCount: { before: countBefore, after: countAfter },
  })
  return { orgId: org.orgId }
}

async function sessionsOnlyThroughTheStudio(kit, expected, check) {
  const org = await studioOrg(kit)
  const home = await soldHome(kit, org, "Direct Write", { choose: false })
  const booked = await book(kit, org, org.team.design, { projectId: home.projectId, consultantUserId: org.team.design.userId, scheduledAt: at(studioDay(1, 10), 9) })
  const sales = org.team.sales
  const roomId = kit.rows(`select id from public.design_studio_rooms where location_id=${kit.q(org.studioId)} order by sort_order limit 1`)[0].id
  equal(check, "a member cannot insert, move, cancel or delete a session through the data API, and only design studio managers set up rooms", expected.expected, {
    insert: await viaDataApi(kit, org.team.design, (db) => db.from("design_studio_appointments").insert({ org_id: org.orgId, project_id: home.projectId, location_id: org.studioId, room_id: roomId, coordinator_user_id: org.team.design.userId, scheduled_at: at(studioDay(2, 10), 9) }).select("id")),
    move: await viaDataApi(kit, org.team.design, (db) => db.from("design_studio_appointments").update({ scheduled_at: at(studioDay(2, 10), 13) }).eq("id", booked.id).select("id")),
    cancel: await viaDataApi(kit, org.team.design, (db) => db.from("design_studio_appointments").update({ status: "canceled" }).eq("id", booked.id).select("id")),
    remove: await viaDataApi(kit, org.team.design, (db) => db.from("design_studio_appointments").delete().eq("id", booked.id).select("id")),
    salesRenamesRoom: await viaDataApi(kit, sales, (db) => db.from("design_studio_rooms").update({ name: "Closet" }).eq("id", roomId).select("id")),
    stillScheduled: kit.rows(`select status from public.design_studio_appointments where id=${kit.q(booked.id)}`)[0].status,
  })
  return { orgId: org.orgId }
}

// ---------------------------------------------------------------------------
// EP06-02

const approvals = () => app("selection-approvals")

async function portalApprovalBindsWhatBuyerSaw(kit, expected, check) {
  const org = await studioOrg(kit)
  const home = await soldHome(kit, org, "Portal Buyer")
  const seen = await interior(kit, org, home.projectId)
  // The coordinator changes the flooring while the buyer has the page open.
  const flooring = designRows(kit, home.projectId).find((row) => row.category === "Flooring")
  await kit.as(org.team.design, () => app("selections").selectProjectOption({ orgId: org.orgId, projectId: home.projectId, selectionId: flooring.id, optionId: org.altFlooringId }))
  const portal = (termsHash) => kit.service(() => approvals().approveSelectionsFromPortal({ orgId: org.orgId, projectId: home.projectId, contactId: home.buyer.buyerId, groupId: org.selectionGroupId, termsHash }))
  const stale = await attempt(() => portal(seen.terms.termsHash))
  const afterStale = designRows(kit, home.projectId).map((row) => row.status)
  const fresh = await interior(kit, org, home.projectId)
  await portal(fresh.terms.termsHash)
  const approved = kit.rows(`select channel, status, total_cents::bigint total, approved_by_contact_id=${kit.q(home.buyer.buyerId)} by_buyer from public.selection_approvals where project_id=${kit.q(home.projectId)} order by sent_at desc limit 1`)[0]
  equal(check, "the buyer's approval of the page they saw is refused once it changed; the current page approves at its prices, in the portal", expected.expected, {
    stale,
    afterStale,
    approved: { channel: approved.channel, status: approved.status, totalMatchesShown: Number(approved.total) === fresh.terms.totalCents, byBuyer: approved.by_buyer },
    confirmedAtShownPrices: designRows(kit, home.projectId).every((row) => row.status === "confirmed") && designRows(kit, home.projectId).reduce((sum, row) => sum + Number(row.price), 0) === fresh.terms.totalCents,
  })
  return { orgId: org.orgId, projectId: home.projectId }
}

/**
 * Publishes an e-sign request the way the service does once its PDF is filed: the stack has no
 * file storage, so the generated PDF is a file row with a checksum.
 */
async function sendForSignature(kit, org, home) {
  const group = await interior(kit, org, home.projectId)
  // The service's own send, up to the point it renders the PDF (sendSelectionApproval needs storage).
  const sent = await kit.service(async () => {
    const db = require("../../../lib/supabase/server").createServiceSupabaseClient()
    const { data, error } = await db.rpc("send_selection_approval", { p_org_id: org.orgId, p_project_id: home.projectId, p_group_id: org.selectionGroupId, p_channel: "esign", p_expected_terms_hash: group.terms.termsHash, p_actor_id: org.team.design.userId })
    if (error) throw new Error(error.message)
    return data
  })
  const fileId = randomUUID(), sha = randomUUID().replace(/-/g, "").padEnd(64, "0")
  kit.sql(`insert into public.files(id,org_id,project_id,file_name,storage_path,mime_type,source,visibility,checksum,size_bytes) values(${kit.q(fileId)},${kit.q(org.orgId)},${kit.q(home.projectId)},'interior-selections.pdf',${kit.q(`acceptance/${fileId}.pdf`)},'application/pdf','generated','private',${kit.q(sha)},4096)`)
  const documentId = kit.rows(`select public.reserve_selection_approval_document(${kit.q(org.orgId)},${kit.q(sent.id)},${kit.q(org.team.design.userId)},${kit.q(fileId)},'Interior selections') id`)[0].id
  const source = JSON.stringify({ file_id: fileId, sha256: sha, size_bytes: 4096, storage_path: `acceptance/${fileId}.pdf` })
  const envelopeId = kit.rows(`select public.publish_selection_approval_document(${kit.q(org.orgId)},${kit.q(sent.id)},${kit.q(org.team.design.userId)},${kit.q(source)}::jsonb,'Approve your interior selections',null) id`)[0].id
  return { approvalId: sent.id, envelopeId, documentId, termsHash: group.terms.termsHash, totalCents: group.terms.totalCents }
}
/** The buyer signs on the signing link (the signing machinery has its own scenarios). */
function buyerSigns(kit, envelopeId, signedAt = "now()") {
  kit.sql(`update public.document_signing_requests set status='signed', signed_at=${signedAt} where envelope_id=${kit.q(envelopeId)};
update public.envelopes set status='executed', executed_at=now() where id=${kit.q(envelopeId)};`)
}
/** The e-sign execution job's side effect, as process-outbox runs it, with the executed PDF as a file on the home. */
const executeSigned = (kit, org, home, request) => kit.service(() => approvals().executeSelectionApprovalFromEnvelope({
  orgId: org.orgId, approvalId: request.approvalId, envelopeId: request.envelopeId,
  executedFileId: seed.signedCopyFile(kit, org, home.projectId, "executed-selections.pdf"), signerName: "Buyer", signerEmail: "buyer@acceptance.example.test",
}))

async function esignApprovalBindsSentTerms(kit, expected, check) {
  const org = await studioOrg(kit)
  const home = await soldHome(kit, org, "Esign Buyer")
  const first = await sendForSignature(kit, org, home)
  const status = (table, id) => kit.rows(`select status from public.${table} where id=${kit.q(id)}`)[0].status
  // The coordinator swaps the flooring after sending: the buyer must never sign the old page.
  const flooring = designRows(kit, home.projectId).find((row) => row.category === "Flooring")
  await kit.as(org.team.design, () => app("selections").selectProjectOption({ orgId: org.orgId, projectId: home.projectId, selectionId: flooring.id, optionId: org.altFlooringId }))
  const afterChange = { approval: status("selection_approvals", first.approvalId), envelope: status("envelopes", first.envelopeId), reason: kit.rows(`select void_reason from public.selection_approvals where id=${kit.q(first.approvalId)}`)[0].void_reason }
  const second = await sendForSignature(kit, org, home)
  // The catalog reprices the kitchen after sending; the signature binds the sent price.
  const sold = org.plans[0]
  await kit.as(org.team.design, () => app("option-catalog").setCatalogPrice({ optionId: org.optionIds[seed.DESIGN_PICKS.Kitchen], housePlanVersionId: sold.versionId, priceCents: 530000, isAvailable: true }))
  buyerSigns(kit, second.envelopeId)
  const outcome = await executeSigned(kit, org, home, second)
  const lines = kit.rows(`select l.price_cents line, s.price_cents_snapshot confirmed, s.status from public.selection_approval_lines l join public.project_selections s on s.id=l.selection_id where l.approval_id=${kit.q(second.approvalId)}`)
  equal(check, "a change after sending voids the request and its envelope; the re-sent terms are confirmed at the sent prices when the buyer signs", expected.expected, {
    afterChange,
    hashChanged: first.termsHash !== second.termsHash,
    outcome,
    confirmedAtSentPrices: lines.every((row) => row.status === "confirmed" && Number(row.line) === Number(row.confirmed)),
    approval: kit.rows(`select channel, status from public.selection_approvals where id=${kit.q(second.approvalId)}`)[0],
  })
  return { orgId: org.orgId, projectId: home.projectId }
}

async function unsignedDeclinedExpiredStayDistinct(kit, expected, check) {
  const org = await studioOrg(kit)
  const [never, declining, lapsing] = await Promise.all(["Never Sent", "Declining Buyer", "Lapsing Buyer"].map((name) => soldHome(kit, org, name)))
  const declined = await sendForSignature(kit, org, declining)
  const requestId = kit.rows(`select id from public.document_signing_requests where envelope_id=${kit.q(declined.envelopeId)}`)[0].id
  kit.sql(`select public.cancel_esign_envelope(${kit.q(org.orgId)},${kit.q(declined.envelopeId)},'The tile is not what we picked',${kit.q(requestId)},null)`)
  const lapsingTerms = (await interior(kit, org, lapsing.projectId)).terms.termsHash
  const lapsed = await kit.as(org.team.design, () => approvals().sendSelectionApproval({ projectId: lapsing.projectId, groupId: org.selectionGroupId, channel: "portal", termsHash: lapsingTerms }))
  // The clock: this request's deadline has passed (the trigger allows only the sweep to move it on).
  kit.sql(`alter table public.selection_approvals disable trigger selection_approvals_lifecycle; update public.selection_approvals set expires_at=now()-interval '1 minute' where id=${kit.q(lapsed.approvalId)}; alter table public.selection_approvals enable trigger selection_approvals_lifecycle;`)
  await kit.service(() => approvals().expireSelectionApprovals())
  const states = {}
  for (const [label, home] of [["never", never], ["declined", declining], ["expired", lapsing]]) {
    const group = await interior(kit, org, home.projectId)
    states[label] = { state: group.state, reason: group.reason, confirmed: designRows(kit, home.projectId).some((row) => row.status === "confirmed"), canSendAgain: group.blocker === null }
  }
  await kit.drainOutbox(org.orgId)
  equal(check, "never sent, declined on the signing link and expired by the sweep stay three different states; nothing is confirmed and each can be sent again", expected.expected, {
    ...states,
    coordinatorsTold: kit.rows(`select payload->>'status' status from public.outbox where org_id=${kit.q(org.orgId)} and job_type='notify_selection_approval_outcome' and payload->>'approval_id' in (${kit.q(declined.approvalId)},${kit.q(lapsed.approvalId)}) order by 1`).map((row) => row.status),
  })
  return { orgId: org.orgId }
}

async function signatureBeforeCutoffLandsAfterLock(kit, expected, check) {
  const org = await studioOrg(kit)
  const home = await soldHome(kit, org, "Late Job Buyer")
  await kit.as(org.team.design, () => app("selection-cutoffs").overrideGroupCutoff({ projectId: home.projectId, groupId: org.selectionGroupId, cutoffDate: seed.isoDay(2), reason: "Interior selections due this week" }))
  const request = await sendForSignature(kit, org, home)
  buyerSigns(kit, request.envelopeId)
  // The cutoff passes and the sweep locks the group before the signing job runs.
  kit.sql(`update public.project_selection_groups set status='locked', locked_at=now() where project_id=${kit.q(home.projectId)} and group_id=${kit.q(org.selectionGroupId)};
update public.project_selections set locked_at=now() where project_id=${kit.q(home.projectId)} and group_id=${kit.q(org.selectionGroupId)};`)
  const outcome = await executeSigned(kit, org, home, request)
  equal(check, "a signature made before the deadline confirms the selections at the signed terms even though the group locked first", expected.expected, {
    outcome,
    statuses: designRows(kit, home.projectId).map((row) => row.status),
    group: kit.rows(`select status from public.project_selection_groups where project_id=${kit.q(home.projectId)} and group_id=${kit.q(org.selectionGroupId)}`)[0].status,
  })
  return { orgId: org.orgId, projectId: home.projectId }
}

async function inPersonApprovalNeedsSignedCopy(kit, expected, check) {
  const org = await studioOrg(kit)
  const [home, elsewhere] = await Promise.all(["Paper Buyer", "Other Home"].map((name, index) => soldHome(kit, org, name, { choose: index === 0 })))
  const group = await interior(kit, org, home.projectId)
  const record = (fileId) => attempt(() => kit.as(org.team.design, () => approvals().recordInPersonSelectionApproval({ projectId: home.projectId, groupId: org.selectionGroupId, termsHash: group.terms.termsHash, signedCopyFileId: fileId })))
  const wrongHome = await record(seed.signedSelectionCopy(kit, org, elsewhere.projectId, org.team.design))
  const recorded = await record(seed.signedSelectionCopy(kit, org, home.projectId, org.team.design))
  equal(check, "a coordinator's approval needs the buyer's signed copy filed on this home", expected.expected, {
    wrongHome,
    recorded,
    approval: kit.rows(`select channel, status, signed_copy_file_id is not null has_copy from public.selection_approvals where project_id=${kit.q(home.projectId)} order by sent_at desc limit 1`)[0],
  })
  return { orgId: org.orgId, projectId: home.projectId }
}

async function approvalEvidenceCannotBeForged(kit, expected, check) {
  const org = await studioOrg(kit)
  const home = await soldHome(kit, org, "Forger Target")
  const group = await interior(kit, org, home.projectId)
  const sent = await kit.as(org.team.design, () => approvals().sendSelectionApproval({ projectId: home.projectId, groupId: org.selectionGroupId, channel: "portal", termsHash: group.terms.termsHash }))
  const actor = org.owner
  equal(check, "a member cannot insert or approve a request, rewrite what was sent, or point a document at one through the data API", expected.expected, {
    insertApproved: await viaDataApi(kit, actor, (db) => db.from("selection_approvals").insert({ org_id: org.orgId, project_id: home.projectId, group_id: org.selectionGroupId, channel: "portal", status: "approved", terms_hash: "b".repeat(64), total_cents: 0, approved_at: new Date().toISOString() }).select("id")),
    approve: await viaDataApi(kit, actor, (db) => db.from("selection_approvals").update({ status: "approved", approved_at: new Date().toISOString() }).eq("id", sent.approvalId).select("id")),
    rewriteLine: await viaDataApi(kit, actor, (db) => db.from("selection_approval_lines").update({ price_cents: 1 }).eq("approval_id", sent.approvalId).select("approval_id")),
    forgeDocument: await viaDataApi(kit, actor, (db) => db.from("documents").insert({ org_id: org.orgId, project_id: home.projectId, title: "Forged", document_type: "other", source_entity_type: "selection_approval", source_entity_id: sent.approvalId }).select("id")),
    stillSent: kit.rows(`select status from public.selection_approvals where id=${kit.q(sent.approvalId)}`)[0].status,
  })
  return { orgId: org.orgId }
}

const subcases = {
  "consultant-cannot-be-double-booked": consultantCannotBeDoubleBooked,
  "studio-rooms-are-the-capacity": studioRoomsAreTheCapacity,
  "competing-bookings-one-wins": competingBookingsOneWins,
  "working-hours-in-studio-time": workingHoursInStudioTime,
  "reschedule-keeps-deadlines-and-tells-buyer": rescheduleKeepsDeadlinesAndTellsBuyer,
  "cancel-frees-and-notifies": cancelFreesAndNotifies,
  "sessions-only-through-the-studio": sessionsOnlyThroughTheStudio,
  "portal-approval-binds-what-buyer-saw": portalApprovalBindsWhatBuyerSaw,
  "esign-approval-binds-sent-terms": esignApprovalBindsSentTerms,
  "unsigned-declined-expired-stay-distinct": unsignedDeclinedExpiredStayDistinct,
  "signature-before-cutoff-lands-after-lock": signatureBeforeCutoffLandsAfterLock,
  "in-person-approval-needs-signed-copy": inPersonApprovalNeedsSignedCopy,
  "approval-evidence-cannot-be-forged": approvalEvidenceCannotBeForged,
}

module.exports = { subcases }
