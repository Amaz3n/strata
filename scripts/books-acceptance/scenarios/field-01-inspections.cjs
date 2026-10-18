// FIELD-01 inspections (EP09-04): a failed inspection item becomes owned corrective work with evidence,
// linked to the item in the same transaction; a reinspection keeps every earlier attempt and an
// independent reviewer's acceptance of a passing one resolves the original failure.
// Reuses LOT-01's home and file helpers; LOT-01 proves the same chain through to a cleared closing.
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const { app } = require("./shared.cjs")
const { asMember } = require("./sessions.cjs")

const lot = () => require("./lot-01.cjs").helpers
const completion = () => require("./lot-01-completion.cjs").helpers
const lifecycle = () => require("../../../lib/inspections/lifecycle")
const refuse = (kit, actor, work) => lot().refusal(() => kit.as(actor, work))
const msg = (text, pattern) => (pattern.test(text) ? "refused" : text)
const equal = (check, label, expected, observed) => lot().equal(check, label, expected, observed)
const count = (kit, sql) => Number(kit.rows(`select count(*)::int n from (${sql}) t`)[0].n)
const daysFromToday = (date) => (date ? Math.round((Date.parse(date) - Date.parse(seed.isoDay(0))) / 86400000) : null)

/** One statement in a member's own session; reports the database's refusal, or whether it ran. */
function memberSql(kit, actor, statement) {
  try { kit.sql(`${asMember(actor)}\n${statement}`); return "allowed" } catch (error) {
    return /ERROR:\s+([^\n]+)/.exec(error.message)?.[1].trim().slice(0, 140) ?? error.message
  }
}

const FRAMING = [
  { section: "Structure", prompt: "Header sizes match plan", response_type: "pass_fail" },
  { section: "Structure", prompt: "Fire blocking installed", response_type: "pass_fail" },
  { section: "Structure", prompt: "Anchor bolts spaced", response_type: "pass_fail" },
]

async function setup(kit, key, lotIndex, buyer) {
  const { org, projectId } = await completion().freshHome(kit, key, lotIndex, buyer)
  const inspections = app("inspections"), punch = app("punch-lists")
  const sup = org.team.superintendent, vendor = org.vendorIds["Palmetto Framing"]
  const template = await kit.as(sup, () => inspections.createChecklistTemplate({ name: `Framing ${key}`, kind: "quality", items: FRAMING }))
  const start = () => kit.as(sup, () => inspections.createInspection({ project_id: projectId, template_id: template.id, kind: "quality", title: "Framing inspection", company_id: vendor }))
  return { org, projectId, inspections, punch, sup, vendor, start }
}

