// SUPPLY-01 subcases for EP08-08: an issued purchase order is a locked, numbered version the vendor
// answers. Composed into supply-01.cjs by the lead; each subcase is `async (kit, expected, check)`
// and acts through `kit.as` (members, row security real), `kit.service` (the portal) or `race`.
//
//   approved-purchase-order-cannot-be-edited-in-place   a project-member superintendent forging through the data API is refused; the VPO and return-to-draft paths work
//   vendor-receives-and-answers-an-issued-version       approval = revision 1 + one queued email job; accept at the hash; stale hash refused; dispute needs a reason and line facts
//   approved-vpo-requests-reacknowledgment              VPO approval = revision 2 and "revised"; the obligation is PO + VPO; voiding = revision 3
//   acknowledgment-queue-is-scoped-and-capped           a division-limited reader sees their division only with a total; a non-holder is refused; a sales agent cannot write answers
//   race-two-vendor-answers-and-a-revision              (multi_session) an answer racing a VPO approval is serial-equivalent: never accepted against a hash that was not current
//
// The house is the LOT-01 released house; every row a subcase adds is tagged for it.
const { randomUUID } = require("node:crypto")
const { app } = require("./shared.cjs")
const { race } = require("./sessions.cjs")

const lot = () => require("./lot-01.cjs").helpers
const eq = (check, label, expected, observed) => lot().equal(check, label, expected, observed)
const attempt = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }
const OVERRIDE = "Acceptance trade: no prequalification on file for this vendor."

async function viaDataApi(kit, actor, write) {
  return attempt(() => kit.as(actor, async () => {
    const { supabase } = await require("../../../lib/services/context").requireOrgContext()
    const { data, error } = await write(supabase)
    if (error) throw new Error(/42501|locked|permission denied/i.test(`${error.code} ${error.message}`) ? "refused" : error.message)
    if (Array.isArray(data) && data.length === 0) throw new Error("refused: no row visible to change")
  }))
}

async function house(kit) {
  const { org } = await lot().stage(kit, "release")
  const projectId = kit.rows(`select project_id from public.start_packages where id=${kit.q(org.packageId)}`)[0].project_id
  const tag = randomUUID().slice(0, 8)
  const vendorId = randomUUID()
  kit.sql(`insert into public.companies(id,org_id,name) values(${kit.q(vendorId)},${kit.q(org.orgId)},${kit.q(`Supplier ${tag}`)})`)
  const costCode = Object.values(org.costCodeIds)[0]
  const q = kit.q
  const purchaseOrder = async (title, createdBy = org.team.purchasing.userId) => {
    const id = randomUUID()
    const lineId = randomUUID()
    kit.sql(`insert into public.commitments(id,org_id,project_id,title,company_id,commitment_type,status,total_cents,metadata) values(${q(id)},${q(org.orgId)},${q(projectId)},${q(`QA-${tag} ${title}`)},${q(vendorId)},'purchase_order','draft',500000,${q(JSON.stringify({ created_by_user_id: createdBy }))}::jsonb);
      insert into public.commitment_lines(id,org_id,commitment_id,cost_code_id,description,quantity,unit,unit_cost_cents,scheduled_value_cents) values(${q(lineId)},${q(org.orgId)},${q(id)},${q(costCode)},'2x4 studs',100,'ea',5000,500000)`)
    return { id, lineId }
  }
  // The purchasing manager drafts the order (created_by_user_id); a second person, the owner, approves it.
  const approve = (id) => kit.as(org.owner, () => app("commitments").updateCommitment({ commitmentId: id, input: { status: "approved", prequal_override_note: OVERRIDE } }))
  const versions = (id) => kit.rows(`select revision, reason, terms_hash, id::text version_id from public.po_issue_versions where commitment_id=${q(id)} order by revision`)
  const tokenId = randomUUID()
  kit.sql(`insert into public.portal_access_tokens(id,org_id,company_id,portal_type,token_hash,can_view_purchase_orders,can_acknowledge_purchase_orders) values(${q(tokenId)},${q(org.orgId)},${q(vendorId)},'sub',${q(`wd-${tag}`)},true,true)`)
  const link = { id: tokenId, org_id: org.orgId, project_id: null, company_id: vendorId, permissions: { can_view_purchase_orders: true, can_acknowledge_purchase_orders: true } }
  const answer = (id, version, body = {}) => attempt(() => kit.service(() => app("po-acknowledgments").acknowledgePoFromPortal(link, {
    commitmentId: id, issueVersionId: version.version_id, termsHash: version.terms_hash, response: "accepted", ...body,
  }, "Supplier")))
  const vpo = (id, status) => {
    const vpoId = randomUUID()
    kit.sql(`insert into public.commitment_change_orders(id,org_id,project_id,commitment_id,company_id,title,total_cents,status) values(${q(vpoId)},${q(org.orgId)},${q(projectId)},${q(id)},${q(vendorId)},'Extra bundle',20000,${q(status)})`)
    return vpoId
  }
  const queue = (actor, state = "all") => kit.as(actor, () => app("po-acknowledgments").listPoAcknowledgmentQueue({ state }))
  return { org, projectId, tag, vendorId, purchaseOrder, approve, versions, answer, vpo, queue, link }
}

