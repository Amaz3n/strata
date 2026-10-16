// VPO-01 — variance approval controls, completion-to-payment reconciliation (EP08-09, EP08-11).
// Every control is proved twice: the legitimate service path works for the person who holds the
// permission, and the same change forged through a member's own data-API session is refused.
//
//   vpo-approval-follows-bands-evidence-and-separation   EP08-09  band permission, requester != approver (audited), cost evidence at the
//                                                        org threshold and always for a back-charge, foreign files refused, the budget baseline stays
//   purchasing-controls-cannot-be-forged-through-the-data-api   EP08-09/11  a member cannot approve, reprice, change settings or verify a completion;
//                                                        the settings writer is the purchasing manager's and is audited
//   completion-money-step-needs-a-second-person-and-an-inspection  EP08-11  reporter and verifier cannot approve; the org inspection policy takes a passed
//                                                        inspection or an audited waiver; a second completion on billed lines is refused
//   pay-on-po-completion-reconciles-to-the-bill          EP08-11  report -> verify -> approve bills the PO; a VPO approved later is billed by its own
//                                                        completion; an off-book bill makes the position and the desk band agree on the exceptions
//   two-approvals-of-one-completion-bill-once            EP08-11  two sessions approving one completion mint one bill
//
// The fixture is a production builder with a purchasing manager (requester), a second (verifier), a third
// (approver) and a project lead who holds only the standard VPO approval. Amounts are cents; dates do not matter.
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const { app } = require("./shared.cjs")

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value
const equal = (check, label, expected, observed) => check.equal(label, canonical(expected), canonical(observed))
const attempt = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }
/** Names what stopped an action, so the expectation reads as a rule rather than as a sentence. */
function why(outcome) {
  if (outcome === "allowed") return "allowed"
  if (/someone other than/i.test(outcome)) return "refused: requester cannot approve"
  if (/back-charge needs cost evidence/i.test(outcome)) return "refused: back-charge needs evidence"
  if (/cost evidence must be available/i.test(outcome)) return "refused: evidence is not the home's"
  if (/cost evidence/i.test(outcome)) return "refused: needs cost evidence"
  if (/someone else has to verify/i.test(outcome)) return "refused: reporter cannot verify"
  if (/someone else has to approve/i.test(outcome)) return "refused: reporter or verifier cannot approve"
  if (/passed inspection/i.test(outcome)) return "refused: needs a passed inspection or waiver"
  if (/already covered/i.test(outcome)) return "refused: scope already covered"
  return "refused: not permitted"
}

/** A write through the member's own session, as PostgREST would run it. */
async function viaDataApi(kit, actor, write) {
  return attempt(() => kit.as(actor, async () => {
    const { supabase } = await require("../../../lib/services/context").requireOrgContext()
    const { data, error } = await write(supabase)
    if (error) throw new Error(/42501|permission denied|row-level security|purchasing|void it instead/i.test(`${error.code} ${error.message}`) ? "refused" : error.message)
    if (Array.isArray(data) && data.length === 0) throw new Error("refused: no row visible to change")
  }))
}
const dataApi = (outcome) => outcome === "allowed" ? "allowed" : "refused"

const ORGS = new WeakMap()
async function payOrg(kit) {
  if (!ORGS.has(kit)) ORGS.set(kit, (async () => {
    const org = await seed.productionBuilder(kit, { name: "VPO-01 purchasing controls" })
    org.buyerA = kit.addMember(org, "org_purchasing_manager", {})
    org.buyerB = kit.addMember(org, "org_purchasing_manager", {})
    org.buyerC = kit.addMember(org, "org_purchasing_manager", {})
    org.lead = kit.addMember(org, "org_project_lead", {})
    kit.sql(`insert into public.purchasing_settings(org_id,pay_on_po_enabled) values(${kit.q(org.orgId)},true) on conflict (org_id) do update set pay_on_po_enabled=true;`)
    return org
  })())
  return ORGS.get(kit)
}

