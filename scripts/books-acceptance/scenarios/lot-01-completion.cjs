// LOT-01 workflow proof: completion (EP09-04, EP09-05, EP12-01, EP12-02).
// Fresh homes are made for every case; the chain's closed home (lot index 0) is never touched.
// See lot-01.cjs for the chain these subcases build on.
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const { app } = require("./shared.cjs")

const lot = () => require("./lot-01.cjs").helpers
const lifecycle = () => require("../../../lib/inspections/lifecycle")
const refuse = (kit, actor, work) => lot().refusal(() => kit.as(actor, work))
const equal = (check, label, expected, observed) => lot().equal(check, label, expected, observed)
const msg = (text, pattern) => (pattern.test(text) ? "refused" : text)

// The inspection lifecycle is the server-controlled cutover INSPECTION_LIFECYCLE_ENABLED. The stack
// carries its migration; the flag is switched on for the case and restored.
async function withInspectionLifecycle(work) {
  const before = process.env.INSPECTION_LIFECYCLE_ENABLED
  process.env.INSPECTION_LIFECYCLE_ENABLED = "true"
  try { return await work() } finally { if (before === undefined) delete process.env.INSPECTION_LIFECYCLE_ENABLED; else process.env.INSPECTION_LIFECYCLE_ENABLED = before }
}

// A presold home on one of the developed lots: reserved, agreement executed, closing projected.
const HOMES = new WeakMap()
async function freshHome(kit, key, lotIndex, buyer) {
  const homes = HOMES.get(kit) ?? (HOMES.set(kit, new Map()), HOMES.get(kit))
  if (!homes.has(key)) homes.set(key, (async () => {
    const { org } = await lot().stage(kit, "land")
    const target = org.lots[lotIndex]
    const prospect = await seed.registerBuyer(kit, org, buyer)
    const { reservation } = await seed.reserveLot(kit, org, { prospect, lotId: target.id, depositCents: 1000000, receivedOn: "2026-06-06" })
    const sale = await seed.signAgreement(kit, org, { reservationId: reservation.id, config: seed.configuration(org, { lotId: target.id, plan: org.plans[0], swing: lotIndex % 2 ? "left" : "right", skus: ["ST-GAR"] }) })
    // The owner assigns the house's superintendent, which scopes them to it as the field project role.
    // DEFECT: setProjectSuperintendent reads `roles` with the caller's client and `roles` is service-role only,
    // so the assignment fails with "Field project role is missing." (see owner-assigns-the-houses-superintendent).
    // The scoping row the function would write is written directly so the other cases can act as the superintendent.
    const assignment = await refuse(kit, org.owner, () => app("starts").setProjectSuperintendent(sale.projectId, org.team.superintendent.userId))
    if (assignment !== "allowed") kit.sql(`update public.projects set superintendent_id=${kit.q(org.team.superintendent.userId)} where id=${kit.q(sale.projectId)};
insert into public.project_members(org_id,project_id,user_id,role_id,status) select ${kit.q(org.orgId)},${kit.q(sale.projectId)},${kit.q(org.team.superintendent.userId)},id,'active' from public.roles where key='field' and scope='project' on conflict (project_id,user_id) do nothing;`)
    const closingId = kit.rows(`select id from public.closings where project_id=${kit.q(sale.projectId)} and status<>'cancelled'`)[0].id
    return { org, projectId: sale.projectId, closingId, assignment }
  })())
  return homes.get(key)
}

// A photo or file record on the home (file storage is not on the stack, as for the plot plan).
function homeFile(kit, org, projectId, name) {
  const id = randomUUID()
  kit.sql(`insert into public.files(id,org_id,project_id,file_name,storage_path,metadata) values(${kit.q(id)},${kit.q(org.orgId)},${kit.q(projectId)},${kit.q(name)},${kit.q(`acceptance/${id}`)},'{}')`)
  return id
}

const daysFromToday = (date) => Math.round((Date.parse(date) - Date.parse(seed.isoDay(0))) / 86400000)
const count = (kit, sql) => Number(kit.rows(`select count(*)::int n from (${sql}) t`)[0].n)

// ---------------------------------------------------------------------------
// EP09-04: inspection failure lifecycle