const stateOf = (reply, id) => reply.rows.find((row) => row.commitment_id === id)?.state ?? "absent"

async function approvedPurchaseOrderCannotBeEditedInPlace(kit, expected, check) {
  const h = await house(kit)
  const { org } = h
  const { id, lineId } = await h.purchaseOrder("Locked")
  kit.sql(`insert into public.project_members(org_id,project_id,user_id,role_id,status) select ${kit.q(org.orgId)},${kit.q(h.projectId)},${kit.q(org.team.superintendent.userId)},id,'active' from public.roles where key='pm' on conflict (project_id,user_id) do nothing`)
  const draftEdit = await viaDataApi(kit, org.team.superintendent, (db) => db.from("commitment_lines").update({ quantity: 120 }).eq("id", lineId).select("id"))
  await h.approve(id)
  const forged = {
    quantity: await viaDataApi(kit, org.team.superintendent, (db) => db.from("commitment_lines").update({ quantity: 1000 }).eq("id", lineId).select("id")),
    total: await viaDataApi(kit, org.team.superintendent, (db) => db.from("commitments").update({ total_cents: 1 }).eq("id", id).select("id")),
    scope: await viaDataApi(kit, org.team.superintendent, (db) => db.from("commitments").update({ scope: "changed" }).eq("id", id).select("id")),
    addLine: await viaDataApi(kit, org.team.superintendent, (db) => db.from("commitment_lines").insert({ org_id: org.orgId, commitment_id: id, description: "extra", quantity: 1, unit: "ea", unit_cost_cents: 1 }).select("id")),
    back: await viaDataApi(kit, org.team.superintendent, (db) => db.from("commitments").update({ status: "draft" }).eq("id", id).select("id")),
  }
  const serviceEdit = await attempt(() => kit.as(org.owner, () => app("commitments").updateCommitmentLine(lineId, { quantity: 5 })))
  const serviceHeader = await attempt(() => kit.as(org.owner, () => app("commitments").updateCommitment({ commitmentId: id, input: { total_cents: 1 } })))
  const before = kit.rows(`select total_cents, scope, (select quantity::int from public.commitment_lines where id=${kit.q(lineId)}) quantity from public.commitments where id=${kit.q(id)}`)[0]
  h.vpo(id, "approved")
  const afterVpo = (await h.versions(id)).map((row) => `${row.revision}:${row.reason}`)
  await kit.as(org.owner, () => app("commitments").updateCommitment({ commitmentId: id, input: { status: "draft" } }))
  const returned = kit.rows(`select status, issued_at is null as unissued from public.commitments where id=${kit.q(id)}`)[0]
  eq(check, "a draft PO is editable by a member; once approved the quantity, total, scope, a new line and a return to draft through the data API are all refused and the order is unchanged", expected.expected.locked, {
    draftEdit, forged, serviceLineEdit: /locked/.test(serviceEdit) ? "refused: locked" : serviceEdit,
    serviceHeaderEdit: /locked/.test(serviceHeader) ? "refused: locked" : serviceHeader, unchanged: before,
  })
  eq(check, "a VPO approved against the order is the way to change it (revision 2), and the owner's return to draft un-issues it", expected.expected.paths, { versionsAfterVpo: afterVpo, returned })
  return { orgId: org.orgId, projectId: h.projectId }
}

