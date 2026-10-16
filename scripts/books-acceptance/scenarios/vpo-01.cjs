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
//   division-limited-manager-cannot-decide-another-divisions-vpo   EP08-09  the division fence on approving and voiding; settings are organization-wide
//   credit-after-billing-nets-the-next-payable-and-void-needs-no-live-reliance   EP08-11  a credit approved after the work was billed closes as an open vendor
//                                                        credit and nets the next payable; a void is refused while a completion or a bill relies on the order; voiding the
//                                                        order that resolved a shortage reopens the shortage
//   void-and-completion-approval-on-one-vpo-never-both-win   EP08-11  two database sessions: whichever holds the purchase order's lock wins; the other waits, then is refused or bills without the order
//
// The fixture is a production builder with a purchasing manager (requester), a second (verifier), a third
// (approver) and a project lead who holds only the standard VPO approval. Amounts are cents; dates do not matter.
const { randomUUID } = require("node:crypto")
const { spawn } = require("node:child_process")
const seed = require("../production-seed.cjs")
const { app } = require("./shared.cjs")

const canonical = (value) => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value
const equal = (check, label, expected, observed) => check.equal(label, canonical(expected), canonical(observed))
const attempt = async (work) => { try { await work(); return "allowed" } catch (error) { return error.message } }
/** Names what stopped an action, so the expectation reads as a rule rather than as a sentence. */
function why(outcome) {
  if (outcome === "allowed") return "allowed"
  if (/why this change order is being voided/i.test(outcome)) return "refused: needs a reason"
  if (/Only draft or sent/i.test(outcome)) return "refused: decided order is not edited"
  if (/whole organization/i.test(outcome)) return "refused: settings are organization-wide"
  if (/already claimed/i.test(outcome)) return "refused: nothing left to claim"
  if (/someone other than/i.test(outcome)) return "refused: requester cannot approve"
  if (/back-charge needs cost evidence/i.test(outcome)) return "refused: back-charge needs evidence"
  if (/cost evidence must be available/i.test(outcome)) return "refused: evidence is not the home's"
  if (/cost evidence/i.test(outcome)) return "refused: needs cost evidence"
  if (/someone else has to verify/i.test(outcome)) return "refused: reporter cannot verify"
  if (/someone else has to approve/i.test(outcome)) return "refused: reporter or verifier cannot approve"
  if (/passed inspection/i.test(outcome)) return "refused: needs a passed inspection or waiver"
  if (/already covered/i.test(outcome)) return "refused: scope already covered"
  if (/variance reason is required/i.test(outcome)) return "refused: a purchase-order change needs a reason"
  if (/without a variance reason cannot be approved/i.test(outcome)) return "refused: a reason-less purchase-order change is not approved"
  if (/project and organization of its commitment/i.test(outcome)) return "refused: not on its commitment's home"
  if (/completion already claims/i.test(outcome)) return "refused: a completion claims it"
  if (/another session|deadlock|timeout/i.test(outcome)) return "refused: lost the race"
  if (/A claimed variance order is not approved/i.test(outcome)) return "refused: the order was voided first"
  if (/exceed what it authorizes/i.test(outcome)) return "refused: bills already drawn on it"
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

const uuidArray = (ids) => ids === null ? "null" : `array[${ids.map((value) => `'${value}'::uuid`).join(",")}]::uuid[]`
/**
 * An office report of finished work, written the way the field and office tools write it. `commitment_line_ids` null reports the whole order;
 * an empty list claims variance orders alone. The database's overlap rule refuses scope another completion already covers.
 */
function reportCompletion(kit, org, h, actor, { commitment_line_ids: lines = null, change_order_ids: changeOrders = null } = {}) {
  const id = randomUUID()
  kit.sql(`insert into public.po_completions(id,org_id,project_id,commitment_id,commitment_line_ids,change_order_ids,status,reported_source,reported_by_user_id)
    values(${kit.q(id)},${kit.q(org.orgId)},${kit.q(h.projectId)},${kit.q(h.orderId)},${uuidArray(lines)},${uuidArray(changeOrders)},'reported','office',${kit.q(actor.userId)});`)
  return { id }
}

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

  const voidable = await raise(kit, org, h, { cents: 150_000, code: "plan_error", evidence: [h.fileId] })
  await approveOrder(kit, org.buyerB, voidable.id)
  observed.voidByStandardApprover = why(await attempt(() => kit.as(org.lead, () => orders().voidCommitmentChangeOrder({ commitmentChangeOrderId: voidable.id, reason: "Entered against the wrong order" }))))
  observed.voidWithoutReason = why(await attempt(() => kit.as(org.buyerB, () => orders().voidCommitmentChangeOrder({ commitmentChangeOrderId: voidable.id, reason: "" }))))
  observed.editDecidedOrder = why(await attempt(() => kit.as(org.buyerA, () => orders().updateCommitmentChangeOrder({ commitmentChangeOrderId: voidable.id, input: { lines: [{ description: "Bigger", quantity: 1, unit_cost_cents: 9_000_000 }] } }))))
  observed.voidByLargeApprover = why(await attempt(() => kit.as(org.buyerB, () => orders().voidCommitmentChangeOrder({ commitmentChangeOrderId: voidable.id, reason: "Entered against the wrong order" }))))
  observed.voidAudited = Number(kit.rows(`select count(*)::int n from public.audit_log where org_id=${kit.q(org.orgId)} and entity_type='commitment_change_order' and entity_id=${kit.q(voidable.id)} and after_data->>'status'='voided'`)[0].n)
  observed.voidedOrder = statusOf(kit, voidable.id)

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
  const completion = reportCompletion(kit, org, h, org.buyerA, { commitment_line_ids: [h.lineIds[0]] })
  const forge = {}
  const reasonless = randomUUID()
  const elsewhere = randomUUID()
  kit.sql(`insert into public.projects(id,org_id,name,property_type,status) values(${kit.q(elsewhere)},${kit.q(org.orgId)},'VPO-01 another home','production','active')`)
  kit.sql(`insert into public.commitment_change_orders(id,org_id,project_id,commitment_id,title,status,total_cents) values(${kit.q(reasonless)},${kit.q(org.orgId)},${kit.q(h.projectId)},${kit.q(h.orderId)},'Plain change','draft',20000)`)
  const members = { requester: org.buyerA, salesAgent: org.team.sales }
  for (const [who, actor] of Object.entries(members)) {
    forge[`${who}ApprovesAndReprices`] = dataApi(await viaDataApi(kit, actor, (db) => db.from("commitment_change_orders").update({ status: "approved", approved_by: actor.userId, total_cents: 99_000_000 }).eq("id", draft.id).select("id")))
    forge[`${who}RepricesApproved`] = dataApi(await viaDataApi(kit, actor, (db) => db.from("commitment_change_orders").update({ total_cents: 1 }).eq("id", done.id).select("id")))
    forge[`${who}RewritesLines`] = dataApi(await viaDataApi(kit, actor, (db) => db.from("commitment_change_order_lines").update({ amount_cents: 1 }).eq("commitment_change_order_id", draft.id).select("id")))
    forge[`${who}RaisesApprovedVpo`] = dataApi(await viaDataApi(kit, actor, (db) => db.from("commitment_change_orders").insert({ org_id: org.orgId, project_id: h.projectId, commitment_id: h.orderId, title: "Forged", status: "approved", total_cents: 1, reason_code_id: draft.reason_code_id }).select("id")))
    forge[`${who}InsertsReasonlessApproved`] = dataApi(await viaDataApi(kit, actor, (db) => db.from("commitment_change_orders").insert({ org_id: org.orgId, project_id: h.projectId, commitment_id: h.orderId, title: "Forged", status: "approved", total_cents: 5_000_000, approved_by: actor.userId, approved_at: new Date().toISOString() }).select("id")))
    forge[`${who}ApprovesReasonlessDraft`] = dataApi(await viaDataApi(kit, actor, (db) => db.from("commitment_change_orders").update({ status: "approved", approved_by: actor.userId, approved_at: new Date().toISOString() }).eq("id", reasonless).select("id")))
    forge[`${who}RepricesReasonlessDraft`] = dataApi(await viaDataApi(kit, actor, (db) => db.from("commitment_change_orders").update({ total_cents: 1 }).eq("id", reasonless).select("id")))
    forge[`${who}InsertsReasonlessDraft`] = dataApi(await viaDataApi(kit, actor, (db) => db.from("commitment_change_orders").insert({ org_id: org.orgId, project_id: h.projectId, commitment_id: h.orderId, title: "Forged", status: "draft", total_cents: 99_900_000 }).select("id")))
    forge[`${who}InsertsOnAnotherHome`] = dataApi(await viaDataApi(kit, actor, (db) => db.from("commitment_change_orders").insert({ org_id: org.orgId, project_id: elsewhere, commitment_id: h.orderId, title: "Forged", status: "draft", total_cents: 100 }).select("id")))
    forge[`${who}ChangesSettings`] = dataApi(await viaDataApi(kit, actor, (db) => db.from("purchasing_settings").update({ po_completion_requires_verification: false }).eq("org_id", org.orgId).select("org_id")))
    forge[`${who}EditsReasons`] = dataApi(await viaDataApi(kit, actor, (db) => db.from("variance_reason_codes").update({ is_active: false }).eq("org_id", org.orgId).select("id")))
    forge[`${who}VerifiesCompletion`] = dataApi(await viaDataApi(kit, actor, (db) => db.from("po_completions").update({ status: "verified", verified_by: actor.userId }).eq("id", completion.id).select("id")))
    forge[`${who}MarksCompletionBilled`] = dataApi(await viaDataApi(kit, actor, (db) => db.from("po_completions").update({ status: "billed", amount_cents: 1 }).eq("id", completion.id).select("id")))
  }
  const state = {
    draft: statusOf(kit, draft.id), done: statusOf(kit, done.id),
    settingsRequireVerification: kit.rows(`select po_completion_requires_verification v from public.purchasing_settings where org_id=${kit.q(org.orgId)}`)[0]?.v ?? "default",
    completion: kit.rows(`select status from public.po_completions where id=${kit.q(completion.id)}`)[0].status,
    reasonlessDraft: statusOf(kit, reasonless),
    forgedRows: Number(kit.rows(`select count(*)::int n from public.commitment_change_orders where commitment_id=${kit.q(h.orderId)} and title='Forged'`)[0].n),
  }
  const writers = {
    salesAgentSavesSettings: why(await attempt(() => kit.as(org.team.sales, () => settings().updatePurchasingSettings({ pay_on_po_enabled: false })))),
    managerRaisesBandToAnyPermission: why(await attempt(() => kit.as(org.buyerA, () => settings().updatePurchasingSettings({ vpo_approval_thresholds: [{ up_to_cents: null, permission: "commitment.read" }] })))),
    managerSaves: why(await attempt(() => kit.as(org.buyerA, () => settings().updatePurchasingSettings({ vpo_evidence_required_over_cents: 100_000 })))),
    managerSaveAudited: Number(kit.rows(`select count(*)::int n from public.audit_log where org_id=${kit.q(org.orgId)} and entity_type='purchasing_settings'`)[0].n) >= 1,
  }
  const service = {
    reasonlessRaise: why(await attempt(() => kit.as(org.buyerA, () => orders().createCommitmentChangeOrder({ input: { commitment_id: h.orderId, title: "Plain change", lines: [{ description: "Plain", quantity: 1, unit_cost_cents: 20_000 }] } })))),
    reasonlessApproval: why(await approveOrder(kit, org.buyerB, reasonless)),
    misfiledByAnyWriter: why(await attempt(async () => kit.sql(`insert into public.commitment_change_orders(org_id,project_id,commitment_id,title,total_cents,reason_code_id) values(${kit.q(org.orgId)},${kit.q(elsewhere)},${kit.q(h.orderId)},'Misfiled',100,${kit.q(draft.reason_code_id)})`))),
    approvedByTheRightPerson: why(await approveOrder(kit, org.buyerB, draft.id)),
    verifiedByAnotherPerson: why(await attempt(() => kit.as(org.buyerB, () => completions().verifyPoCompletion(completion.id)))),
  }
  equal(check, "a member's direct writes cannot approve or reprice a VPO, change the settings or reasons, or verify or bill a completion; only the settings permission saves settings (audited); the service paths still work", expected.expected, { forge, state, writers, service })
  return { orgId: org.orgId, projectId: h.projectId }
}