async function failedInspectionBecomesOwnedCorrectiveWork(kit, expected, check) {
  return withInspectionLifecycle(async () => {
    const { org, projectId, closingId } = await freshHome(kit, "inspection", 5, { name: "Elena Ortiz", email: "elena.ortiz@acceptance.example.test" })
    const inspections = app("inspections"), punch = app("punch-lists"), closings = app("closings")
    const sup = org.team.superintendent, owner = org.owner
    const vendor = org.vendorIds["Palmetto Framing"]

    // Wrong roles cannot run the inspection at all.
    const roleRefusals = {
      salesCreatesTemplate: msg(await refuse(kit, org.team.sales, () => inspections.createChecklistTemplate({ name: "Not mine", kind: "quality", items: [{ prompt: "x" }] })), /Missing permission/),
      warrantyCompletes: "pending",
    }
    const template = await kit.as(sup, () => inspections.createChecklistTemplate({ name: "Framing inspection", kind: "quality", items: [
      { section: "Structure", prompt: "Header sizes match plan", response_type: "pass_fail" },
      { section: "Structure", prompt: "Fire blocking installed", response_type: "pass_fail" },
      { section: "Structure", prompt: "Anchor bolts spaced", response_type: "pass_fail" },
    ] }))
    const original = await kit.as(sup, () => inspections.createInspection({ project_id: projectId, template_id: template.id, kind: "quality", title: "Framing inspection" }))
    roleRefusals.warrantyCompletes = msg(await refuse(kit, org.team.warranty, () => inspections.completeInspection(original.id)), /Missing permission|not authorized|permission/i)
    const required = await kit.as(sup, () => inspections.mutateInspectionObligation(projectId, { key: randomUUID(), request: { operation: "create", inspectionId: original.id, source: lifecycle().inspectionReviewSource(original) } }))

    // The inspector records answers; one item fails with a note and a photo.
    const photoId = homeFile(kit, org, projectId, "fire-blocking-fail.jpg")
    const [header, blocking, bolts] = original.items
    await kit.as(sup, () => inspections.updateInspectionItem(header.id, { response: "pass" }))
    await kit.as(sup, () => inspections.updateInspectionItem(blocking.id, { response: "fail", note: "Fire blocking missing at the stair wall", photo_file_id: photoId }))
    await kit.as(sup, () => inspections.updateInspectionItem(bolts.id, { response: "pass" }))
    const completed = await kit.as(sup, () => inspections.completeInspection(original.id))
    const receipt = kit.rows(`select r.result, r.actor_id, (select count(*)::int from public.events where id=r.event_id) events, (select count(*)::int from public.audit_log where id=r.audit_id) audits from public.inspection_completion_receipts r where r.inspection_id=${kit.q(original.id)}`)[0]

    // Corrective work from the failed item only: a passing item is refused, the sales desk is refused.
    const passingItemRefused = msg(await refuse(kit, sup, () => inspections.createPunchItemFromInspectionItem(header.id, {})), /requires a deficient inspection item/)
    roleRefusals.salesCreatesCorrectiveWork = msg(await refuse(kit, org.team.sales, () => inspections.createPunchItemFromInspectionItem(blocking.id, { company_id: vendor, due_date: seed.isoDay(5) })), /Missing permission/)
    // Completing the failed inspection raised the corrective work itself, from the failed item only. The
    // inspection names no company, so the inspector owns it until a responsible company and a date are set.
    const raised = kit.rows(`select i.prompt, i.punch_item_id, p.assigned_to, p.assigned_company_id, p.created_by, p.verification_required, p.created_from_inspection from public.inspection_items i left join public.punch_items p on p.id=i.punch_item_id where i.inspection_id=${kit.q(original.id)} order by i.sort_order, i.prompt`)
    const linked = { punch_item_id: raised.find((row) => row.prompt === blocking.prompt).punch_item_id }
    const autoRaised = {
      linkedItems: raised.filter((row) => row.punch_item_id).map((row) => row.prompt),
      ownedByInspector: raised.find((row) => row.punch_item_id).assigned_to === sup.userId && raised.find((row) => row.punch_item_id).created_by === sup.userId,
      fromInspection: raised.find((row) => row.punch_item_id).created_from_inspection,
      verificationRequired: raised.find((row) => row.punch_item_id).verification_required,
      punchItems: count(kit, `select 1 from public.punch_items where project_id=${kit.q(projectId)} and created_from_inspection`),
    }
    const secondPunchRefused = msg(await refuse(kit, sup, () => inspections.createPunchItemFromInspectionItem(blocking.id, {})), /already has a punch item/)
    await kit.as(sup, () => punch.updateProjectPunchItem(projectId, linked.punch_item_id, { assigned_company_id: vendor, due_date: seed.isoDay(5) }))
    const corrective = kit.rows(`select title, status, created_from_inspection, due_date::text due, assigned_company_id, assigned_to, created_by, dispatched_at is not null dispatched from public.punch_items where id=${kit.q(linked.punch_item_id)}`)[0]
    const evidence = kit.rows(`select file_id, link_role from public.file_links where entity_type='punch_item' and entity_id=${kit.q(linked.punch_item_id)}`)
    const creationEvent = count(kit, `select 1 from public.events where org_id=${kit.q(org.orgId)} and event_type='punch_item_created' and entity_id=${kit.q(linked.punch_item_id)} and payload->>'from_inspection'=${kit.q(original.id)}`)
    const creationAudit = count(kit, `select 1 from public.audit_log where org_id=${kit.q(org.orgId)} and entity_type='punch_item' and entity_id=${kit.q(linked.punch_item_id)} and action='insert'`)

    // A reinspection cannot start while the corrective work is open.
    const originalSource = lifecycle().inspectionReviewSource(await kit.as(sup, () => inspections.getInspection(original.id)))
    const reinspect = (note = "Fire blocking installed and photographed") => ({ key: randomUUID(), request: { operation: "reinspect", obligationId: required.obligationId, inspectionId: original.id, source: originalSource, correctionLinks: [{ failedItemId: blocking.id, punchId: linked.punch_item_id }], correctionNote: note } })
    const reinspectWhileOpen = msg(await refuse(kit, sup, () => inspections.mutateInspectionObligation(projectId, reinspect())), /Resolve the linked corrective punch work/)

    // Closing is refused while the required inspection has no accepted attempt.
    await kit.as(owner, () => closings.scheduleClosing({ closingId, scheduledDate: seed.isoDay(30) }))
    for (const item of kit.rows(`select id from public.closing_checklist_items where closing_id=${kit.q(closingId)} and is_gate`))
      await kit.as(owner, () => closings.updateClosingChecklistItem({ itemId: item.id, status: "waived", notes: "Verified at the closing table by the title agent." }))
    const closeWhileFailed = await refuse(kit, owner, () => closings.markClearedToClose(closingId))

    // The corrective work is resolved; the inspector reinspects. The original attempt is kept.
    const closeWithoutEvidence = msg(await refuse(kit, sup, () => punch.updateProjectPunchItem(projectId, linked.punch_item_id, { status: "closed" })), /Add verification evidence/)
    const afterPhoto = homeFile(kit, org, projectId, "fire-blocking-after.jpg")
    kit.sql(`insert into public.file_links(org_id,project_id,file_id,entity_type,entity_id,link_role,created_by) values(${kit.q(org.orgId)},${kit.q(projectId)},${kit.q(afterPhoto)},'punch_item',${kit.q(linked.punch_item_id)},'after',${kit.q(sup.userId)})`)
    await kit.as(sup, () => punch.updateProjectPunchItem(projectId, linked.punch_item_id, { status: "closed" }))
    const next = await kit.as(sup, () => inspections.mutateInspectionObligation(projectId, reinspect()))
    const second = await kit.as(sup, () => inspections.getInspection(next.inspectionId))
    const secondStart = second.items.map((item) => ({ prompt: item.prompt, response: item.response, deficient: item.is_deficient }))
    for (const item of second.items) await kit.as(sup, () => inspections.updateInspectionItem(item.id, { response: "pass" }))
    const secondDone = await kit.as(sup, () => inspections.completeInspection(next.inspectionId))

    // Only an independent reviewer with inspection.review accepts; the superintendent cannot.
    const accept = (attempt, detail) => ({ key: randomUUID(), request: { operation: "accept", obligationId: required.obligationId, inspectionId: attempt, source: lifecycle().inspectionReviewSource(detail), reviewNote: "Reviewed the corrected fire blocking and the new checklist" } })
    const secondDetail = await kit.as(owner, () => inspections.getInspection(next.inspectionId))
    const superintendentAccepts = msg(await refuse(kit, sup, () => inspections.mutateInspectionObligation(projectId, accept(next.inspectionId, secondDetail))), /Missing permission|inspection\.review|permission/i)
    const originalDetail = await kit.as(owner, () => inspections.getInspection(original.id))
    const staleAttemptAccept = msg(await refuse(kit, owner, () => inspections.mutateInspectionObligation(projectId, accept(original.id, originalDetail))), /newer attempt/)
    const accepted = await kit.as(owner, () => inspections.mutateInspectionObligation(projectId, accept(next.inspectionId, secondDetail)))

    const history = kit.rows(`select a.attempt_number, a.inspection_id, a.prior_inspection_id, i.status, i.result, a.correction_evidence from public.inspection_attempts a join public.inspections i on i.id=a.inspection_id where a.obligation_id=${kit.q(required.obligationId)} order by a.attempt_number`)
    const originalAfter = kit.rows(`select i.status, i.result, (select response from public.inspection_items where id=${kit.q(blocking.id)}) response, (select note from public.inspection_items where id=${kit.q(blocking.id)}) note, (select photo_file_id from public.inspection_items where id=${kit.q(blocking.id)}) photo, (select punch_item_id from public.inspection_items where id=${kit.q(blocking.id)}) punch from public.inspections i where i.id=${kit.q(original.id)}`)[0]
    const obligation = kit.rows(`select accepted_inspection_id, required_for_closing from public.inspection_obligations where id=${kit.q(required.obligationId)}`)[0]
    const closedPunch = kit.rows(`select status, resolved_by from public.punch_items where id=${kit.q(linked.punch_item_id)}`)[0]
    const cleared = await kit.as(owner, () => closings.markClearedToClose(closingId))
    const readableObligations = await kit.as(sup, () => inspections.listInspectionObligations(projectId))

    equal(check, "wrong roles cannot run inspections or spawn corrective work", expected.expected.roleRefusals, roleRefusals)
    equal(check, "a failed inspection records its result with a receipt, event and audit, and spawns corrective work only from the failed item", expected.expected.failure, {
      result: completed.result, receipt: { result: receipt.result, byInspector: receipt.actor_id === sup.userId, events: receipt.events, audits: receipt.audits },
      passingItemRefused, secondPunchRefused,
    })
    equal(check, "completing the failed inspection raises the corrective work itself, from the failed item only, owned by the inspector and requiring evidence to close", expected.expected.autoRaised, { ...autoRaised, closeWithoutEvidence })
    equal(check, "the corrective punch item is owned: assigned company, due date, owner, creator, dispatched, tied to the inspection with the photo as before evidence", expected.expected.correctiveWork, {
      title: corrective.title, status: corrective.status, fromInspection: corrective.created_from_inspection, dueInDays: daysFromToday(corrective.due),
      company: corrective.assigned_company_id === vendor, owner: corrective.assigned_to === sup.userId, createdBy: corrective.created_by === sup.userId, dispatched: corrective.dispatched,
      evidence: evidence.map((row) => ({ file: row.file_id === photoId, role: row.link_role })), creationEvent, creationAudit,
    })
    equal(check, "reinspection is refused while the corrective work is open, and closing is refused while the required inspection has no accepted attempt", expected.expected.gates, {
      reinspectWhileOpen, closeWhileFailed: msg(closeWhileFailed, /Required inspection readiness/),
    })
    equal(check, "the reinspection is a new attempt: same prompts, empty answers, the prior attempt linked and the resolved punch captured as correction evidence", expected.expected.reinspection, {
      attemptNumber: next.attemptNumber, secondStart, secondResult: secondDone.result, history: history.map((row) => ({ attempt: row.attempt_number, prior: row.prior_inspection_id === original.id ? "original" : row.prior_inspection_id, result: row.result, status: row.status })),
      correctionEvidence: JSON.stringify(history[1].correction_evidence).includes(linked.punch_item_id),
    })
    equal(check, "the original failure stays on the record and is resolved by an independent review of the new attempt", expected.expected.resolution, {
      superintendentAccepts, staleAttemptAccept, decision: accepted.decision,
      original: { status: originalAfter.status, result: originalAfter.result, response: originalAfter.response, note: originalAfter.note, photoKept: originalAfter.photo === photoId, punchKept: originalAfter.punch === linked.punch_item_id },
      acceptedIsNewAttempt: obligation.accepted_inspection_id === next.inspectionId, requiredForClosing: obligation.required_for_closing,
      correctivePunch: closedPunch.status, cleared: cleared.status, obligationsListed: readableObligations.rows.length, attemptsOnObligation: readableObligations.rows[0].attempt_count,
    })
    return { orgId: org.orgId, projectId, obligationId: required.obligationId }
  })
}