async function failedItemRaisesOwnedLinkedCorrectiveWork(kit, expected, check) {
  const { org, projectId, inspections, sup, vendor, start } = await setup(kit, "field-failure", 8, { name: "Nadia Ferreira", email: "nadia.ferreira@acceptance.example.test" })
  const inspection = await start()
  const [header, blocking, bolts] = inspection.items
  const photo = completion().homeFile(kit, org, projectId, "fire-blocking-fail.jpg")
  await kit.as(sup, () => inspections.updateInspectionItem(header.id, { response: "pass" }))
  await kit.as(sup, () => inspections.updateInspectionItem(blocking.id, { response: "fail", note: "Fire blocking missing at the stair wall", photo_file_id: photo }))
  await kit.as(sup, () => inspections.updateInspectionItem(bolts.id, { response: "fail", note: "Bolts spaced past 6 feet" }))

  const refusals = {
    salesRaises: msg(await refuse(kit, org.team.sales, () => inspections.createPunchItemFromInspectionItem(blocking.id, { company_id: vendor })), /Missing permission/),
    passingItem: msg(await refuse(kit, sup, () => inspections.createPunchItemFromInspectionItem(header.id, { company_id: vendor })), /requires a deficient inspection item/),
    unknownCompany: msg(await refuse(kit, sup, () => inspections.createPunchItemFromInspectionItem(bolts.id, { company_id: randomUUID() })), /Assigned company not found/),
  }
  const afterRefusals = { punchItems: count(kit, `select 1 from public.punch_items where project_id=${kit.q(projectId)}`), boltsLinked: kit.rows(`select punch_item_id from public.inspection_items where id=${kit.q(bolts.id)}`)[0].punch_item_id !== null }

  // The superintendent names the company and the due date for the fire-blocking failure.
  await kit.as(sup, () => inspections.createPunchItemFromInspectionItem(blocking.id, { company_id: vendor, due_date: seed.isoDay(5) }))
  const secondRaise = msg(await refuse(kit, sup, () => inspections.createPunchItemFromInspectionItem(blocking.id, { company_id: vendor })), /already has a punch item/)
  // Recording the failure raises the work for the failed item that has none; the inspection's company owns it.
  await kit.as(sup, () => inspections.completeInspection(inspection.id))

  const work = (itemId) => {
    const row = kit.rows(`select p.id, p.status, p.due_date::text due, p.assigned_company_id, p.assigned_to, p.created_by, p.verification_required, p.created_from_inspection, p.dispatched_at is not null dispatched, p.project_id from public.inspection_items i join public.punch_items p on p.id=i.punch_item_id where i.id=${kit.q(itemId)}`)[0]
    const evidence = kit.rows(`select file_id, link_role from public.file_links where entity_type='punch_item' and entity_id=${kit.q(row.id)}`)
    return {
      row,
      observed: {
        status: row.status, dueInDays: daysFromToday(row.due), company: row.assigned_company_id === vendor, createdBy: row.created_by === sup.userId, dispatched: row.dispatched,
        verificationRequired: row.verification_required, fromInspection: row.created_from_inspection, sameHome: row.project_id === projectId,
        evidence: evidence.map((link) => ({ photo: link.file_id === photo, role: link.link_role })),
        events: count(kit, `select 1 from public.events where org_id=${kit.q(org.orgId)} and event_type='punch_item_created' and entity_id=${kit.q(row.id)} and payload->>'from_inspection'=${kit.q(inspection.id)} and payload->>'inspection_item_id'=${kit.q(itemId)}`),
        audits: count(kit, `select 1 from public.audit_log where org_id=${kit.q(org.orgId)} and entity_type='punch_item' and entity_id=${kit.q(row.id)} and action='insert'`),
      },
    }
  }
  const chosen = work(blocking.id), automatic = work(bolts.id)
  const headerLinked = kit.rows(`select punch_item_id from public.inspection_items where id=${kit.q(header.id)}`)[0].punch_item_id !== null

  // A member's own data-API writes cannot forge, re-point or clear the link; a link to another home is refused.
  const q = kit.q
  const { projectId: foreign } = await completion().freshHome(kit, "field-other-home", 7, { name: "Iris Tavares", email: "iris.tavares@acceptance.example.test" })
  const foreignPunch = randomUUID()
  kit.sql(`insert into public.punch_items(id,org_id,project_id,title,status) values(${q(foreignPunch)},${q(org.orgId)},${q(foreign)},'Other home','open')`)
  const fence = {
    forgeLinkOnPassingItem: memberSql(kit, sup, `update public.inspection_items set punch_item_id=${q(chosen.row.id)} where id=${q(header.id)}`),
    repointToAnotherItemsWork: memberSql(kit, sup, `update public.inspection_items set punch_item_id=${q(automatic.row.id)} where id=${q(blocking.id)}`),
    clearLink: memberSql(kit, sup, `update public.inspection_items set punch_item_id=null where id=${q(blocking.id)}`),
    linkToAnotherHome: memberSql(kit, sup, `update public.inspection_items set punch_item_id=${q(foreignPunch)} where id=${q(header.id)}`),
    raiseInAnotherHome: memberSql(kit, sup, `select public.raise_inspection_corrective_work(${q(org.orgId)},${q(foreign)},${q(sup.userId)},${q(blocking.id)},'{"title":"x","assigned_to":"${sup.userId}"}'::jsonb)`),
    raiseAsSomeoneElse: memberSql(kit, sup, `select public.raise_inspection_corrective_work(${q(org.orgId)},${q(projectId)},${q(org.owner.userId)},${q(header.id)},'{"title":"x","assigned_to":"${sup.userId}"}'::jsonb)`),
  }
  const links = kit.rows(`select id, punch_item_id from public.inspection_items where inspection_id=${q(inspection.id)}`)
  const linkOf = (id) => links.find((row) => row.id === id).punch_item_id
  const untouched = { blocking: linkOf(blocking.id) === chosen.row.id, bolts: linkOf(bolts.id) === automatic.row.id, header: linkOf(header.id) === null }

  equal(check, "wrong roles, passing items and unknown companies are refused, and a refused request leaves no work and no link behind", expected.expected.refusals, { ...refusals, ...afterRefusals })
  equal(check, "the failed item's corrective work is owned by the named company with its due date, linked to the item, with the photo as before evidence, one event and one audit", expected.expected.chosen, { ...chosen.observed, secondRaise })
  equal(check, "recording the failure raises the work for the other failed item, owned by the inspection's company, and the passing item gets none", expected.expected.automatic, { ...automatic.observed, headerLinked })
  equal(check, "a member cannot forge, re-point or clear the link through the data API, nor raise work in another home or as someone else", expected.expected.fence, { ...fence, untouched })
  return { orgId: org.orgId, projectId, inspectionId: inspection.id }
}