/** A home with a budget and an approved purchase order of two lines (600.00 and 400.00) and a file of its own. */
function home(kit, org, label) {
  const { q } = kit
  const tag = randomUUID().slice(0, 8)
  const projectId = randomUUID(), orderId = randomUUID(), budgetId = randomUUID(), fileId = randomUUID()
  const lineIds = [randomUUID(), randomUUID()]
  const costCodeId = Object.values(org.costCodeIds)[0]
  const vendorId = Object.values(org.vendorIds)[0]
  kit.sql([
    "begin;",
    `insert into public.projects(id,org_id,name,property_type,status) values(${q(projectId)},${q(org.orgId)},${q(`${label} ${tag}`)},'production','active');`,
    `insert into public.budgets(id,org_id,project_id,total_cents) values(${q(budgetId)},${q(org.orgId)},${q(projectId)},5000000);`,
    `insert into public.commitments(id,org_id,project_id,company_id,title,commitment_type,status,total_cents) values(${q(orderId)},${q(org.orgId)},${q(projectId)},${q(vendorId)},${q(`Framing ${tag}`)},'purchase_order','draft',100000);`,
    `insert into public.commitment_lines(id,org_id,commitment_id,description,quantity,unit,unit_cost_cents,scheduled_value_cents,cost_code_id,sort_order) values(${q(lineIds[0])},${q(org.orgId)},${q(orderId)},'Walls',1,'ls',60000,60000,${q(costCodeId)},0),(${q(lineIds[1])},${q(org.orgId)},${q(orderId)},'Roof',1,'ls',40000,40000,${q(costCodeId)},1);`,
    `update public.commitments set status='approved' where id=${q(orderId)};`,
    `insert into public.files(id,org_id,project_id,file_name,storage_path,category) values(${q(fileId)},${q(org.orgId)},${q(projectId)},'quote.pdf',${q(`${org.orgId}/${projectId}/quote-${tag}.pdf`)},'financials');`,
    "commit;",
  ].join("\n"))
  return { projectId, orderId, budgetId, fileId, lineIds, tag }
}

const orders = () => app("commitment-change-orders")
const completions = () => app("po-completions")
const settings = () => app("purchasing-settings")
const reasonId = async (kit, actor, code) => (await kit.as(actor, () => settings().listVarianceReasonCodes())).find((row) => row.code === code).id
const statusOf = (kit, id) => kit.rows(`select status, total_cents::bigint total, approved_by is not null approved from public.commitment_change_orders where id=${kit.q(id)}`).map((row) => ({ status: row.status, total: Number(row.total), approved: row.approved }))[0]
const budgetTotal = (kit, h) => Number(kit.rows(`select total_cents from public.budgets where id=${kit.q(h.budgetId)}`)[0].total_cents)

async function raise(kit, org, h, { actor = org.buyerA, code = "missed_scope", cents, evidence = [] }) {
  return kit.as(actor, async () => orders().createCommitmentChangeOrder({ input: {
    commitment_id: h.orderId, reason_code_id: await reasonId(kit, actor, code), title: `${code} ${cents}`, evidence_file_ids: evidence,
    lines: [{ description: code, quantity: 1, unit_cost_cents: cents }],
  } }))
}
const approveOrder = (kit, actor, id) => attempt(() => kit.as(actor, () => orders().approveCommitmentChangeOrder({ commitmentChangeOrderId: id })))