// ---------------------------------------------------------------------------
// EP09-05: punch responsibility, verification and close readiness

async function punchTraceabilityAndCloseReadiness(kit, expected, check) {
  return withInspectionLifecycle(async () => {
    const { org, projectId, closingId } = await freshHome(kit, "punch", 6, { name: "Marcus Bell", email: "marcus.bell.punch@acceptance.example.test" })
    const punch = app("punch-lists"), closings = app("closings"), readiness = app("project-close-readiness")
    const sup = org.team.superintendent, owner = org.owner
    const vendorA = org.vendorIds["Bright Electric"], vendorB = org.vendorIds["Coastal Plumbing"]
    const due = seed.isoDay(-3)

    // Who may write punch: the superintendent; not sales, warranty or the land desk. The assignee must be a member and the company real.
    const refusals = {
      sales: msg(await refuse(kit, org.team.sales, () => punch.createProjectPunchItem(projectId, { title: "Not mine" })), /Missing permission/),
      warranty: msg(await refuse(kit, org.team.warranty, () => punch.createProjectPunchItem(projectId, { title: "Not mine" })), /Missing permission/),
      land: msg(await refuse(kit, org.team.land, () => punch.createProjectPunchItem(projectId, { title: "Not mine" })), /Missing permission/),
      assigneeNotMember: msg(await refuse(kit, sup, () => punch.createProjectPunchItem(projectId, { title: "x", assigned_to: randomUUID() })), /not a member/),
      companyUnknown: msg(await refuse(kit, sup, () => punch.createProjectPunchItem(projectId, { title: "x", assigned_company_id: randomUUID() })), /Assigned company not found/),
    }
    // A second superintendent who is not assigned to this house is outside its scope.
    const otherSuper = kit.addMember(org, "org_superintendent")
    refusals.unassignedSuperintendent = msg(await refuse(kit, otherSuper, () => punch.createProjectPunchItem(projectId, { title: "Not my house" })), /row-level security|Missing permission|not authorized|access/i)
    const leadItem0 = await kit.as(sup, () => punch.createProjectPunchItem(projectId, { title: "Lead walk: touch up paint at entry", severity: "minor" }))

    const verified = await kit.as(sup, () => punch.createProjectPunchItem(projectId, { title: "Replace cracked GFCI cover in garage", description: "Failed walk", severity: "major", due_date: due, assigned_to: sup.userId, assigned_company_id: vendorA, verification_required: true }))
    const plain = await kit.as(sup, () => punch.createProjectPunchItem(projectId, { title: "Caulk tub surround", due_date: seed.isoDay(10), assigned_company_id: vendorB }))
    const created = kit.rows(`select id, status, due_date::text due, assigned_to, assigned_company_id, created_by, verification_required, dispatched_at is not null dispatched from public.punch_items where id in (${kit.q(verified.id)}, ${kit.q(plain.id)}) order by title`)
    const traceCreated = count(kit, `select 1 from public.events where org_id=${kit.q(org.orgId)} and event_type='punch_item_created' and entity_id in (${kit.q(verified.id)}, ${kit.q(plain.id)})`) + count(kit, `select 1 from public.audit_log where org_id=${kit.q(org.orgId)} and entity_type='punch_item' and action='insert' and entity_id in (${kit.q(verified.id)}, ${kit.q(plain.id)})`)

    // Unresolved required defects block close readiness, on the readiness read and on the closing itself.
    const before = await kit.as(owner, () => readiness.getProjectCloseReadiness(projectId))
    const field = (report) => report.sections.find((section) => section.key === "field")
    const blockersBefore = field(before).issues.filter((issue) => issue.id.startsWith("punch-")).map((issue) => ({ id: issue.id === `punch-${verified.id}` ? "verified" : issue.id === `punch-${plain.id}` ? "plain" : "lead", detail: issue.detail }))
    await kit.as(owner, () => closings.scheduleClosing({ closingId, scheduledDate: seed.isoDay(30) }))
    for (const item of kit.rows(`select id from public.closing_checklist_items where closing_id=${kit.q(closingId)} and is_gate`))
      await kit.as(owner, () => closings.updateClosingChecklistItem({ itemId: item.id, status: "waived", notes: "Verified at the closing table by the title agent." }))
    const refusedOpen = await refuse(kit, owner, () => closings.markClearedToClose(closingId))

    // Closing a verification-required item takes evidence; dropping the requirement in the same save does not skip it.
    const closeNoEvidence = await refuse(kit, sup, () => punch.updateProjectPunchItem(projectId, verified.id, { status: "closed" }))
    const dropRequirement = await refuse(kit, sup, () => punch.updateProjectPunchItem(projectId, verified.id, { status: "closed", verification_required: false }))
    homeFile(kit, org, projectId, "gfci-after.jpg")
    const afterFile = kit.rows(`select id from public.files where project_id=${kit.q(projectId)} and file_name='gfci-after.jpg'`)[0].id
    kit.sql(`insert into public.file_links(org_id,project_id,file_id,entity_type,entity_id,link_role,created_by) values(${kit.q(org.orgId)},${kit.q(projectId)},${kit.q(afterFile)},'punch_item',${kit.q(verified.id)},'after',${kit.q(sup.userId)})`)
    const closedVerified = await kit.as(sup, () => punch.updateProjectPunchItem(projectId, verified.id, { status: "closed", verification_notes: "Cover replaced; photo attached" }))
    const stillBlockedByOthers = await refuse(kit, owner, () => closings.markClearedToClose(closingId))
    const bulk = await kit.as(sup, () => punch.bulkAssignPunchCompany(projectId, [plain.id], vendorA))
    for (const id of [plain.id]) await kit.as(sup, () => punch.updateProjectPunchItem(projectId, id, { status: "closed" }))
    await kit.as(sup, () => punch.updateProjectPunchItem(projectId, leadItem0.id, { status: "closed" }))

    const after = await kit.as(owner, () => readiness.getProjectCloseReadiness(projectId))
    const cleared = await kit.as(owner, () => closings.markClearedToClose(closingId))
    const trace = kit.rows(`select status, verification_required, verified_by, verified_at is not null verified, resolved_by, resolved_at is not null resolved, verification_notes, assigned_to, assigned_company_id, due_date::text due from public.punch_items where id=${kit.q(verified.id)}`)[0]
    const updates = count(kit, `select 1 from public.audit_log where org_id=${kit.q(org.orgId)} and entity_type='punch_item' and entity_id=${kit.q(verified.id)} and action='update' and after_data->>'verified_by'=${kit.q(sup.userId)}`)
    const closeEvents = count(kit, `select 1 from public.events where org_id=${kit.q(org.orgId)} and event_type='punch_item_updated' and entity_id=${kit.q(verified.id)} and payload->>'status'='closed'`)
    const roleGrants = Object.fromEntries(kit.rows(`select r.key, array_agg(p.permission_key order by p.permission_key) filter (where p.permission_key in ('punch.read','punch.write')) keys from public.roles r left join public.role_permissions p on p.role_id=r.id where r.key in ('org_owner','org_project_lead','pm','field','org_superintendent','org_sales_agent','org_warranty_manager') group by r.key order by r.key`).map((row) => [row.key, row.keys ?? []]))

    equal(check, "punch write belongs to the house's assigned superintendent (and the owner, lead, manager and field roles); an unassigned superintendent, sales, warranty and land are refused; assignees and companies must be real", expected.expected.responsibility, { refusals, roleGrants })
    equal(check, "a punch item records its owner, responsible company, due date, creator and dispatch, with an event and audit row each", expected.expected.created, {
      items: created.map((row) => ({ status: row.status, dueInDays: daysFromToday(row.due), owner: row.assigned_to === sup.userId, company: row.assigned_company_id === vendorA ? "electric" : row.assigned_company_id === vendorB ? "plumbing" : null, createdBy: row.created_by === sup.userId, verificationRequired: row.verification_required, dispatched: row.dispatched })),
      eventAndAuditRows: traceCreated, bulkReassigned: bulk.map((row) => row.assigned_company_id === vendorA),
    })
    equal(check, "unresolved punch blocks close readiness (the verification-required item says so) and blocks the closing itself", expected.expected.blocked, {
      state: before.state, fieldBlockers: field(before).blockerCount, blockers: blockersBefore.sort((a, b) => a.id.localeCompare(b.id)),
      closingRefused: msg(refusedOpen, /Open punch items must be cleared/),
    })
    equal(check, "verification is traceable: closing needs after-evidence, the closer is stamped as verifier, and the audit and event rows show it", expected.expected.verification, {
      closeNoEvidence: msg(closeNoEvidence, /Add verification evidence/), dropRequirement: msg(dropRequirement, /Add verification evidence/),
      closed: closedVerified.status, verifiedBy: trace.verified_by === sup.userId, verifiedAt: trace.verified, resolvedBy: trace.resolved_by === sup.userId, resolvedAt: trace.resolved, notes: trace.verification_notes,
      auditUpdatesWithVerifier: updates, closeEvents,
    })
    equal(check, "with every item closed and verified the readiness has no field blockers and the closing is cleared; one still-open item keeps it refused", expected.expected.released, {
      stillBlockedByOthers: msg(stillBlockedByOthers, /Open punch items must be cleared/), fieldBlockers: field(after).blockerCount, punchIssues: field(after).issues.filter((issue) => issue.id.startsWith("punch-")).length, cleared: cleared.status,
    })
    return { orgId: org.orgId, projectId }
  })
}