async function vendorReceivesAndAnswersAnIssuedVersion(kit, expected, check) {
  const h = await house(kit)
  const { id, lineId } = await h.purchaseOrder("Answered")
  const before = kit.rows(`select count(*)::int n from public.po_issue_versions where commitment_id=${kit.q(id)}`)[0].n
  await h.approve(id)
  const [v1] = await h.versions(id)
  const jobs = kit.rows(`select count(*)::int n from public.outbox where job_type='po_issue_notice' and payload->>'commitment_id'=${kit.q(id)}`)[0].n
  const stale = await h.answer(id, { ...v1, terms_hash: "0".repeat(64) })
  const noReason = await h.answer(id, v1, { response: "disputed", lines: [{ commitmentLineId: lineId, kind: "quantity", proposedQuantity: 80 }] })
  const noLines = await h.answer(id, v1, { response: "disputed", reason: "Only 80 in stock" })
  const noPermission = await attempt(() => kit.service(() => app("po-acknowledgments").acknowledgePoFromPortal({ ...h.link, permissions: { can_view_purchase_orders: true } }, { commitmentId: id, issueVersionId: v1.version_id, termsHash: v1.terms_hash, response: "accepted" }, "Supplier")))
  const accepted = await h.answer(id, v1, { lines: [{ commitmentLineId: lineId, kind: "date", promisedDate: "2030-01-15" }] })
  const afterAccept = stateOf(await h.queue(h.org.team.purchasing), id)
  const disputed = await h.answer(id, v1, { response: "disputed", reason: "Only 80 in stock", lines: [{ commitmentLineId: lineId, kind: "quantity", proposedQuantity: 80 }] })
  const afterDispute = stateOf(await h.queue(h.org.team.purchasing), id)
  const open = kit.rows(`select response, count(*)::int n from public.po_acknowledgments where commitment_id=${kit.q(id)} and status='open' group by 1`)
  eq(check, "approving issues revision 1 and queues one vendor email job; a stale hash, a dispute with no reason or no line, and a link without the permission are refused", expected.expected.issue, {
    versionsBefore: before, revisions: (await h.versions(id)).map((row) => `${row.revision}:${row.reason}`), emailJobs: jobs,
    stale: /changed; reload/.test(stale) ? "refused: changed" : stale,
    noReason: /why|reason/i.test(noReason) ? "refused: reason" : noReason,
    noLines: /line/i.test(noLines) ? "refused: lines" : noLines,
    noPermission: /permission/.test(noPermission) ? "refused: permission" : noPermission,
  })
  eq(check, "the vendor accepts at the hash (queue: accepted), then disputes (one open answer, queue: disputed)", expected.expected.answers, { accepted, afterAccept, disputed, afterDispute, open })
  return { orgId: h.org.orgId, projectId: h.projectId }
}