async function reinspectionRetainsPriorAndResolvesTheFailure(kit, expected, check) {
  const { org, projectId, inspections, punch, sup, start } = await setup(kit, "field-reinspect", 9, { name: "Victor Amaral", email: "victor.amaral@acceptance.example.test" })
  const admin = kit.addMember(org, "org_admin"), owner = org.owner
  const attemptDetail = (actor, inspectionId) => kit.as(actor, () => inspections.getInspection(inspectionId))
  const source = async (inspectionId) => lifecycle().inspectionReviewSource(await attemptDetail(owner, inspectionId))
  const failedItem = (detail) => detail.items.find((item) => item.prompt === "Fire blocking installed")
  const answer = async (actor, detail, outcome) => {
    for (const item of detail.items) await kit.as(actor, () => inspections.updateInspectionItem(item.id, item.prompt === "Fire blocking installed" && outcome === "fail" ? { response: "fail", note: "Fire blocking still missing at the stair wall" } : { response: "pass" }))
  }
  const work = (itemId) => kit.rows(`select p.id from public.inspection_items i join public.punch_items p on p.id=i.punch_item_id where i.id=${kit.q(itemId)}`)[0].id
  const resolve = async (punchId) => {
    const after = completion().homeFile(kit, org, projectId, `after-${punchId}.jpg`)
    kit.sql(`insert into public.file_links(org_id,project_id,file_id,entity_type,entity_id,link_role,created_by) values(${kit.q(org.orgId)},${kit.q(projectId)},${kit.q(after)},'punch_item',${kit.q(punchId)},'after',${kit.q(sup.userId)})`)
    await kit.as(sup, () => punch.updateProjectPunchItem(projectId, punchId, { status: "closed" }))
  }
  const reinspect = async (obligationId, inspectionId, detail) => ({ key: randomUUID(), request: { operation: "reinspect", obligationId, inspectionId, source: await source(inspectionId), correctionLinks: [{ failedItemId: failedItem(detail).id, punchId: work(failedItem(detail).id) }], correctionNote: "Fire blocking installed and photographed" } })
  const review = async (operation, obligationId, inspectionId) => ({ key: randomUUID(), request: { operation, obligationId, inspectionId, source: await source(inspectionId), reviewNote: "Reviewed the corrected fire blocking and the new checklist" } })

  // Attempt 1 fails.
  const first = await start()
  const required = await kit.as(sup, () => inspections.mutateInspectionObligation(projectId, { key: randomUUID(), request: { operation: "create", inspectionId: first.id, source: lifecycle().inspectionReviewSource(first) } }))
  await answer(sup, first, "fail")
  await kit.as(sup, () => inspections.completeInspection(first.id))
  const firstDone = await attemptDetail(sup, first.id)

  // A reinspection waits for the corrective work; then attempt 2 fails again and the failure stays open.
  const whileOpen = msg(await refuse(kit, sup, async () => inspections.mutateInspectionObligation(projectId, await reinspect(required.obligationId, first.id, firstDone))), /Resolve the linked corrective punch work/)
  await resolve(work(failedItem(firstDone).id))
  const second = await kit.as(sup, async () => inspections.mutateInspectionObligation(projectId, await reinspect(required.obligationId, first.id, firstDone)))
  const secondFresh = await attemptDetail(sup, second.inspectionId)
  await answer(sup, secondFresh, "fail")
  await kit.as(sup, () => inspections.completeInspection(second.inspectionId))
  const secondDone = await attemptDetail(sup, second.inspectionId)
  const reviewFailedAttempt = msg(await refuse(kit, owner, async () => inspections.mutateInspectionObligation(projectId, await review("accept", required.obligationId, second.inspectionId))), /Only a passing current attempt can be reviewed/)
  const afterFailedReinspection = kit.rows(`select accepted_inspection_id from public.inspection_obligations where id=${kit.q(required.obligationId)}`)[0].accepted_inspection_id

  // Attempt 3 passes, completed by someone who then cannot review it; a person who did not run it accepts.
  await resolve(work(failedItem(secondDone).id))
  const third = await kit.as(sup, async () => inspections.mutateInspectionObligation(projectId, await reinspect(required.obligationId, second.inspectionId, secondDone)))
  const thirdFresh = await attemptDetail(admin, third.inspectionId)
  await answer(admin, thirdFresh, "pass")
  await kit.as(admin, () => inspections.completeInspection(third.inspectionId))
  const superintendentAccepts = msg(await refuse(kit, sup, async () => inspections.mutateInspectionObligation(projectId, await review("accept", required.obligationId, third.inspectionId))), /Missing permission|inspection\.review|permission/i)
  const completerAccepts = msg(await refuse(kit, admin, async () => inspections.mutateInspectionObligation(projectId, await review("accept", required.obligationId, third.inspectionId))), /independent reviewer/)
  const accepted = await kit.as(owner, async () => inspections.mutateInspectionObligation(projectId, await review("accept", required.obligationId, third.inspectionId)))

  const attempts = kit.rows(`select a.attempt_number n, a.inspection_id, a.prior_inspection_id prior, i.status, i.result, a.correction_evidence from public.inspection_attempts a join public.inspections i on i.id=a.inspection_id where a.obligation_id=${kit.q(required.obligationId)} order by a.attempt_number`)
  const original = await attemptDetail(owner, first.id)
  const originalFailure = failedItem(original)
  const obligation = kit.rows(`select accepted_inspection_id, required_for_closing from public.inspection_obligations where id=${kit.q(required.obligationId)}`)[0]
  const listed = await kit.as(sup, () => inspections.listInspectionObligations(projectId))
  const evidenceNames = (row) => (row.correction_evidence?.items ?? []).map((item) => item.punchId)
  equal(check, "a reinspection is refused while the corrective work is open, starts a new attempt with the same prompts unanswered, and a failed reinspection leaves the obligation unaccepted", expected.expected.failedReinspection, {
    whileOpen, attemptNumber: second.attemptNumber,
    secondStart: secondFresh.items.map((item) => ({ prompt: item.prompt, response: item.response })),
    secondResult: secondDone.result, reviewFailedAttempt, accepted: afterFailedReinspection,
  })
  equal(check, "the passing reinspection needs a reviewer who did not run it; acceptance resolves the obligation on the third attempt", expected.expected.acceptance, {
    attemptNumber: third.attemptNumber, superintendentAccepts, completerAccepts, decision: accepted.decision,
    acceptedIsThirdAttempt: obligation.accepted_inspection_id === third.inspectionId, requiredForClosing: obligation.required_for_closing,
  })
  equal(check, "every attempt is retained with its result, its prior attempt and the resolved corrective work it relied on, and the original failure is untouched", expected.expected.retained, {
    attempts: attempts.map((row) => ({ n: row.n, status: row.status, result: row.result, prior: row.prior === null ? null : attempts.find((other) => other.inspection_id === row.prior)?.n })),
    secondRelied: evidenceNames(attempts[1]).includes(work(failedItem(firstDone).id)), thirdRelied: evidenceNames(attempts[2]).includes(work(failedItem(secondDone).id)),
    original: { status: original.status, result: original.result, response: originalFailure.response, note: originalFailure.note, punchKept: originalFailure.punch_item_id === work(originalFailure.id) },
    listedObligations: listed.rows.length, attemptsListed: listed.rows[0].attempt_count,
  })
  return { orgId: org.orgId, projectId, obligationId: required.obligationId }
}

module.exports = {
  subcases: {
    "failed-item-raises-owned-linked-corrective-work": failedItemRaisesOwnedLinkedCorrectiveWork,
    "reinspection-retains-prior-and-resolves-the-failure": reinspectionRetainsPriorAndResolvesTheFailure,
  },
}