// The owner assigns the house's superintendent; that scopes them to the house as the field project role.
async function ownerAssignsTheHousesSuperintendent(kit, expected, check) {
  const { org, projectId, assignment } = await freshHome(kit, "punch", 6, { name: "Marcus Bell", email: "marcus.bell.punch@acceptance.example.test" })
  const member = kit.rows(`select r.key from public.project_members m join public.roles r on r.id=m.role_id where m.project_id=${kit.q(projectId)} and m.user_id=${kit.q(org.team.superintendent.userId)} and m.status='active'`)
  equal(check, "assigning a superintendent to a house succeeds and scopes them to it with the field project role", expected.expected, { assignment, projectRoles: member.map((row) => row.key) })
  return { orgId: org.orgId, projectId }
}


// ---------------------------------------------------------------------------
// EP12-01 / EP12-02: open-WIP cutover through the real importer.
// Open-WIP cutover is restricted to the platform onboarding workbench (requireImporterPermission), so the
// cutover is run by a platform operator on the customer's behalf; the org owner is shown refused.

const OFFSETS = [["Permit release", -35, 1], ["Foundation", 0, 14], ["Framing", 14, 21], ["Dry-in", 35, 10], ["MEP rough", 45, 18], ["Drywall", 63, 14], ["Interior finishes", 77, 28], ["Punch and close", 105, 14]]
const HOUSE_HEADERS = ["community", "lot_number", "block", "plan_code", "elevation_code", "stage_task", "stage_date", "budget_total_cents", "sold", "buyer_name", "buyer_email", "sale_price_cents", "sale_date"]
const BUDGET_HEADERS = ["community", "lot_number", "cost_code", "budget_cents"]
const PO_HEADERS = ["community", "lot_number", "po_number", "vendor", "cost_code", "description", "remaining_cents", "original_cents"]
const COMMUNITY = "Cypress Landing"

// requireAuth reads the signed-in user from request cookies, which the harness has no request for. The
// platform path asks it who is calling, so it is answered with the actor the harness is acting as; the
// platform permission check that follows is the real one, against platform_memberships.
let platformAuthPatched = false
function actAsSignedInUser() {
  if (platformAuthPatched) return
  const auth = require("../../../lib/auth/context")
  const { requireOrgContext } = require("../../../lib/services/context")
  auth.requireAuth = async () => { const context = await requireOrgContext(); return { user: { id: context.userId, email: null } } }
  platformAuthPatched = true
}