async function approvedVpoRequestsReacknowledgment(kit, expected, check) {
  const h = await house(kit)
  const { id } = await h.purchaseOrder("Revised")
  await h.approve(id)
  const [v1] = await h.versions(id)
  await h.answer(id, v1)
  const accepted = stateOf(await h.queue(h.org.team.purchasing), id)
  const vpoId = h.vpo(id, "sent")
  kit.sql(`update public.commitment_change_orders set status='approved' where id=${kit.q(vpoId)}`)
  const revised = stateOf(await h.queue(h.org.team.purchasing), id)
  const staleAnswer = await h.answer(id, v1)
  const view = await kit.service(() => app("po-acknowledgments").loadPoIssueViews(h.org.orgId, [id]))
  const issue = view.get(id)
  kit.sql(`update public.commitment_change_orders set status='voided' where id=${kit.q(vpoId)}`)
  eq(check, "an accepted order goes to 'revised' when a VPO is approved; the old answer is refused as stale; the vendor is held to PO + VPO; voiding the VPO is revision 3", expected.expected.revision, {
    accepted, revised, staleAnswer: /changed; reload/.test(staleAnswer) ? "refused: changed" : staleAnswer,
    revisedObligationCents: issue.revisedObligationCents, changes: issue.changes,
    revisions: (await h.versions(id)).map((row) => `${row.revision}:${row.reason}`),
  })
  return { orgId: h.org.orgId, projectId: h.projectId }
}

async function acknowledgmentQueueIsScopedAndCapped(kit, expected, check) {
  const h = await house(kit)
  const { org } = h
  const pending = await h.purchaseOrder("Pending")
  const disputed = await h.purchaseOrder("Disputed")
  for (const row of [pending, disputed]) await h.approve(row.id)
  const [dv] = await h.versions(disputed.id)
  await h.answer(disputed.id, dv, { response: "disputed", reason: "Wrong unit", lines: [{ commitmentLineId: disputed.lineId, kind: "scope", note: "Unit is a bundle" }] })
  // The desk's real path: a purchasing manager who is on no house's team approves an order someone else drafted.
  const deskOrder = await h.purchaseOrder("Desk approved", org.owner.userId)
  const approveAs = (actor) => attempt(() => kit.as(actor, () => app("commitments").updateCommitment({ commitmentId: deskOrder.id, input: { status: "approved", prequal_override_note: OVERRIDE } })))
  const full = await h.queue(org.team.purchasing, "action")
  const mine = (reply) => reply.rows.filter((row) => row.title.startsWith(`QA-${h.tag} `)).map((row) => `${row.title.slice(`QA-${h.tag} `.length)}:${row.state}`)
  const limited = kit.addMember(org, "org_purchasing_manager")
  const membership = kit.rows(`select id from public.memberships where org_id=${kit.q(org.orgId)} and user_id=${kit.q(limited.userId)}`)[0].id
  const otherDivision = randomUUID()
  kit.sql(`insert into public.divisions(id,org_id,name) values(${kit.q(otherDivision)},${kit.q(org.orgId)},'Other ${h.tag}');
    update public.memberships set division_scope='assigned' where id=${kit.q(membership)};
    insert into public.membership_divisions(membership_id,division_id) values(${kit.q(membership)},${kit.q(otherDivision)})`)
  const limitedView = await h.queue(limited, "action")
  const deskLimited = await approveAs(limited)
  const deskApproved = await approveAs(org.team.purchasing)
  const deskUnissued = await attempt(() => kit.as(org.team.purchasing, () => app("commitments").updateCommitment({ commitmentId: deskOrder.id, input: { status: "draft" } })))
  const deskState = kit.rows(`select status from public.commitments where id=${kit.q(deskOrder.id)}`)[0].status
  const salesRead = await attempt(() => h.queue(org.team.sales))
  const salesWrite = await viaDataApi(kit, org.team.sales, (db) => db.from("po_acknowledgments").update({ status: "resolved" }).eq("commitment_id", disputed.id).select("id"))
  const resolve = (actor, ackId) => attempt(() => kit.as(actor, () => app("po-acknowledgments").resolvePoAcknowledgment({ acknowledgmentId: ackId, resolution: "upheld", note: "Terms stand" })))
  const ackId = kit.rows(`select id::text from public.po_acknowledgments where commitment_id=${kit.q(disputed.id)} and status='open'`)[0].id
  const outsideDivision = await resolve(limited, ackId)
  const salesResolve = await resolve(org.team.sales, ackId)
  const upheld = await resolve(org.team.purchasing, ackId)
  eq(check, "purchasing sees the pending and disputed orders with a total; a purchasing manager limited to another division sees none of them; a sales agent can neither read nor write answers", expected.expected.scope, {
    purchasing: mine(full).sort(), purchasingTotalCoversBoth: full.total >= 2, limitedSeesMine: mine(limitedView).length,
    salesRead: /price_book\.read|permission/i.test(salesRead) ? "refused" : salesRead, salesWrite,
  })
  eq(check, "a purchasing manager on no house's team approves and returns to draft an order drafted by someone else; one limited to another division is refused", expected.expected.desk, {
    divisionLimited: /not found|permission|division|access/i.test(deskLimited) ? "refused" : deskLimited,
    deskApproved, deskUnissued, deskState,
  })
  eq(check, "resolving a dispute needs po_exception.resolve inside the division; upholding asks the vendor again (pending)", expected.expected.resolve, {
    outsideDivision: /division/.test(outsideDivision) ? "refused: division" : outsideDivision,
    salesResolve: /permission|po_exception/i.test(salesResolve) ? "refused: permission" : salesResolve, upheld,
    afterUpheld: stateOf(await h.queue(org.team.purchasing), disputed.id),
  })
  return { orgId: org.orgId, projectId: h.projectId }
}