async function vpoApprovalFollowsBandsEvidenceAndSeparation(kit, expected, check) {
  const org = await payOrg(kit)
  const h = home(kit, org, "Lot 1")
  const foreign = randomUUID(), otherProject = randomUUID()
  kit.sql(`insert into public.projects(id,org_id,name,property_type,status) values(${kit.q(otherProject)},${kit.q(org.orgId)},'VPO-01 other home','production','active');
    insert into public.files(id,org_id,project_id,file_name,storage_path,category) values(${kit.q(foreign)},${kit.q(org.orgId)},${kit.q(otherProject)},'other.pdf',${kit.q(`${org.orgId}/${otherProject}/other.pdf`)},'financials');`)
  const baseline = budgetTotal(kit, h)
  const observed = {}

  const small = await raise(kit, org, h, { cents: 50_000 })
  observed.smallByStandardApprover = why(await approveOrder(kit, org.lead, small.id))

  const large = await raise(kit, org, h, { cents: 150_000, code: "plan_error" })
  observed.largeByStandardApprover = why(await approveOrder(kit, org.lead, large.id))
  observed.largeWithoutEvidence = why(await approveOrder(kit, org.buyerB, large.id))
  observed.requesterApprovesOwn = why(await approveOrder(kit, org.buyerA, large.id))
  observed.foreignEvidence = why(await attempt(() => kit.as(org.buyerA, () => orders().updateCommitmentChangeOrder({ commitmentChangeOrderId: large.id, input: { evidence_file_ids: [foreign] } }))))
  await kit.as(org.buyerA, () => orders().updateCommitmentChangeOrder({ commitmentChangeOrderId: large.id, input: { evidence_file_ids: [h.fileId] } }))
  observed.rejectByStandardApprover = why(await attempt(() => kit.as(org.lead, () => orders().rejectVarianceOrder({ commitmentChangeOrderId: large.id, reason: "Too much" }))))
  observed.largeWithEvidence = why(await approveOrder(kit, org.buyerB, large.id))

  const backcharge = await raise(kit, org, h, { cents: -20_000, code: "back_charge" })
  observed.backchargeByStandardApprover = why(await approveOrder(kit, org.lead, backcharge.id))
  observed.backchargeWithoutEvidence = why(await approveOrder(kit, org.buyerB, backcharge.id))
  await kit.as(org.buyerA, () => orders().updateCommitmentChangeOrder({ commitmentChangeOrderId: backcharge.id, input: { evidence_file_ids: [h.fileId] } }))
  observed.backchargeWithEvidence = why(await approveOrder(kit, org.buyerB, backcharge.id))

  observed.final = { small: statusOf(kit, small.id).status, large: statusOf(kit, large.id).status, backcharge: statusOf(kit, backcharge.id).status }
  observed.requesterRefusalAudited = Number(kit.rows(`select count(*)::int n from public.authorization_audit_log where org_id=${kit.q(org.orgId)} and context->>'rule'='variance_order.requester_cannot_approve' and resource_id=${kit.q(large.id)}`)[0].n)
  observed.budgetBaselineUnchanged = budgetTotal(kit, h) === baseline
  observed.approvalsAudited = Number(kit.rows(`select count(*)::int n from public.audit_log where org_id=${kit.q(org.orgId)} and entity_type='commitment_change_order' and entity_id in (${[small, large, backcharge].map((order) => kit.q(order.id)).join(",")}) and after_data->>'status'='approved'`)[0].n)
  equal(check, "a VPO is approved by the band's permission, never by its requester, with cost evidence from the org threshold up and always for a back-charge; another home's file is refused; the budget baseline stays", expected.expected, observed)
  return { orgId: org.orgId, projectId: h.projectId }
}