const CUTOVER = new WeakMap()
function cutover(kit) {
  if (!CUTOVER.has(kit)) CUTOVER.set(kit, (async () => {
    actAsSignedInUser()
    const { org } = await lot().stage(kit, "land")
    const imports = app("imports")
    // A platform operator is a separate identity with a platform role, not a member of the customer's org tier.
    const ops = kit.addMember(org, "org_viewer")
    kit.sql(`insert into public.platform_memberships(user_id,role_id,status) select ${kit.q(ops.userId)}, id, 'active' from public.roles where key='platform_admin'`)
    const stage = (csv, context, onboardingRunId = null, who = ops) => kit.as(who, () => imports.stageImportBatch({ importer: "open_wip", csvText: seed.csv(csv.headers, csv.rows), sourceFilename: `${context.file_kind}-${context.as_of_date}.csv`, context, onboardingRunId }, { platformOrgId: org.orgId }))
    const commit = (batchId) => kit.as(ops, () => imports.commitImportBatch(batchId, { platformOrgId: org.orgId }))
    return { org, ops, imports, stage, commit }
  })())
  return CUTOVER.get(kit)
}

const houseRow = (lotNumber, over = {}) => ({ community: COMMUNITY, lot_number: lotNumber, block: "", plan_code: "MG1650", elevation_code: "A", stage_task: "Framing", stage_date: "2026-09-20", sold: "no", buyer_name: "", buyer_email: "", sale_price_cents: "", sale_date: "", ...over })
const batchRows = (kit, batchId) => kit.rows(`select status, issues, parsed from public.import_rows where batch_id=${kit.q(batchId)} order by row_number`)
const issueCodes = (kit, batchId) => batchRows(kit, batchId).map((row) => row.issues.map((issue) => issue.code).sort())
const wipHomes = (kit, orgId, batchIds) => count(kit, `select 1 from public.projects where org_id=${kit.q(orgId)} and metadata->'wip_cutover'->>'batch_id' in (${batchIds.map(kit.q).join(",")})`)

async function openWipRejectsBadFilesBeforeAnyHome(kit, expected, check) {
  const { org, stage, commit, ops, imports } = await cutover(kit)
  const code = "31-000"
  const lotsAssignedBefore = count(kit, `select 1 from public.lots where org_id=${kit.q(org.orgId)} and lot_number in ('13','14','15','16','17') and project_id is not null`)
  const batches = []
  const track = (batch) => { batches.push(batch.id); return batch }
  const refusedCommit = async (batch) => msg(await lot().refusal(() => commit(batch.id)), /Batch must be staged with all errors fixed/)

  // The org owner cannot run the cutover; only the platform onboarding workbench can.
  const ownerRefusal = msg(await refuse(kit, org.owner, () => imports.stageImportBatch({ importer: "open_wip", csvText: seed.csv(BUDGET_HEADERS, [{ community: COMMUNITY, lot_number: "13", cost_code: code, budget_cents: "100" }]), context: { file_kind: "budgets", as_of_date: "2026-10-02" } })), /restricted to the platform onboarding workbench/)

  // Duplicate identity inside one file: the same house and cost code twice.
  const dupContext = { file_kind: "budgets", as_of_date: "2026-10-02" }
  const dupRows = [{ community: COMMUNITY, lot_number: "13", cost_code: code, budget_cents: "100" }, { community: COMMUNITY, lot_number: "13", cost_code: code, budget_cents: "250" }, { community: COMMUNITY, lot_number: "14", cost_code: code, budget_cents: "100" }]
  const dup = track(await stage({ headers: BUDGET_HEADERS, rows: dupRows }, dupContext))
  const duplicateInFile = { errorCount: dup.error_count, codes: issueCodes(kit, dup.id), commit: await refusedCommit(dup) }

  // Duplicate identity across two companion files for the same date: the house file will not be staged.
  const ctxB = { file_kind: "budgets", as_of_date: "2026-10-03" }
  const one = track(await stage({ headers: BUDGET_HEADERS, rows: [{ community: COMMUNITY, lot_number: "13", cost_code: code, budget_cents: "100" }] }, ctxB))
  const two = track(await stage({ headers: BUDGET_HEADERS, rows: [{ community: COMMUNITY, lot_number: "13", cost_code: code, budget_cents: "100" }] }, ctxB))
  const dupAcross = await lot().refusal(() => stage({ headers: HOUSE_HEADERS, rows: [houseRow("13", { budget_total_cents: "100" })] }, { file_kind: "houses", as_of_date: "2026-10-03" }))
  const failedHouseBatch = kit.rows(`select id, status from public.import_batches where org_id=${kit.q(org.orgId)} and importer='open_wip' and context->>'as_of_date'='2026-10-03' and context->>'file_kind'='houses'`)
  failedHouseBatch.forEach((row) => batches.push(row.id))

  // Wrong date: the budget snapshot is for another day.
  track(await stage({ headers: BUDGET_HEADERS, rows: [{ community: COMMUNITY, lot_number: "13", cost_code: code, budget_cents: "100" }] }, { file_kind: "budgets", as_of_date: "2026-10-04" }))
  const wrongDate = track(await stage({ headers: HOUSE_HEADERS, rows: [houseRow("13", { budget_total_cents: "100" })] }, { file_kind: "houses", as_of_date: "2026-10-05" }))
  const wrongDateResult = { errorCount: wrongDate.error_count, codes: issueCodes(kit, wrongDate.id), commit: await refusedCommit(wrongDate) }

  // Wrong run: the budget snapshot belongs to one onboarding run; the house file arrives without it, then with it.
  const run = randomUUID()
  kit.sql(`insert into public.onboarding_runs(id,org_id,created_by) values(${kit.q(run)},${kit.q(org.orgId)},${kit.q(ops.userId)})`)
  track(await stage({ headers: BUDGET_HEADERS, rows: [{ community: COMMUNITY, lot_number: "13", cost_code: code, budget_cents: "100" }] }, { file_kind: "budgets", as_of_date: "2026-10-06" }, run))
  const wrongRun = track(await stage({ headers: HOUSE_HEADERS, rows: [houseRow("13", { budget_total_cents: "100" })] }, { file_kind: "houses", as_of_date: "2026-10-06" }, null))
  const sameRun = track(await stage({ headers: HOUSE_HEADERS, rows: [houseRow("13", { budget_total_cents: "100" })] }, { file_kind: "houses", as_of_date: "2026-10-06" }, run))
  const runResult = { wrongRunErrors: wrongRun.error_count, wrongRunCodes: issueCodes(kit, wrongRun.id), wrongRunCommit: await refusedCommit(wrongRun), sameRunErrors: sameRun.error_count, sameRunStatus: sameRun.status }

  // Invalid required facts, one house each: missing plan, unreadable date, unknown community, unknown plan, budget that does not foot.
  const facts = { file_kind: "houses", as_of_date: "2026-10-07" }
  track(await stage({ headers: BUDGET_HEADERS, rows: [13, 14, 15, 16, 17].map((n) => ({ community: COMMUNITY, lot_number: String(n), cost_code: code, budget_cents: "100" })) }, { file_kind: "budgets", as_of_date: "2026-10-07" }))
  const invalid = track(await stage({ headers: HOUSE_HEADERS, rows: [
    houseRow("13", { budget_total_cents: "100", plan_code: "" }),
    houseRow("14", { budget_total_cents: "100", stage_date: "not a date" }),
    houseRow("15", { budget_total_cents: "100", community: "Maple Ridge" }),
    houseRow("16", { budget_total_cents: "100", plan_code: "NOPLAN" }),
    houseRow("17", { budget_total_cents: "999" }),
  ] }, facts))
  const invalidResult = { errorCount: invalid.error_count, codes: issueCodes(kit, invalid.id), commit: await refusedCommit(invalid) }

  const homesCreated = wipHomes(kit, org.orgId, batches)
  const lotsAssigned = -lotsAssignedBefore + count(kit, `select 1 from public.lots where org_id=${kit.q(org.orgId)} and lot_number in ('13','14','15','16','17') and project_id is not null`)
  equal(check, "the org owner cannot stage an open-WIP cutover", expected.expected.ownerRefusal, ownerRefusal)
  equal(check, "a duplicate house and cost code in one file is flagged on both rows and the batch cannot commit", expected.expected.duplicateInFile, duplicateInFile)
  equal(check, "the same row in two companion files for one date stops the house file before it is staged", expected.expected.duplicateAcrossFiles, { refused: msg(dupAcross, /Duplicate Open-WIP companion row/), houseBatchStatus: failedHouseBatch.map((row) => row.status) })
  equal(check, "a house file for another date finds no budget snapshot and cannot commit", expected.expected.wrongDate, wrongDateResult)
  equal(check, "a house file outside the budget snapshot's onboarding run cannot commit; inside the run it stages clean", expected.expected.wrongRun, runResult)
  equal(check, "missing plan, unreadable date, unknown community, unknown plan and a budget that does not foot each reject the house", expected.expected.invalidFacts, invalidResult)
  equal(check, "none of the rejected files created a home or assigned a lot", expected.expected.nothingCreated, { homesCreated, lotsAssigned })
  return { orgId: org.orgId }
}