/** report by A, verify by B, approve by C: the people the rule allows. */
async function reportAndVerify(kit, org, h, scope) {
  const completion = reportCompletion(kit, org, h, org.buyerA, scope)
  await kit.as(org.buyerB, () => completions().verifyPoCompletion(completion.id))
  return completion
}
const approveCompletion = (kit, actor, id, evidence) => attempt(() => kit.as(actor, () => completions().approvePoCompletion(id, undefined, evidence)))
const billsOf = (kit, h) => kit.rows(`select total_cents::bigint total, status from public.vendor_bills where commitment_id=${kit.q(h.orderId)} order by total_cents`).map((row) => [Number(row.total), row.status])

async function completionMoneyStepNeedsASecondPersonAndAnInspection(kit, expected, check) {
  const org = await payOrg(kit)
  const h = home(kit, org, "Lot 3")
  const observed = {}
  const walls = reportCompletion(kit, org, h, org.buyerA, { commitment_line_ids: [h.lineIds[0]] })
  observed.reporterVerifies = why(await attempt(() => kit.as(org.buyerA, () => completions().verifyPoCompletion(walls.id))))
  await kit.as(org.buyerB, () => completions().verifyPoCompletion(walls.id))
  observed.reporterApproves = why(await approveCompletion(kit, org.buyerA, walls.id))
  observed.verifierApproves = why(await approveCompletion(kit, org.buyerB, walls.id))
  observed.thirdPersonApproves = why(await approveCompletion(kit, org.buyerC, walls.id))
  observed.sameLinesAgain = why(await attempt(async () => reportCompletion(kit, org, h, org.buyerA, { commitment_line_ids: [h.lineIds[0]] })))

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

  // A variance order approved after the work was billed: the office claims it from the purchase order sheet's own action.
  const late = await raise(kit, org, h, { cents: 15_000, code: "price_increase" })
  observed.lateVpoApproved = why(await approveOrder(kit, org.lead, late.id))
  const officeClaim = await kit.as(org.buyerA, () => completions().reportUnclaimedVariancePoCompletion(h.orderId))
  await kit.as(org.buyerB, () => completions().verifyPoCompletion(officeClaim.id))
  observed.lateVpoCompletionApproval = why(await approveCompletion(kit, org.buyerC, officeClaim.id))
  observed.nothingLeftToClaim = why(await attempt(() => kit.as(org.buyerA, () => completions().reportUnclaimedVariancePoCompletion(h.orderId))))
  observed.lateVpoClaimedAgain = why(await attempt(async () => reportCompletion(kit, org, h, org.buyerA, { commitment_line_ids: [], change_order_ids: [late.id] })))

  // A second one is claimed by the trade from its portal, which lists it as outstanding scope.
  const trade = Object.values(org.vendorIds)[0]
  const contact = randomUUID()
  kit.sql(`insert into public.contacts(id,org_id,full_name,email) values(${kit.q(contact)},${kit.q(org.orgId)},'Foreman','foreman-${h.tag}@acceptance.example.test');
    insert into public.contact_company_links(org_id,contact_id,company_id,is_primary) values(${kit.q(org.orgId)},${kit.q(contact)},${kit.q(trade)},true);`)
  const access = await kit.as(org.owner, () => app("portal-access").createPortalAccessToken({ projectId: h.projectId, portalType: "sub", companyId: trade, orgId: org.orgId, permissions: { can_view_purchase_orders: true, can_report_po_completion: true } }))
  const second = await raise(kit, org, h, { cents: 20_000, code: "price_increase" })
  await approveOrder(kit, org.lead, second.id)
  const portalView = async () => {
    const view = await kit.service(() => app("portal-purchase-orders").listPortalPurchaseOrders(access))
    const order = view.orders.find((row) => row.id === h.orderId)
    return { outstandingChanges: order.changes.filter((change) => !change.claimed).map((change) => change.totalCents), canReport: order.hasReportableScope }
  }
  observed.portalBefore = await portalView()
  const portalClaim = await kit.service(() => completions().reportPoCompletionFromPortal(access.token, { commitment_id: h.orderId, commitment_line_ids: [], change_order_ids: [second.id], photo_file_ids: [h.fileId], notes: null }))
  observed.portalAfter = await portalView()
  await kit.as(org.buyerB, () => completions().verifyPoCompletion(portalClaim.id))
  observed.portalClaimApproval = why(await approveCompletion(kit, org.buyerC, portalClaim.id))
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

async function divisionLimitedManagerCannotDecideAnotherDivisionsVpo(kit, expected, check) {
  const org = await payOrg(kit)
  const h = home(kit, org, "Lot 6")
  const divisions = { a: randomUUID(), b: randomUUID() }
  kit.sql(`insert into public.divisions(id,org_id,name) values(${kit.q(divisions.a)},${kit.q(org.orgId)},'VPO-01 A ${h.tag}'),(${kit.q(divisions.b)},${kit.q(org.orgId)},'VPO-01 B ${h.tag}');
    update public.projects set division_id=${kit.q(divisions.a)} where id=${kit.q(h.projectId)};`)
  const limited = (division) => {
    const member = kit.addMember(org, "org_purchasing_manager", {})
    const membership = kit.rows(`select id from public.memberships where org_id=${kit.q(org.orgId)} and user_id=${kit.q(member.userId)}`)[0].id
    kit.sql(`update public.memberships set division_scope='assigned' where id=${kit.q(membership)}; insert into public.membership_divisions(membership_id,division_id) values(${kit.q(membership)},${kit.q(division)});`)
    return member
  }
  const otherDivision = limited(divisions.b), ownDivision = limited(divisions.a)
  const order = await raise(kit, org, h, { cents: 40_000 })
  const observed = {
    otherDivisionApproves: why(await attempt(() => kit.as(otherDivision, () => orders().approveCommitmentChangeOrder({ commitmentChangeOrderId: order.id })))),
    otherDivisionVoids: why(await attempt(() => kit.as(otherDivision, () => orders().voidCommitmentChangeOrder({ commitmentChangeOrderId: order.id, reason: "Not mine to void" })))),
    denyReasons: kit.rows(`select distinct reason_code from public.authorization_audit_log where org_id=${kit.q(org.orgId)} and actor_user_id=${kit.q(otherDivision.userId)} and decision='deny' and resource_id=${kit.q(order.id)}`).map((row) => row.reason_code),
    afterRefusals: statusOf(kit, order.id).status,
    ownDivisionApproves: why(await attempt(() => kit.as(ownDivision, () => orders().approveCommitmentChangeOrder({ commitmentChangeOrderId: order.id })))),
    divisionLimitedSavesSettings: why(await attempt(() => kit.as(ownDivision, () => settings().updatePurchasingSettings({ expiring_agreement_lead_days: 20 })))),
  }
  equal(check, "a purchasing manager limited to another division can neither approve nor void a home's variance order, one limited to its own division can, and settings that apply to the whole organization are not theirs to change", expected.expected, observed)
  return { orgId: org.orgId, projectId: h.projectId }
}

async function creditAfterBillingNetsTheNextPayableAndVoidNeedsNoLiveReliance(kit, expected, check) {
  const org = await payOrg(kit)
  const h = home(kit, org, "Lot 7")
  const observed = {}
  const positions = async () => {
    const row = (await kit.as(org.team.purchasing, () => app("po-positions").getProjectPoPositions(h.projectId))).rows.find((candidate) => candidate.commitmentId === h.orderId)
    return { original: row.originalCents, approvedVpos: row.approvedVpoCents, billed: row.billedCents, openCredit: row.openVendorCreditCents, exceptions: row.exceptions.map((exception) => exception.kind).sort() }
  }

  const walls = await reportAndVerify(kit, org, h, { commitment_line_ids: [h.lineIds[0]] })
  observed.wallsApproval = why(await approveCompletion(kit, org.buyerC, walls.id))
  observed.billedAfterWalls = billsOf(kit, h)

  // A credit approved after the walls were billed. It blocks no payment, and claiming it no longer errors.
  const credit = await raise(kit, org, h, { cents: -5_000, code: "price_increase" })
  observed.creditApproved = why(await approveOrder(kit, org.lead, credit.id))
  observed.positionAfterCredit = await positions()
  const claim = await kit.as(org.buyerA, () => completions().reportUnclaimedVariancePoCompletion(h.orderId))
  await kit.as(org.buyerB, () => completions().verifyPoCompletion(claim.id))
  observed.creditClaimApproval = why(await approveCompletion(kit, org.buyerC, claim.id))
  const closed = kit.rows(`select status, vendor_bill_id is null as no_bill, metadata->>'vendor_credit_cents' as credit from public.po_completions where id=${kit.q(claim.id)}`)[0]
  observed.creditCompletion = { status: closed.status, noBill: closed.no_bill, creditCents: Number(closed.credit) }
  observed.billsAfterCredit = billsOf(kit, h)
  observed.positionWithOpenCredit = await positions()
  observed.voidClaimedCredit = why(await attempt(() => kit.as(org.buyerB, () => orders().voidCommitmentChangeOrder({ commitmentChangeOrderId: credit.id, reason: "Entered against the wrong order" }))))

  // The next payable is netted against the credit: 400.00 of roof less the 50.00 credit.
  const roof = await reportAndVerify(kit, org, h, { commitment_line_ids: [h.lineIds[1]] })
  observed.roofApproval = why(await approveCompletion(kit, org.buyerC, roof.id))
  observed.billsAfterRoof = billsOf(kit, h)
  observed.positionAfterRoof = await positions()

  // A void is refused while the bills drawn on the order exceed what it authorizes without that variance order.
  const plus = await raise(kit, org, h, { cents: 20_000, code: "price_increase" })
  observed.plusApproved = why(await approveOrder(kit, org.lead, plus.id))
  kit.sql(`insert into public.vendor_bills(org_id,project_id,commitment_id,company_id,bill_number,status,total_cents) select org_id,project_id,id,company_id,'OFF-BOOK-2','approved',20000 from public.commitments where id=${kit.q(h.orderId)}`)
  observed.voidBilledPast = why(await attempt(() => kit.as(org.buyerB, () => orders().voidCommitmentChangeOrder({ commitmentChangeOrderId: plus.id, reason: "Entered against the wrong order" }))))
  observed.plusStillApproved = statusOf(kit, plus.id).status

  // Voiding the order that resolved a shortage reopens the shortage.
  const replacement = await raise(kit, org, h, { cents: 10_000, code: "damage_theft" })
  const shortage = randomUUID()
  kit.sql(`insert into public.po_shortages(id,org_id,project_id,commitment_id,commitment_line_id,short_quantity,reason) values(${kit.q(shortage)},${kit.q(org.orgId)},${kit.q(h.projectId)},${kit.q(h.orderId)},${kit.q(h.lineIds[1])},1,'vendor_short');
    update public.po_shortages set status='vpo', vpo_id=${kit.q(replacement.id)}, resolved_by=${kit.q(org.buyerA.userId)}, resolved_at=now() where id=${kit.q(shortage)};`)
  const resolved = kit.rows(`select status from public.po_shortages where id=${kit.q(shortage)}`)[0].status
  observed.voidReplacement = why(await attempt(() => kit.as(org.buyerB, () => orders().voidCommitmentChangeOrder({ commitmentChangeOrderId: replacement.id, reason: "Replacement no longer needed" }))))
  const reopened = kit.rows(`select status, vpo_id is null as no_vpo, resolved_at is null as open from public.po_shortages where id=${kit.q(shortage)}`)[0]
  observed.shortage = { resolvedBy: resolved, afterVoid: { status: reopened.status, vpoCleared: reopened.no_vpo, open: reopened.open } }
  equal(check, "a credit approved after billing closes as an open vendor credit and nets the next payable; a void is refused while a completion claims the order or the bills exceed what remains authorized; voiding the order that resolved a shortage reopens it", expected.expected, observed)
  return { orgId: org.orgId, projectId: h.projectId }
}

/** A second database session that runs `statement` inside a transaction and keeps it open for `seconds`, holding every lock the statement took. */
function holdOpen(kit, statement, seconds) {
  const session = spawn("docker", ["exec", "-i", kit.container, "psql", "-X", "-A", "-t", "-q", "-v", "ON_ERROR_STOP=1", "-U", "postgres", "-d", "postgres"], { stdio: ["pipe", "pipe", "pipe"] })
  let output = ""
  session.stdout.on("data", (chunk) => { output += chunk })
  session.stderr.on("data", (chunk) => { output += chunk })
  const finished = new Promise((resolve) => session.on("close", (code) => resolve({ code, output: output.trim() })))
  session.stdin.end(`begin;\n${statement};\nselect pg_sleep(${seconds});\ncommit;`)
  return finished
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function voidAndCompletionApprovalOnOneVpoNeverBothWin(kit, expected, check) {
  const org = await payOrg(kit)
  const observed = {}
  const vpoBilled = (h, vpo) => Number(kit.rows(`select count(*)::int n from public.bill_lines bl join public.commitment_change_order_lines l on l.id::text = bl.metadata->>'commitment_change_order_line_id' where l.commitment_change_order_id=${kit.q(vpo.id)}`)[0].n) > 0
  const setup = async (label) => {
    const h = home(kit, org, label)
    // A whole-order completion bills the variance orders nobody has billed yet, so it names none of them: only the lock tells the two actions apart.
    const completion = await reportAndVerify(kit, org, h, {})
    const vpo = await raise(kit, org, h, { cents: 15_000, code: "price_increase" })
    await approveOrder(kit, org.lead, vpo.id)
    return { h, completion, vpo }
  }

  // The approval is in flight (its transaction holds the purchase order's lock) when the void arrives: the approval bills the order, the void is refused.
  const first = await setup("Lot 8")
  const approving = holdOpen(kit, `select public.approve_po_completion(${kit.q(org.orgId)},${kit.q(first.completion.id)},${kit.q(org.buyerC.userId)})`, 5)
  await pause(1500)
  observed.voidWhileApprovalInFlight = why(await attempt(() => kit.as(org.buyerB, () => orders().voidCommitmentChangeOrder({ commitmentChangeOrderId: first.vpo.id, reason: "Entered against the wrong order" }))))
  observed.approvalInFlight = (await approving).code === 0 ? "committed" : "failed"
  observed.approvalWins = { order: statusOf(kit, first.vpo.id).status, billedWithOrder: billsOf(kit, first.h), orderBilled: vpoBilled(first.h, first.vpo), completion: kit.rows(`select status from public.po_completions where id=${kit.q(first.completion.id)}`)[0].status }

  // The void is in flight when the approval arrives: the approval waits for it, finds the order voided and bills the purchase order alone.
  const second = await setup("Lot 9")
  const voiding = holdOpen(kit, `select public.void_commitment_change_order(${kit.q(org.orgId)},${kit.q(second.vpo.id)},${kit.q(org.buyerB.userId)},'Entered against the wrong order','approved')`, 5)
  await pause(1500)
  observed.approvalWhileVoidInFlight = why(await approveCompletion(kit, org.buyerC, second.completion.id))
  observed.voidInFlight = (await voiding).code === 0 ? "committed" : "failed"
  observed.voidWins = { order: statusOf(kit, second.vpo.id).status, bills: billsOf(kit, second.h), orderBilled: vpoBilled(second.h, second.vpo), completion: kit.rows(`select status from public.po_completions where id=${kit.q(second.completion.id)}`)[0].status }
  equal(check, "a void and a completion approval racing on one variance order: the one holding the purchase order's lock wins, the other waits and then gets a plain answer, and the order is billed or voided, never both", expected.expected, observed)
  return { orgId: org.orgId, projectId: second.h.projectId }
}

const subcases = {
  "vpo-approval-follows-bands-evidence-and-separation": vpoApprovalFollowsBandsEvidenceAndSeparation,
  "purchasing-controls-cannot-be-forged-through-the-data-api": purchasingControlsCannotBeForgedThroughTheDataApi,
  "completion-money-step-needs-a-second-person-and-an-inspection": completionMoneyStepNeedsASecondPersonAndAnInspection,
  "pay-on-po-completion-reconciles-to-the-bill": payOnPoCompletionReconcilesToTheBill,
  "two-approvals-of-one-completion-bill-once": twoApprovalsOfOneCompletionBillOnce,
  "division-limited-manager-cannot-decide-another-divisions-vpo": divisionLimitedManagerCannotDecideAnotherDivisionsVpo,
  "credit-after-billing-nets-the-next-payable-and-void-needs-no-live-reliance": creditAfterBillingNetsTheNextPayableAndVoidNeedsNoLiveReliance,
  "void-and-completion-approval-on-one-vpo-never-both-win": voidAndCompletionApprovalOnOneVpoNeverBothWin,
}

module.exports = { id: "VPO-01", subcases }
