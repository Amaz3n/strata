// FIELD-01 subcases for EP09-03 (released field documents) and EP09-06 (cross-home daily records). Composed
// into field-01.cjs; each subcase is `async (kit, expected, check)` and acts through `kit.as`, so permissions
// and row security are the real ones:
//
//   released-set-labels          EP09-03  the superintendent's "Released for this home": a revision supersedes a
//                                         sheet, an unreviewed copy exists; options and awarded scope as released;
//                                         a member scoped to another division is refused
//   trade-portal-released        EP09-03  a trade's token shows only the drawings released to trades (same labels)
//                                         and its own scope lines; another trade's, another home's and unreleased
//                                         records are absent; a revoked or wrong-portal link is refused
//   cross-home-review-band       EP09-06  a division-limited superintendent's band covers only their assigned
//                                         homes, the counts are exact, the row cap hides a stated number
//   photo-retry-dedupe           EP09-06  a retried upload (same client id) is one record on the same home and log;
//                                         naming another home is refused; the web queue's id is stable per context
//   orphan-storage-reconciliation EP09-06 (requires --storage-env) NOT BUILT: objects left by an interrupted upload
//                                         are not swept; the subcase reports BLOCKED without storage
//
// Fixture: one production builder (`documentsOrg`, built once per run), two divisions. SQL writes only the fixture
// rows (drawings, selections, commitments, daily logs, photo files, projects) that no service creates in this scope.
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const { app } = require("./shared.cjs")

const lot = () => require("./lot-01.cjs").helpers
const equal = (check, label, expected, observed) => lot().equal(check, label, expected, observed)
const attempt = async (work) => {
  try { await work(); return "allowed" } catch (error) { return error.message }
}

const ORGS = new WeakMap()
async function documentsOrg(kit) {
  if (!ORGS.has(kit)) ORGS.set(kit, (async () => {
    const org = await seed.productionBuilder(kit, { name: "FIELD-01 documents" })
    org.divisions = { a: randomUUID(), b: randomUUID() }
    kit.sql(`insert into public.divisions(id,org_id,name) values(${kit.q(org.divisions.a)},${kit.q(org.orgId)},'FIELD-01 A'),(${kit.q(org.divisions.b)},${kit.q(org.orgId)},'FIELD-01 B');`)
    // A superintendent limited to division A, and one limited to division B.
    const limit = (actor, division) => {
      const membership = kit.rows(`select id from public.memberships where org_id=${kit.q(org.orgId)} and user_id=${kit.q(actor.userId)}`)[0].id
      kit.sql(`update public.memberships set division_scope='assigned' where id=${kit.q(membership)}; insert into public.membership_divisions(membership_id,division_id) values(${kit.q(membership)},${kit.q(division)});`)
      return actor
    }
    org.superA = limit(kit.addMember(org, "org_superintendent", {}), org.divisions.a)
    org.superB = limit(kit.addMember(org, "org_superintendent", {}), org.divisions.b)
    return org
  })())
  return ORGS.get(kit)
}

/** An assigned superintendent is also a project member, as assign_project_superintendent leaves them. */
function project(kit, org, { name, division, superintendent = null }) {
  const id = randomUUID()
  kit.sql(`insert into public.projects(id,org_id,name,property_type,status,phase,division_id,superintendent_id) values(${kit.q(id)},${kit.q(org.orgId)},${kit.q(name)},'production','active','delivery',${kit.q(division)},${kit.q(superintendent)});`)
  if (superintendent)
    kit.sql(`insert into public.project_members(org_id,project_id,user_id,role_id,status) select ${kit.q(org.orgId)},${kit.q(id)},${kit.q(superintendent)},id,'active' from public.roles where key='field' and scope='project';`)
  return id
}

/**
 * One set per home. Revisions A and B are published (B supersedes A on sheet A-101), C is an unreviewed draft copy.
 * Sheets: A-101 (current B, also in A), A-102 (current A), A-103 (only in draft C), A-104 (current A, not shared with trades).
 * Trade sharing: A-101, A-102 and A-103 are shared; A-104 is not.
 */