// The cost-code list and the three files of a cutover large enough to need paging everywhere.
const CODE_COUNT = 1020
const HOUSES = 8
const BUDGET_LINES = 130
const PO_LINES = 63
const LOT_FIRST = 13

function cutoverData(codes, vendors) {
  const houses = Array.from({ length: HOUSES }, (_, h) => {
    const lotNumber = String(LOT_FIRST + h)
    const budget = Array.from({ length: BUDGET_LINES }, (_, i) => { const index = (h * 128 + i) % codes.length; return { community: COMMUNITY, lot_number: lotNumber, cost_code: codes[index], dollars: 1000 + (index % 50) * 10 } })
    const pos = Array.from({ length: PO_LINES }, (_, n) => { const index = (h * PO_LINES + n) % codes.length; const remaining = 500 + n * 5; return { community: COMMUNITY, lot_number: lotNumber, po_number: `PO-${lotNumber}-${n + 1}`, vendor: vendors[n % vendors.length], cost_code: codes[index], description: `Remaining scope ${n + 1}`, remaining_cents: String(remaining), original_cents: String(remaining + 250), remaining } })
    const sold = h < 4
    const task = h % 2 ? "Dry-in" : "Framing"
    return { lotNumber, budget, pos, sold, task, budgetCents: budget.reduce((total, line) => total + line.dollars * 100, 0), poRemainingCents: pos.reduce((total, line) => total + line.remaining * 100, 0), saleCents: (400000 + h * 5000) * 100 }
  })
  return houses
}

const LARGE = new WeakMap()
const largeCutover = (kit) => (LARGE.has(kit) ? LARGE.get(kit) : (LARGE.set(kit, runLargeCutover(kit)), LARGE.get(kit)))