async function purchasingControlsCannotBeForgedThroughTheDataApi(kit, expected, check) {
  const org = await payOrg(kit)
  const h = home(kit, org, "Lot 2")
  const draft = await raise(kit, org, h, { cents: 40_000 })
  const done = await raise(kit, org, h, { cents: 30_000 })
  await approveOrder(kit, org.buyerB, done.id)
  const completion = await kit.as(org.buyerA, () => completions().reportPoCompletion({ commitment_id: h.orderId, commitment_line_ids: [h.lineIds[0]], reported_source: "office", photo_file_ids: [] }))
  const forge = {}
  const members = { requester: org.buyerA, salesAgent: org.team.sales }
  for (const [who, actor] of Object.entries(members)) {
    forge[`${who}ApprovesAndReprices`] = dataApi(await viaDataApi(kit, actor, (db) => db.from("commitment_change_orders").update({ status: "approved", approved_by: actor.userId, total_cents: 99_000_000 }).eq("id", draft.id).select("id")))
    forge[`${who}RepricesApproved`] = dataApi(await viaDataApi(kit, actor, (db) => db.from("commitment_change_orders").update({ total_cents: 1 }).eq("id", done.id).select("id")))
    forge[`${who}RewritesLines`] = dataApi(await viaDataApi(kit, actor, (db) => db.from("commitment_change_order_lines").update({ amount_cents: 1 }).eq("commitment_change_order_id", draft.id).select("id")))
    forge[`${who}RaisesApprovedVpo`] = dataApi(await viaDataApi(kit, actor, (db) => db.from("commitment_change_orders").insert({ org_id: org.orgId, project_id: h.projectId, commitment_id: h.orderId, title: "Forged", status: "approved", total_cents: 1, reason_code_id: draft.reason_code_id }).select("id")))
    forge[`${who}ChangesSettings`] = dataApi(await viaDataApi(kit, actor, (db) => db.from("purchasing_settings").update({ po_completion_requires_verification: false }).eq("org_id", org.orgId).select("org_id")))
    forge[`${who}EditsReasons`] = dataApi(await viaDataApi(kit, actor, (db) => db.from("variance_reason_codes").update({ is_active: false }).eq("org_id", org.orgId).select("id")))
    forge[`${who}VerifiesCompletion`] = dataApi(await viaDataApi(kit, actor, (db) => db.from("po_completions").update({ status: "verified", verified_by: actor.userId }).eq("id", completion.id).select("id")))
    forge[`${who}MarksCompletionBilled`] = dataApi(await viaDataApi(kit, actor, (db) => db.from("po_completions").update({ status: "billed", amount_cents: 1 }).eq("id", completion.id).select("id")))
  }
  const state = {
    draft: statusOf(kit, draft.id), done: statusOf(kit, done.id),
    settingsRequireVerification: kit.rows(`select po_completion_requires_verification v from public.purchasing_settings where org_id=${kit.q(org.orgId)}`)[0]?.v ?? "default",
    completion: kit.rows(`select status from public.po_completions where id=${kit.q(completion.id)}`)[0].status,
  }
  const writers = {
    salesAgentSavesSettings: why(await attempt(() => kit.as(org.team.sales, () => settings().updatePurchasingSettings({ pay_on_po_enabled: false })))),
    managerRaisesBandToAnyPermission: why(await attempt(() => kit.as(org.buyerA, () => settings().updatePurchasingSettings({ vpo_approval_thresholds: [{ up_to_cents: null, permission: "commitment.read" }] })))),
    managerSaves: why(await attempt(() => kit.as(org.buyerA, () => settings().updatePurchasingSettings({ vpo_evidence_required_over_cents: 100_000 })))),
    managerSaveAudited: Number(kit.rows(`select count(*)::int n from public.audit_log where org_id=${kit.q(org.orgId)} and entity_type='purchasing_settings'`)[0].n) >= 1,
  }
  const service = {
    approvedByTheRightPerson: why(await approveOrder(kit, org.buyerB, draft.id)),
    verifiedByAnotherPerson: why(await attempt(() => kit.as(org.buyerB, () => completions().verifyPoCompletion(completion.id)))),
  }
  equal(check, "a member's direct writes cannot approve or reprice a VPO, change the settings or reasons, or verify or bill a completion; only the settings permission saves settings (audited); the service paths still work", expected.expected, { forge, state, writers, service })
  return { orgId: org.orgId, projectId: h.projectId }
}