function drawings(kit, org, projectId) {
  const { q } = kit
  const id = () => randomUUID()
  const set = id(), rev = { a: id(), b: id(), c: id() }, sheet = { s101: id(), s102: id(), s103: id(), s104: id() }
  const day = (offset) => seed.isoDay(offset)
  kit.sql([
    "begin;",
    `insert into public.drawing_sets(id,org_id,project_id,title,status,processing_stage) values(${q(set)},${q(org.orgId)},${q(projectId)},'Construction Drawings','ready','ready');`,
    `insert into public.drawing_revisions(id,org_id,project_id,drawing_set_id,revision_label,status,issued_date,published_at) values(${q(rev.a)},${q(org.orgId)},${q(projectId)},${q(set)},'Plan v1','published',${q(day(-20))},now());`,
    `insert into public.drawing_revisions(id,org_id,project_id,drawing_set_id,revision_label,status,issued_date,published_at) values(${q(rev.b)},${q(org.orgId)},${q(projectId)},${q(set)},'Plan v2','published',${q(day(-5))},now());`,
    `insert into public.drawing_revisions(id,org_id,project_id,drawing_set_id,revision_label,status,issued_date) values(${q(rev.c)},${q(org.orgId)},${q(projectId)},${q(set)},'Plan v3','draft',${q(day(-1))});`,
    ...[["s101", "A-101", "Floor plan", rev.b, true], ["s102", "A-102", "Elevations", rev.a, true], ["s103", "A-103", "Roof plan", null, true], ["s104", "A-104", "Sections", rev.a, false]]
      .map(([key, number, title, current, shared]) => `insert into public.drawing_sheets(id,org_id,project_id,drawing_set_id,sheet_number,sheet_title,current_revision_id,share_with_subs) values(${q(sheet[key])},${q(org.orgId)},${q(projectId)},${q(set)},${q(number)},${q(title)},${q(current)},${shared});`),
    ...[["s101", rev.a], ["s101", rev.b], ["s102", rev.a], ["s103", rev.c], ["s104", rev.a]]
      .map(([key, revision]) => `insert into public.drawing_sheet_versions(org_id,drawing_sheet_id,drawing_revision_id) values(${q(org.orgId)},${q(sheet[key])},${q(revision)});`),
    "commit;",
  ].join("\n"))
}

/** Commitments with lines; `created` fixes the order they are listed in. */
function commitment(kit, org, projectId, { title, company, status = "approved", created, lines }) {
  const { q } = kit
  const id = randomUUID()
  kit.sql([
    "begin;",
    `insert into public.commitments(id,org_id,project_id,company_id,title,status,created_at) values(${q(id)},${q(org.orgId)},${q(projectId)},${q(company)},${q(title)},${q(status)},${q(created)});`,
    ...lines.map(([description, quantity, unit], index) => `insert into public.commitment_lines(org_id,commitment_id,description,quantity,unit,sort_order) values(${q(org.orgId)},${q(id)},${q(description)},${quantity},${q(unit)},${index});`),
    "commit;",
  ].join("\n"))
  return id
}

function selection(kit, org, projectId, { category, option, status }) {
  const { q } = kit
  const categoryId = randomUUID(), optionId = randomUUID()
  kit.sql([
    "begin;",
    `insert into public.selection_categories(id,org_id,name) values(${q(categoryId)},${q(org.orgId)},${q(category)});`,
    `insert into public.selection_options(id,org_id,category_id,name) values(${q(optionId)},${q(org.orgId)},${q(categoryId)},${q(option)});`,
    `insert into public.project_selections(org_id,project_id,category_id,selected_option_id,status) values(${q(org.orgId)},${q(projectId)},${q(categoryId)},${q(optionId)},${q(status)});`,
    "commit;",
  ].join("\n"))
}

const sheetRows = (dto) => dto.sheets.map((sheet) => [sheet.sheetNumber, sheet.revisionLabel, sheet.state])
const scopeRows = (dto) => dto.scope.map((row) => [row.title, row.lines.map((line) => `${line.description} ${line.quantity} ${line.unit}`)])

/** A home with the drawing set above, two awarded scopes, confirmed and unconfirmed options. */
async function releasedHome(kit, org, name) {
  const projectId = project(kit, org, { name, division: org.divisions.a })
  drawings(kit, org, projectId)
  const framing = org.vendorIds["Palmetto Framing"], concrete = org.vendorIds["Gulf Concrete"]
  commitment(kit, org, projectId, { title: "Framing package", company: framing, created: "2026-01-01T00:00:00Z", lines: [["Frame walls", 2400, "sf"], ["Install trusses", 24, "ea"]] })
  commitment(kit, org, projectId, { title: "Concrete package", company: concrete, created: "2026-01-02T00:00:00Z", lines: [["Pour slab", 1800, "sf"]] })
  commitment(kit, org, projectId, { title: "Draft roofing", company: framing, status: "draft", created: "2026-01-03T00:00:00Z", lines: [["Shingle roof", 30, "sq"]] })
  commitment(kit, org, projectId, { title: "Canceled paint", company: framing, status: "canceled", created: "2026-01-04T00:00:00Z", lines: [["Paint exterior", 1, "ls"]] })
  selection(kit, org, projectId, { category: "Flooring", option: "LVP Oak", status: "confirmed" })
  selection(kit, org, projectId, { category: "Cabinets", option: "Shaker White", status: "ordered" })
  selection(kit, org, projectId, { category: "Fixtures", option: "Brushed nickel", status: "selected" })
  return projectId
}