async function runLargeCutover(kit) {
  const { org, ops, stage, commit, imports } = await cutover(kit)
  const owner = org.owner
  const vendors = seed.TRADES.map((trade) => trade.vendor)
  // The cutover houses stand on lots 13 to 20 (phase 2, still only controlled). A started house needs its land bought
  // in Books first, so the owner records that acquisition, as takeDownTranche does for the first tranche.
  const cutoverLots = org.lots.slice(LOT_FIRST - 1, LOT_FIRST - 1 + HOUSES)
  await kit.as(owner, () => app("books/inventory").acquireLandInventory({ date: "2026-06-03", allocations: cutoverLots.map((row) => ({ lotId: row.id, amountCents: org.landCentsPerLot })), cashAccountId: seed.glId(kit, org, "1000"), cashCents: org.landCentsPerLot * cutoverLots.length, debtInstrumentId: null, debtCents: 0, reference: "Cypress Landing phase 2 lots 13-20", evidenceUrl: `${seed.EVIDENCE}/phase-2` }))
  // 1,020 more cost codes, so the org has more than one lookup page (1,000). They are set up directly: the cost-code
  // importer saves row results with up to 500 concurrent requests, which this stack's API gateway drops past ~250
  // ("fetch failed"), so a batch that large cannot be committed here. The cutover files below are STAGED, not
  // committed, which is all the house commit needs from its companions.
  const newCodes = Array.from({ length: CODE_COUNT }, (_, i) => `W${String(i + 1).padStart(4, "0")}`)
  for (let i = 0; i < newCodes.length; i += 340)
    kit.sql(`insert into public.cost_codes(id,org_id,code,name) values ${newCodes.slice(i, i + 340).map((c) => `(gen_random_uuid(),${kit.q(org.orgId)},${kit.q(c)},${kit.q(`Cutover cost ${c}`)})`).join(",")};`)
  const codes = [...Object.keys(org.costCodeIds), ...newCodes]
  const houses = cutoverData(codes, vendors)
  const asOf = "2026-10-01"

  // Another organisation stages a same-named budget file for the same date: it must be invisible to this cutover.
  const other = kit.organization({ name: "Other builder with the same files", chart: [], productTier: "production" })
  const otherBatch = await kit.as(ops, () => imports.stageImportBatch({ importer: "open_wip", csvText: seed.csv(BUDGET_HEADERS, houses[0].budget.map((line) => ({ community: COMMUNITY, lot_number: line.lot_number, cost_code: line.cost_code, budget_cents: line.dollars }))), context: { file_kind: "budgets", as_of_date: asOf } }, { platformOrgId: other.orgId }))

  const budgets = await stage({ headers: BUDGET_HEADERS, rows: houses.flatMap((house) => house.budget.map((line) => ({ community: COMMUNITY, lot_number: line.lot_number, cost_code: line.cost_code, budget_cents: line.dollars }))) }, { file_kind: "budgets", as_of_date: asOf })
  const pos = await stage({ headers: PO_HEADERS, rows: houses.flatMap((house) => house.pos) }, { file_kind: "purchase_orders", as_of_date: asOf })
  const houseCsv = houses.map((house, h) => houseRow(house.lotNumber, { stage_task: house.task, budget_total_cents: house.budgetCents / 100, sold: house.sold ? "yes" : "no", buyer_name: house.sold ? `Buyer ${house.lotNumber}` : "", buyer_email: house.sold ? `buyer.${house.lotNumber}@acceptance.example.test` : "", sale_price_cents: house.sold ? house.saleCents / 100 : "", sale_date: house.sold ? "2026-08-15" : "" }))
  const staged = await stage({ headers: HOUSE_HEADERS, rows: houseCsv }, { file_kind: "houses", as_of_date: asOf })
  const unresolvedCostCodes = count(kit, `select 1 from public.import_rows where batch_id in (${kit.q(budgets.id)},${kit.q(pos.id)}) and issues @> '[{"code":"unresolved_cost_code"}]'`)
  const codeTotal = count(kit, `select 1 from public.cost_codes where org_id=${kit.q(org.orgId)}`)
  const stageCounts = { codesInOrg: codeTotal, budgetRows: budgets.row_count, budgetErrors: budgets.error_count, poRows: pos.row_count, poErrors: pos.error_count, houseRows: staged.row_count, houseErrors: staged.error_count, unresolvedCostCodes, otherOrgBatchRows: otherBatch.row_count }

  const housesCommitted = await commit(staged.id)
  const secondCommit = msg(await lot().refusal(() => commit(staged.id)), /Batch must be staged/)

  const homes = kit.rows(`select p.id, p.name, p.status, p.property_type, p.division_id, p.client_id, p.metadata, l.lot_number, l.status lot_status, l.house_plan_id, l.house_plan_version_id, l.house_plan_elevation_id from public.projects p join public.lots l on l.project_id=p.id where p.org_id=${kit.q(org.orgId)} and p.metadata->'wip_cutover'->>'batch_id'=${kit.q(staged.id)} order by l.lot_number::int`)
  const plan = org.plans[0]
  const division = kit.rows(`select division_id from public.communities where id=${kit.q(org.communityId)}`)[0].division_id
  const perHome = homes.map((home) => {
    const spec = houses.find((house) => house.lotNumber === home.lot_number)
    const budget = kit.rows(`select b.status, b.total_cents, (select count(*)::int from public.budget_lines where budget_id=b.id) lines, (select coalesce(sum(amount_cents),0)::bigint from public.budget_lines where budget_id=b.id) line_cents from public.budgets b where b.project_id=${kit.q(home.id)}`)
    const orders = kit.rows(`select count(*)::int n, coalesce(sum(total_cents),0)::bigint cents, count(*) filter (where status='approved' and commitment_type='purchase_order')::int approved, count(*) filter (where company_id is not null)::int "withVendor", count(*) filter (where (metadata->>'original_cents')::bigint = total_cents + 25000 and metadata->>'as_of_date'=${kit.q(asOf)} and metadata->>'imported_open_wip'='true')::int provenance from public.commitments where project_id=${kit.q(home.id)}`)[0]
    const agreement = kit.rows(`select c.status, c.contract_type, c.total_cents, c.effective_date::text effective, c.signed_at::date::text signed from public.contracts c where c.project_id=${kit.q(home.id)}`)
    const buyer = home.client_id ? kit.rows(`select full_name, email, contact_type from public.contacts where id=${kit.q(home.client_id)}`)[0] : null
    const schedule = kit.rows(`select name, status, progress, start_date::text start, end_date::text finish from public.schedule_items where project_id=${kit.q(home.id)} order by sort_order`)
    return {
      lot: home.lot_number, posture: home.property_type, status: home.status, division: home.division_id === division, lotStatus: home.lot_status,
      plan: home.house_plan_id === plan.id && home.house_plan_version_id === plan.versionId && home.house_plan_elevation_id === plan.elevationIds[0],
      provenance: home.metadata.wip_cutover.as_of_date === asOf && home.metadata.imported_open_wip === true,
      buyer: buyer ? { name: buyer.full_name, email: buyer.email, type: buyer.contact_type } : null,
      agreement: agreement.map((row) => ({ status: row.status, type: row.contract_type, totalCents: Number(row.total_cents), effective: row.effective, signed: row.signed })),
      budget: budget.map((row) => ({ status: row.status, totalCents: Number(row.total_cents), lines: row.lines, linesCents: Number(row.line_cents) })),
      purchaseOrders: { count: orders.n, cents: Number(orders.cents), approved: orders.approved, withVendor: orders.withVendor, provenance: orders.provenance },
      anchor: schedule.find((item) => item.status === "in_progress")?.name, schedule,
      specBudgetCents: spec.budgetCents, specPoCents: spec.poRemainingCents, specSaleCents: spec.saleCents, sold: spec.sold,
    }
  })
  const rowResults = kit.rows(`select status, action, count(*)::int n from public.import_rows where batch_id in (${kit.q(budgets.id)},${kit.q(pos.id)},${kit.q(staged.id)}) group by 1,2 order by 1,2`)
  const batchesAfter = kit.rows(`select status, row_count, committed_count, skipped_count, committed_at is not null stamped from public.import_batches where id in (${kit.q(budgets.id)},${kit.q(pos.id)},${kit.q(staged.id)}) order by row_count`)
  const scheduleOf = (lotNumber) => perHome.find((home) => home.lot === lotNumber).schedule.map((item) => ({ name: item.name, status: item.status, progress: item.progress, start: item.start, end: item.finish }))

  return { org, staged, perHome, scheduleOf, stageCounts, rowResults, batchesAfter, housesCommitted, secondCommit }
}

async function openWipCutoverRetainsTheHome(kit, expected, check) {
  const { org, staged, perHome, stageCounts, rowResults, batchesAfter, housesCommitted, secondCommit } = await largeCutover(kit)
  equal(check, "a 1,040-row budget file, a 504-row PO file and 1,020 added cost codes stage clean: every cost code resolves past the first lookup page, the other org's same-date file is invisible", expected.expected.staged, stageCounts)
  equal(check, "committing the house file writes its eight rows once, records its counts, and cannot be committed twice; the large companion files stay staged and untouched", expected.expected.committed, { rowResults: rowResults.map((row) => `${row.status}/${row.action}/${row.n}`), batches: batchesAfter.map((row) => ({ status: row.status, rows: row.row_count, committed: row.committed_count, skipped: row.skipped_count, stamped: row.stamped })), companions: batchesAfter.filter((row) => row.row_count > 8).map((row) => row.status), results: [housesCommitted.status], secondCommit })
  equal(check, "eight production homes exist on their lots with plan, elevation and cutover provenance", expected.expected.homes, perHome.map((home) => ({ lot: home.lot, posture: home.posture, status: home.status, division: home.division, lotStatus: home.lotStatus, plan: home.plan, provenance: home.provenance })))
  equal(check, "sold homes keep the buyer and an active purchase agreement at the sale price and date; unsold homes have neither", expected.expected.buyerAndAgreement, perHome.map((home) => ({ lot: home.lot, sold: home.sold, buyer: home.buyer, agreement: home.agreement, saleCents: home.specSaleCents })).map((home) => ({ lot: home.lot, buyer: home.buyer, agreement: home.agreement.map(({ totalCents, ...rest }) => rest), totalsMatch: home.agreement.map((row) => row.totalCents === home.saleCents) })))
  equal(check, "each home's approved budget has its 130 lines and foots to the house total", expected.expected.budget, perHome.map((home) => ({ lot: home.lot, budget: home.budget.map((row) => ({ status: row.status, lines: row.lines, foots: row.totalCents === row.linesCents, equalsHouseTotal: row.totalCents === home.specBudgetCents })) })))
  equal(check, "each home's remaining open POs are approved purchase orders at the remaining value with the original value and cutover date kept", expected.expected.purchaseOrders, perHome.map((home) => ({ lot: home.lot, count: home.purchaseOrders.count, approved: home.purchaseOrders.approved, withVendor: home.purchaseOrders.withVendor, provenance: home.purchaseOrders.provenance, remainingMatches: home.purchaseOrders.cents === home.specPoCents })))
  return { orgId: org.orgId, batchId: staged.id }
}