async function raceTwoVendorAnswersAndARevision(kit, expected, check) {
  const h = await house(kit)
  const { id } = await h.purchaseOrder("Raced")
  await h.approve(id)
  const [v1] = await h.versions(id)
  const vpoId = h.vpo(id, "sent")
  const answerSql = `begin; select public.record_po_acknowledgment(${kit.q(h.org.orgId)}::uuid, null, ${kit.q(h.vendorId)}::uuid, ${kit.q(id)}::uuid, ${kit.q(v1.version_id)}::uuid, ${kit.q(v1.terms_hash)}, 'accepted', null, '[]'::jsonb); commit;`
  const results = await race(kit, [
    `begin; update public.commitment_change_orders set status='approved', approved_at=now() where id=${kit.q(vpoId)}; commit;`,
    answerSql,
  ], { user: "postgres" })
  const versions = await h.versions(id)
  const current = versions.at(-1)
  const accepted = kit.rows(`select terms_hash=${kit.q(current.terms_hash)} as on_current from public.po_acknowledgments where commitment_id=${kit.q(id)} and status='open'`)
  eq(check, "a vendor answer racing a VPO approval ends serial-equivalent: the VPO always lands as revision 2, and an acceptance exists only if it was recorded before the revision (then it is stale), never against a hash that was not current when recorded", expected.expected.race, {
    revisions: versions.map((row) => row.revision),
    everyAcceptanceWasOnItsVersion: kit.rows(`select bool_and(a.terms_hash = v.terms_hash) ok from public.po_acknowledgments a join public.po_issue_versions v on v.id=a.issue_version_id where a.commitment_id=${kit.q(id)}`)[0].ok ?? true,
    // Either order is legal; what is never legal is an acceptance recorded against a hash that is current after the revision.
    serialEquivalent: (results[1].ok && accepted.length === 1 && accepted[0].on_current === false)
      || (!results[1].ok && /changed; reload/.test(results[1].stderr) && accepted.length === 0)
      || { answer: results[1].ok ? "recorded" : results[1].stderr, acceptanceOnCurrentVersion: accepted.length ? accepted[0].on_current : "none" },
  })
  return { orgId: h.org.orgId, projectId: h.projectId }
}

const subcases = {
  "approved-purchase-order-cannot-be-edited-in-place": approvedPurchaseOrderCannotBeEditedInPlace,
  "vendor-receives-and-answers-an-issued-version": vendorReceivesAndAnswersAnIssuedVersion,
  "approved-vpo-requests-reacknowledgment": approvedVpoRequestsReacknowledgment,
  "acknowledgment-queue-is-scoped-and-capped": acknowledgmentQueueIsScopedAndCapped,
  "race-two-vendor-answers-and-a-revision": raceTwoVendorAnswersAndARevision,
}

module.exports = { subcases }