async function releasedSetLabels(kit, expected, check) {
  const org = await documentsOrg(kit)
  const projectId = await releasedHome(kit, org, "FIELD-01 released set")
  // A superintendent reads drawings but holds neither commitment.read nor selections.read: those sections are withheld, not listed.
  const field = await kit.as(org.team.superintendent, () => app("released-field-documents").getReleasedForHome(projectId))
  equal(check, "a role without commitment.read and selections.read gets drawings only, sections withheld", expected.superintendent, { sheets: field.sheets.length, options: field.options, scope: field.scope })
  const released = await kit.as(org.owner, () => app("released-field-documents").getReleasedForHome(projectId))
  equal(check, "sheets carry current, superseded and pending-review labels", expected.sheets, sheetRows(released))
  equal(check, "options are the confirmed ones only", expected.options, released.options.map((option) => [option.categoryName, option.optionName]))
  equal(check, "scope is awarded commitments only, lines in order", expected.scope, scopeRows(released))
  equal(check, "nothing was cut", false, released.truncated)
  const outside = await attempt(() => kit.as(org.superB, () => app("released-field-documents").getReleasedForHome(projectId)))
  equal(check, "a member scoped to another division is refused", expected.outsideDivision, /permission|denied|not authorized|forbidden/i.test(outside) ? "refused" : outside)
  return { projectId }
}

async function tradePortalReleased(kit, expected, check) {
  const org = await documentsOrg(kit)
  const projectId = await releasedHome(kit, org, "FIELD-01 trade home")
  const otherHome = project(kit, org, { name: "FIELD-01 trade other home", division: org.divisions.a })
  const framing = org.vendorIds["Palmetto Framing"], concrete = org.vendorIds["Gulf Concrete"]
  commitment(kit, org, otherHome, { title: "Framing other home", company: framing, created: "2026-02-01T00:00:00Z", lines: [["Frame garage", 600, "sf"]] })
  const link = (project_id, company) => kit.as(org.owner, () => app("portal-access").createPortalAccessToken({ projectId: project_id, portalType: "sub", companyId: company, orgId: org.orgId }))
  const portal = app("portal-access")
  const view = async (token) => {
    const access = await portal.assertPortalActionAccess(token.token, { portalType: "sub", requireProject: true, requireCompany: true, permission: "can_view_documents" })
    return app("released-field-documents").getReleasedForTrade({ orgId: access.org_id, projectId: access.project_id, companyId: access.company_id })
  }
  const framingLink = await link(projectId, framing)
  const framingView = await view(framingLink)
  equal(check, "the framer sees released-to-trades drawings, labelled, never a draft copy or an unshared sheet", expected.framerSheets, sheetRows(framingView))
  equal(check, "the trade sees the home's confirmed options by name", expected.framerOptions, framingView.options.map((option) => [option.categoryName, option.optionName]))
  equal(check, "the framer sees only their own scope lines", expected.framerScope, scopeRows(framingView))
  const concreteView = await view(await link(projectId, concrete))
  equal(check, "the concrete trade sees only theirs", expected.concreteScope, scopeRows(concreteView))
  const otherView = await view(await link(otherHome, framing))
  equal(check, "the same trade on another home sees that home only", { sheets: expected.otherHomeSheets, options: [], scope: expected.otherHomeScope }, { sheets: sheetRows(otherView), options: otherView.options, scope: scopeRows(otherView) })
  const bidLink = await kit.as(org.owner, () => portal.createPortalAccessToken({ projectId, portalType: "client", orgId: org.orgId }))
  equal(check, "a link for another portal is refused", expected.wrongPortal, await attempt(() => view(bidLink)) === "allowed" ? "allowed" : "refused")
  const pausedLink = await link(projectId, framing)
  await kit.as(org.owner, () => portal.pausePortalToken(pausedLink.id))
  equal(check, "a paused link is refused (the page 404s)", expected.paused, await attempt(() => view(pausedLink)) === "allowed" ? "allowed" : "refused")
  await kit.as(org.owner, () => portal.revokePortalToken(framingLink.id))
  equal(check, "a revoked link is refused", expected.revoked, await attempt(() => view(framingLink)) === "allowed" ? "allowed" : "refused")
  return { projectId, otherHome }
}