/** report by A, verify by B, approve by C: the people the rule allows. */
async function reportAndVerify(kit, org, h, scope) {
  const completion = await kit.as(org.buyerA, () => completions().reportPoCompletion({ commitment_id: h.orderId, reported_source: "office", photo_file_ids: [], ...scope }))
  await kit.as(org.buyerB, () => completions().verifyPoCompletion(completion.id))
  return completion
}
const approveCompletion = (kit, actor, id, evidence) => attempt(() => kit.as(actor, () => completions().approvePoCompletion(id, undefined, evidence)))
const billsOf = (kit, h) => kit.rows(`select total_cents::bigint total, status from public.vendor_bills where commitment_id=${kit.q(h.orderId)} order by total_cents`).map((row) => [Number(row.total), row.status])

async function completionMoneyStepNeedsASecondPersonAndAnInspection(kit, expected, check) {
  const org = await payOrg(kit)
  const h = home(kit, org, "Lot 3")
  const observed = {}
  const walls = await kit.as(org.buyerA, () => completions().reportPoCompletion({ commitment_id: h.orderId, commitment_line_ids: [h.lineIds[0]], reported_source: "office", photo_file_ids: [] }))
  observed.reporterVerifies = why(await attempt(() => kit.as(org.buyerA, () => completions().verifyPoCompletion(walls.id))))
  await kit.as(org.buyerB, () => completions().verifyPoCompletion(walls.id))
  observed.reporterApproves = why(await approveCompletion(kit, org.buyerA, walls.id))
  observed.verifierApproves = why(await approveCompletion(kit, org.buyerB, walls.id))
  observed.thirdPersonApproves = why(await approveCompletion(kit, org.buyerC, walls.id))
  observed.sameLinesAgain = why(await attempt(() => kit.as(org.buyerA, () => completions().reportPoCompletion({ commitment_id: h.orderId, commitment_line_ids: [h.lineIds[0]], reported_source: "office", photo_file_ids: [] }))))

  await kit.as(org.buyerA, () => settings().updatePurchasingSettings({ po_completion_requires_inspection: true }))
  const roof = await reportAndVerify(kit, org, h, { commitment_line_ids: [h.lineIds[1]] })
  observed.withoutInspection = why(await approveCompletion(kit, org.buyerC, roof.id))
  observed.shortWaiver = why(await approveCompletion(kit, org.buyerC, roof.id, { inspectionWaiverReason: "no" }))
  observed.withWaiver = why(await approveCompletion(kit, org.buyerC, roof.id, { inspectionWaiverReason: "Roof sheathing inspected with the framing" }))
  const row = kit.rows(`select status, inspection_waived_reason r, inspection_waived_by::text by from public.po_completions where id=${kit.q(roof.id)}`)[0]
  observed.waiverRecorded = { status: row.status, reason: row.r, by: row.by === org.buyerC.userId ? "the approver" : row.by }
  observed.waiverAudited = Number(kit.rows(`select count(*)::int n from public.audit_log where org_id=${kit.q(org.orgId)} and entity_type='po_completion' and entity_id=${kit.q(roof.id)} and after_data - 'inspection_waived_reason' - 'inspection_waived_by' = '{}'::jsonb`)[0].n)
  observed.bills = billsOf(kit, h)
  await kit.as(org.buyerA, () => settings().updatePurchasingSettings({ po_completion_requires_inspection: false }))
  equal(check, "the person who reported or verified a completion cannot approve it; with the inspection policy on, approval needs a passed inspection or an audited waiver; billed lines cannot be claimed again", expected.expected, observed)
  return { orgId: org.orgId, projectId: h.projectId }
}