// The schedule keeps the plan template's shape: the current stage in progress from its stage date, the rest at their template offsets.
async function openWipScheduleFollowsThePlanTemplate(kit, expected, check) {
  const { org, perHome, scheduleOf } = await largeCutover(kit)
  equal(check, "the schedule is anchored at the current stage: earlier tasks completed, the stage in progress from its stage date, later tasks at their template offsets and durations", expected.expected, { anchors: perHome.map((home) => [home.lot, home.anchor]), framingHouse: scheduleOf(String(LOT_FIRST)), dryInHouse: scheduleOf(String(LOT_FIRST + 1)) })
  return { orgId: org.orgId }
}

// Failed writes and lot conflicts never complete a cutover.
async function openWipFailuresDoNotCompleteTheCutover(kit, expected, check) {
  const { org, stage, commit } = await cutover(kit)
  const asOfConflict = "2026-10-08", asOfWrite = "2026-10-09"
  const code = "31-000"
  const budgetFor = (lots) => ({ headers: BUDGET_HEADERS, rows: lots.map((n) => ({ community: COMMUNITY, lot_number: n, cost_code: code, budget_cents: "100" })) })
  const lotRow = (n) => kit.rows(`select id, project_id, status from public.lots where org_id=${kit.q(org.orgId)} and lot_number=${kit.q(n)}`)[0]
  const state = (batchId) => kit.rows(`select status, committed_count, committed_at is not null stamped, report->>'commit_error' error from public.import_batches where id=${kit.q(batchId)}`)[0]
  const committedRows = (batchId) => count(kit, `select 1 from public.import_rows where batch_id=${kit.q(batchId)} and status='committed'`)

  // A lot that already has a home that did not come from this cutover.
  const occupied = lotRow("8")
  const squatter = randomUUID()
  kit.sql(`insert into public.projects(id,org_id,name,property_type,created_by) values(${kit.q(squatter)},${kit.q(org.orgId)},'Home started by hand','production',${kit.q(org.owner.userId)});
update public.lots set project_id=${kit.q(squatter)}, status='started' where id=${kit.q(occupied.id)};`)
  await stage(budgetFor(["8", "9"]), { file_kind: "budgets", as_of_date: asOfConflict })
  const conflict = await stage({ headers: HOUSE_HEADERS, rows: [houseRow("8", { budget_total_cents: "100" }), houseRow("9", { budget_total_cents: "100" })] }, { file_kind: "houses", as_of_date: asOfConflict })
  const conflictRefusal = msg(await lot().refusal(() => commit(conflict.id)), /Lot 8 already has a project; reconcile it before importing/)
  const afterConflict = { batch: state(conflict.id), committedRows: committedRows(conflict.id), occupiedLotKeepsItsHome: lotRow("8").project_id === squatter, otherLotUntouched: lotRow("9").project_id === null }

  // A write that fails mid-house (the current stage is not in the plan's schedule): the half-built house is removed.
  await stage(budgetFor(["9"]), { file_kind: "budgets", as_of_date: asOfWrite })
  const broken = await stage({ headers: HOUSE_HEADERS, rows: [houseRow("9", { budget_total_cents: "100", stage_task: "Roofing" })] }, { file_kind: "houses", as_of_date: asOfWrite })
  const writeRefusal = msg(await lot().refusal(() => commit(broken.id)), /Schedule task Roofing was not found in the plan template/)
  const afterWrite = { batch: state(broken.id), committedRows: committedRows(broken.id), lotUnassigned: lotRow("9").project_id === null, leftoverHomes: wipHomes(kit, org.orgId, [broken.id]), leftoverBudgets: count(kit, `select 1 from public.budgets where org_id=${kit.q(org.orgId)} and metadata->>'as_of_date'=${kit.q(asOfWrite)}`) }

  // The corrected file for the same lot and date then commits; the failure left nothing in its way.
  const fixed = await stage({ headers: HOUSE_HEADERS, rows: [houseRow("9", { budget_total_cents: "100" })] }, { file_kind: "houses", as_of_date: asOfWrite })
  const done = await commit(fixed.id)
  const afterRetry = { status: done.status, committed: done.committed_count, lotStarted: lotRow("9").status, lotHasHome: lotRow("9").project_id !== null }

  equal(check, "a lot that already has a home refuses the cutover; the batch is failed, not completed, and nothing is committed", expected.expected.lotConflict, { refusal: conflictRefusal, ...afterConflict })
  equal(check, "a write failing mid-house fails the batch, leaves no half-built home, budget or assigned lot", expected.expected.failedWrite, { refusal: writeRefusal, ...afterWrite })
  equal(check, "after the failure the corrected file commits and completes the cutover", expected.expected.retry, afterRetry)
  return { orgId: org.orgId }
}

// A failed batch should not leave homes that look cut over. Rows before a conflict commit in order.
async function openWipFailedBatchLeavesNoPublishedHomes(kit, expected, check) {
  const { org, stage, commit } = await cutover(kit)
  const asOf = "2026-10-11"
  const lotRow = (n) => kit.rows(`select id, project_id, status from public.lots where org_id=${kit.q(org.orgId)} and lot_number=${kit.q(n)}`)[0]
  // Lot 8 still holds the home started by hand (set up by the failure case); lot 10 is free and comes first.
  const occupied = lotRow("8")
  if (!occupied.project_id) {
    const squatter = randomUUID()
    kit.sql(`insert into public.projects(id,org_id,name,property_type,created_by) values(${kit.q(squatter)},${kit.q(org.orgId)},'Home started by hand','production',${kit.q(org.owner.userId)});
update public.lots set project_id=${kit.q(squatter)}, status='started' where id=${kit.q(occupied.id)};`)
  }
  await stage({ headers: BUDGET_HEADERS, rows: ["8", "10"].map((n) => ({ community: COMMUNITY, lot_number: n, cost_code: "31-000", budget_cents: "100" })) }, { file_kind: "budgets", as_of_date: asOf })
  const batch = await stage({ headers: HOUSE_HEADERS, rows: [houseRow("10", { budget_total_cents: "100" }), houseRow("8", { budget_total_cents: "100" })] }, { file_kind: "houses", as_of_date: asOf })
  const refusal = msg(await lot().refusal(() => commit(batch.id)), /Lot 8 already has a project/)
  const after = kit.rows(`select status, committed_count, committed_at is not null stamped from public.import_batches where id=${kit.q(batch.id)}`)[0]
  const homes = wipHomes(kit, org.orgId, [batch.id])
  equal(check, "a batch that fails on its second house leaves no home published for its first", expected.expected, { refusal, batch: after.status, committedCount: after.committed_count, stamped: after.stamped, homesPublished: homes, lot10HasHome: lotRow("10").project_id !== null })
  return { orgId: org.orgId }
}

const subcases = {
  "open-wip-rejects-bad-files-before-any-home": openWipRejectsBadFilesBeforeAnyHome,
  "open-wip-cutover-retains-the-home": openWipCutoverRetainsTheHome,
  "open-wip-schedule-follows-the-plan-template": openWipScheduleFollowsThePlanTemplate,
  "open-wip-failures-do-not-complete-the-cutover": openWipFailuresDoNotCompleteTheCutover,
  "open-wip-failed-batch-leaves-no-published-homes": openWipFailedBatchLeavesNoPublishedHomes,
  "owner-assigns-the-houses-superintendent": ownerAssignsTheHousesSuperintendent,
  "failed-inspection-becomes-owned-corrective-work-and-reinspects": failedInspectionBecomesOwnedCorrectiveWork,
  "punch-traceability-and-close-readiness": punchTraceabilityAndCloseReadiness,
}
module.exports = { subcases }