/** Thirteen homes assigned to the division-A superintendent, plus a division-B house still pointing at them and a colleague's house. */
async function crossHomeReviewBand(kit, expected, check) {
  const org = await documentsOrg(kit)
  const { q } = kit
  const sup = org.superA
  const day = (offset) => seed.isoDay(offset)
  const homes = []
  const add = (label, { log = null, photos = [] }) => {
    const id = project(kit, org, { name: `FIELD-01 band ${label}`, division: org.divisions.a, superintendent: sup.userId })
    homes.push({ label, id })
    if (log !== null) kit.sql(`insert into public.daily_logs(org_id,project_id,log_date) values(${q(org.orgId)},${q(id)},${q(day(log))});`)
    for (const daysAgo of photos)
      kit.sql(`insert into public.files(org_id,project_id,file_name,storage_path,mime_type,size_bytes,visibility,category,source,created_at) values(${q(org.orgId)},${q(id)},${q(`p-${randomUUID()}.jpg`)},${q(`${org.orgId}/${id}/${randomUUID()}.jpg`)},'image/jpeg',1000,'private','photos','upload',now() - interval '${daysAgo} days');`)
    return id
  }
  // Logged today (4): H1-H3 bare, H4 also has photos from today, which the day's log covers.
  add("H01", { log: 0 }); add("H02", { log: 0 }); add("H03", { log: 0 }); add("H04", { log: 0, photos: [0, 0] })
  // Missing today's log (9): newest photos after the last log count as new, older ones do not.
  add("H05", { log: -1, photos: [0, 0] })
  add("H06", { log: -3, photos: [2, 4] })
  add("H07", { photos: [1, 3, 5, 10] })
  for (const label of ["H08", "H09", "H10", "H11", "H12", "H13"]) add(label, label === "H09" ? { log: -1 } : {})
  // Out of scope: a division-B house still assigned to this superintendent, and a colleague's house in division A.
  const staleDivisionB = project(kit, org, { name: "FIELD-01 band stale B", division: org.divisions.b, superintendent: sup.userId })
  const colleagues = project(kit, org, { name: "FIELD-01 band colleague", division: org.divisions.a, superintendent: org.team.superintendent.userId })
  kit.sql(`insert into public.daily_logs(org_id,project_id,log_date) values(${q(org.orgId)},${q(colleagues)},${q(day(0))});`)

  const home = await kit.as(sup, () => app("production-home").getProductionHomeData({}))
  const byId = new Map(homes.map((entry) => [entry.id, entry.label]))
  const assigned = home.assigned
  equal(check, "only this superintendent's homes in their division are listed", expected.houses, assigned ? assigned.houses.map((house) => byId.get(house.projectId) ?? "outside").sort() : null)
  equal(check, "counts are exact", expected.counts, assigned ? { houses: assigned.houseCount, missingLog: assigned.missingLogCount, newPhotos: assigned.newPhotoCount } : null)
  equal(check, "per-home new photos", expected.newPhotos, assigned ? Object.fromEntries(assigned.houses.filter((house) => house.newPhotoCount > 0).map((house) => [byId.get(house.projectId), house.newPhotoCount]).sort()) : null)
  const { fieldRecordsRows } = require("../../../lib/field/field-records")
  const band = fieldRecordsRows(assigned ? assigned.houses : [], day(0))
  // Ties among houses with nothing new are ordered by id, so only the ranked head and the counts are asserted.
  equal(check, "the band ranks the worst houses first, is capped and states what the cap hid", expected.band,
    { head: band.rows.slice(0, 3).map((row) => byId.get(row.house.projectId)), shown: band.rows.length, hidden: band.hidden })
  equal(check, "the stale division-B assignment is not listed", false, Boolean(assigned && assigned.houses.some((house) => house.projectId === staleDivisionB)))
  return { homes: homes.length }
}

/**
 * The replay path is the one that must not duplicate or misattribute: a file row already carries the client id, so a retry
 * returns it (no second row, no second storage write); the same id naming another home or log is refused before anything
 * is signed. Fresh uploads need storage, so the first upload is the fixture row an earlier attempt left.
 */