async function payOnPoCompletionReconcilesToTheBill(kit, expected, check) {
  const org = await payOrg(kit)
  const h = home(kit, org, "Lot 4")
  const observed = {}
  const whole = await reportAndVerify(kit, org, h, {})
  observed.wholeOrderApproval = why(await approveCompletion(kit, org.buyerC, whole.id))
  observed.billedAfterPo = billsOf(kit, h)

  const late = await raise(kit, org, h, { cents: 15_000, code: "price_increase" })
  observed.lateVpoApproved = why(await approveOrder(kit, org.lead, late.id))
  const lateOnly = await reportAndVerify(kit, org, h, { commitment_line_ids: [], change_order_ids: [late.id] })
  observed.lateVpoCompletionApproval = why(await approveCompletion(kit, org.buyerC, lateOnly.id))
  observed.lateVpoClaimedAgain = why(await attempt(() => kit.as(org.buyerA, () => completions().reportPoCompletion({ commitment_id: h.orderId, commitment_line_ids: [], change_order_ids: [late.id], reported_source: "office", photo_file_ids: [] }))))
  observed.billedAfterVpo = billsOf(kit, h)

  const positions = () => kit.as(org.team.purchasing, () => app("po-positions").getProjectPoPositions(h.projectId))
  const shape = (row) => ({ original: row.originalCents, approvedVpos: row.approvedVpoCents, billed: row.billedCents, paid: row.paidCents, exceptions: row.exceptions.map((exception) => exception.kind).sort() })
  observed.reconciled = shape((await positions()).rows.find((row) => row.commitmentId === h.orderId))

  kit.sql(`insert into public.vendor_bills(org_id,project_id,commitment_id,company_id,bill_number,status,total_cents,paid_cents) select org_id,project_id,id,company_id,'OFF-BOOK-1','approved',10000,12000 from public.commitments where id=${kit.q(h.orderId)}`)
  const workbench = shape((await positions()).rows.find((row) => row.commitmentId === h.orderId))
  const desk = await kit.as(org.team.purchasing, () => app("po-positions").listPoPositionExceptions({ limit: 200 }))
  const onDesk = desk.rows.filter((row) => row.commitmentId === h.orderId)
  observed.offBookBill = { workbench, deskRows: onDesk.length, deskMatchesWorkbench: onDesk.length === 1 && JSON.stringify(shape(onDesk[0])) === JSON.stringify(workbench) }
  equal(check, "completions bill the PO, a VPO approved after the work was billed is billed by its own completion and cannot be claimed twice, and an off-book bill shows as the same exceptions on the workbench and the desk", expected.expected, observed)
  return { orgId: org.orgId, projectId: h.projectId }
}

async function twoApprovalsOfOneCompletionBillOnce(kit, expected, check) {
  const org = await payOrg(kit)
  const h = home(kit, org, "Lot 5")
  const completion = await reportAndVerify(kit, org, h, { commitment_line_ids: [h.lineIds[0]] })
  const second = kit.addMember(org, "org_purchasing_manager", {})
  const results = await Promise.allSettled([
    kit.as(org.buyerC, () => completions().approvePoCompletion(completion.id)),
    kit.as(second, () => completions().approvePoCompletion(completion.id)),
  ])
  const bills = billsOf(kit, h)
  equal(check, "two sessions approving one completion mint one bill; the other gets the same bill or a refusal, never a second", expected.expected, {
    bills,
    completionBilled: kit.rows(`select status from public.po_completions where id=${kit.q(completion.id)}`)[0].status,
    succeeded: results.filter((result) => result.status === "fulfilled").length >= 1,
  })
  return { orgId: org.orgId, projectId: h.projectId }
}

const subcases = {
  "vpo-approval-follows-bands-evidence-and-separation": vpoApprovalFollowsBandsEvidenceAndSeparation,
  "purchasing-controls-cannot-be-forged-through-the-data-api": purchasingControlsCannotBeForgedThroughTheDataApi,
  "completion-money-step-needs-a-second-person-and-an-inspection": completionMoneyStepNeedsASecondPersonAndAnInspection,
  "pay-on-po-completion-reconciles-to-the-bill": payOnPoCompletionReconcilesToTheBill,
  "two-approvals-of-one-completion-bill-once": twoApprovalsOfOneCompletionBillOnce,
}

module.exports = { id: "VPO-01", subcases }