async function photoRetryDedupe(kit, expected, check) {
  const org = await documentsOrg(kit)
  const { q } = kit
  const homeA = project(kit, org, { name: "FIELD-01 retry A", division: org.divisions.a, superintendent: org.team.superintendent.userId })
  const homeB = project(kit, org, { name: "FIELD-01 retry B", division: org.divisions.a, superintendent: org.team.superintendent.userId })
  const logA = randomUUID(), logB = randomUUID(), fileId = randomUUID()
  kit.sql([
    "begin;",
    `insert into public.daily_logs(id,org_id,project_id,log_date) values(${q(logA)},${q(org.orgId)},${q(homeA)},${q(seed.isoDay(0))}),(${q(logB)},${q(org.orgId)},${q(homeB)},${q(seed.isoDay(0))});`,
    `insert into public.files(id,org_id,project_id,daily_log_id,file_name,storage_path,mime_type,size_bytes,visibility,category,source) values(${q(fileId)},${q(org.orgId)},${q(homeA)},${q(logA)},'slab.jpg',${q(`${org.orgId}/${homeA}/daily-logs/uploads/${fileId}_slab.jpg`)},'image/jpeg',1000,'private','photos','upload');`,
    "commit;",
  ].join("\n"))
  const photoForm = () => {
    const form = new FormData()
    form.set("client_id", fileId)
    form.set("file", new File([new Uint8Array([1, 2, 3])], "slab.jpg", { type: "image/jpeg" }))
    return form
  }
  const count = () => Number(kit.rows(`select count(*)::int n from public.files where id=${q(fileId)}`)[0].n)
  const rowOf = () => kit.rows(`select project_id, daily_log_id from public.files where id=${q(fileId)}`)[0]
  const attribution = () => ({ files: count(), onHomeA: rowOf().project_id === homeA, onLogA: rowOf().daily_log_id === logA, photoRecords: Number(kit.rows(`select count(*)::int n from public.photos where file_id=${q(fileId)}`)[0].n) })
  const before = attribution()

  const { requireOrgContext } = require("../../../lib/services/context")
  const { uploadMobileDailyLogPhoto } = require("../../../lib/mobile/daily-logs")
  const mobileContext = async () => {
    const context = await requireOrgContext()
    return { token: "", user: { id: context.userId }, serviceSupabase: require("../../../lib/supabase/server").createServiceSupabaseClient(), isPlatformAdmin: false, orgId: context.orgId, serviceContext: context }
  }
  const upload = (projectId, logId) => kit.as(org.team.superintendent, async () => uploadMobileDailyLogPhoto(await mobileContext(), projectId, logId, photoForm()))
  // Without storage the replay is accepted and then cannot sign its download link; that failure comes after the dedupe decision.
  const replay = await upload(homeA, logA).then((photo) => (photo.id === fileId ? "same record" : "other record"),
    (error) => (/R2 credentials/.test(error.message) ? "accepted (signing needs storage)" : `failed: ${error.message}`))
  equal(check, "a retry on the same home and log returns the one record and adds or moves nothing", expected.afterRetry, { ...attribution(), replay })
  const otherHome = await attempt(() => upload(homeB, logB))
  equal(check, "a retry naming another home is refused and nothing moves", expected.afterWrongHome, { ...attribution(), refused: /already used by another file/i.test(otherHome) })
  const { dailyLogUploadId } = require("../../../lib/daily-logs/upload-queue")
  const file = () => new File([new Uint8Array([9, 9])], "slab.jpg", { type: "image/jpeg" })
  const same = await dailyLogUploadId("home-a", file(), { dailyLogId: logA }), again = await dailyLogUploadId("home-a", file(), { dailyLogId: logA })
  const elsewhere = await dailyLogUploadId("home-b", file(), { dailyLogId: logB })
  equal(check, "the web queue's id is the same for a restored draft and different for another home", expected.queueIds, { stable: same === again, otherHomeDiffers: same !== elsewhere })
  equal(check, "fixture state before any retry", expected.before, before)
  return { homeA, homeB }
}

async function orphanStorageReconciliation() {
  throw Error("Orphan storage reconciliation is not built: interrupted uploads can leave a storage object with no files row (lib/mobile/daily-logs.ts uploads before inserting). Needs real storage to prove a sweep.")
}

const withExpected = (run) => (kit, spec, check) => run(kit, spec.expected, check)

module.exports = {
  subcases: {
    "released-set-labels": withExpected(releasedSetLabels),
    "trade-portal-released": withExpected(tradePortalReleased),
    "cross-home-review-band": withExpected(crossHomeReviewBand),
    "photo-retry-dedupe": withExpected(photoRetryDedupe),
    "orphan-storage-reconciliation": orphanStorageReconciliation,
  },
}
