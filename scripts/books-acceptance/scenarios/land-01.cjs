// LAND-01 — land and inventory (EP04). One production builder (Cypress Landing in the Gulf
// Coast division: twenty lots, the first ten bought in Books under the seed's executed land
// contract and developed; The Mangrove offered; a second division, Treasure Coast, with its
// own community and its own land manager), made through Arc's own services by the role that
// owns each step. Every subcase acts through `kit.as`, so row-level security and permission
// checks are the real ones:
//
//   land-deal-diligence-and-reviewed-versions        EP04-01  a deal's diligence, versioned reviews, named approvers and the division wall
//   entitlements-hold-starts                         EP04-02  an overdue phase condition blocks the community and that phase's starts only
//   land-contract-deposits-extensions-and-cash       EP04-03  signed terms hold; deposits need receipts; extensions are amendments; the cash plan nets deposits
//   development-reconciles-to-phases-and-lots        EP04-04  development cost reaches only its phases' lots and the job reconciles
//   undelivered-lot-needs-authorized-exception       EP04-04  a house starts on undelivered land only under a lot.delivery_override exception
//   lot-state-requires-home                          EP04-05  started and closed need a home, developed refuses one, reversals need force
//   no-double-selling-sequential                     EP04-06  lapsed holds, single refunds, one buyer per lot (the races live in RACE-02)
//   spec-aging-from-recorded-completion              EP04-07  a spec ages only from a recorded, past completion date
//   spec-price-approval-and-disposition              EP04-08  large price moves need a second person; a below-cost sale-off waits on its write-down
//
// Lots are given out once: 2-4 to subcase 7, 5 to subcase 8, 7 to subcase 9, 9 and 10 to
// subcase 4's allocation; subcases 2, 5 and 6 add their own lots (31-32, 41-43, 51-53).
//
// SQL is used only for what a subcase is not about and says so where it happens: evidence
// file records (the stack has no file storage), a hold's expiry passing, a legacy lot row
// written before the lot guard existed, and the direct writes the database guards must
// refuse. Reads that check the outcome are SQL as the stack superuser.
const { randomUUID } = require("node:crypto")
const seed = require("../production-seed.cjs")
const { app, project } = require("./shared.cjs")

const context = () => require("../../../lib/services/context")
// What a person is told when they are refused, or "allowed". A rejected input reads as its messages.
const attempt = async (work) => {
  try { await work(); return "allowed" } catch (error) { return error.issues ? `invalid: ${error.issues.map((issue) => issue.message).join("; ")}` : error.message }
}
// What the database says when it refuses a direct write, or "allowed".
const sqlAttempt = (kit, statement, user = "postgres") => {
  try { kit.sql(statement, user); return "allowed" } catch (error) { const line = /ERROR:\s+([^\n]+)/.exec(error.message); return line ? line[1].trim() : error.message }
}
const one = (kit, sql) => kit.rows(sql)[0]
const count = (kit, sql) => Number(kit.rows(`select count(*)::int n from (${sql}) t`)[0].n)

// ---------------------------------------------------------------------------
// The builder, built once per run and shared by the subcases.

const WORLDS = new WeakMap()
function world(kit) {
  if (!WORLDS.has(kit)) WORLDS.set(kit, build(kit))
  return WORLDS.get(kit)
}

/** A new member of `org` under `role`, limited to `divisionIds` by the owner through the team service (as SEC-01). */
async function limitedMember(kit, org, role, divisionIds) {
  const actor = kit.addMember(org, role)
  const membershipId = one(kit, `select id from public.memberships where org_id=${kit.q(org.orgId)} and user_id=${kit.q(actor.userId)}`).id
  await kit.as(org.owner, () => app("team").updateMemberRole({ membershipId, role, divisionScope: "assigned", divisionIds }))
  return Object.assign(actor, { membershipId })
}

async function build(kit) {
  const org = await seed.productionBuilder(kit, { name: "LAND-01 land and inventory" })
  await seed.seedCommunity(kit, org)
  await seed.seedProduct(kit, org)
  await seed.takeDownTranche(kit, org)
  // Subcase 9 releases a spec home this week; the starts desk raises the week's even-flow
  // target so it does not wait on the release-slot confirmation (not under test).
  const monday = new Date(`${seed.isoDay(0)}T00:00:00Z`)
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7))
  await kit.as(org.team.starts, () => app("even-flow").setReleaseSlot(org.communityId, monday.toISOString().slice(0, 10), { targetStarts: 10 }))
  // A second approver for land and spec prices, and the office that enters payables.
  org.team.admin = kit.addMember(org, "org_admin")
  org.bookkeeper = kit.addMember(org, "org_office_admin")
  // Treasure Coast: another division with its own community and a land manager limited to it.
  const divisionId = (await kit.as(org.owner, () => app("divisions").createDivision({ name: "Treasure Coast", code: "TC", region: "Southeast Florida" }))).id
  const communityId = (await kit.as(org.owner, () => app("communities").createCommunity({ name: "Seagrape Hammock", code: "SGH", divisionId, status: "active", city: "Stuart", state: "FL", postalCode: "34994", plannedLotCount: 2, targetAbsorptionPerMonth: 1 }))).id
  org.treasure = { divisionId, communityId, land: await limitedMember(kit, org, "org_land_manager", [divisionId]) }
  return { org }
}

/** Lots the land manager adds to Cypress Landing (each `{ lotNumber, phaseId, status }`), by lot number. */
async function newLots(kit, org, lots) {
  await kit.as(org.team.land, () => app("lots").createLots(org.communityId, { lots: lots.map((lot) => ({ address: `${lot.lotNumber} Cypress Landing Way`, ...lot })) }))
  return Object.fromEntries(lots.map((lot) => [lot.lotNumber, one(kit, `select id from public.lots where org_id=${kit.q(org.orgId)} and community_id=${kit.q(org.communityId)} and lot_number=${kit.q(lot.lotNumber)}`).id]))
}

/** A document the stack cannot store: its file record stands in for the upload (fixture). */
function fileRecord(kit, org, fileName, extra = {}) {
  const id = randomUUID()
  const columns = { id, org_id: org.orgId, file_name: fileName, storage_path: `acceptance/${fileName}`, mime_type: "application/pdf", ...extra }
  kit.sql(`insert into public.files(${Object.keys(columns).join(",")}) values(${Object.values(columns).map(kit.q).join(",")})`)
  return id
}

/** An ordinary home (no buyer) in the Gulf Coast division, made by the owner. */
async function bareHome(kit, org, name) {
  return (await kit.as(org.owner, () => app("projects").createProject({ input: { name, property_type: "production", status: "active", phase: "delivery", division_id: org.divisionId } }))).id
}

/**
 * Owned-inventory accounting for a project, as the seed's release does it (DEFECT D4/D16: a
 * placeholder contract must be given a closing revenue policy first). Not under test.
 */
async function adoptInventory(kit, org, projectId) {
  const policies = app("books/revenue-policies"), inventory = app("books/inventory")
  const adopt = () => kit.as(org.owner, () => inventory.enableProjectInventory({ projectId, effectiveOn: "2026-06-01", evidenceUrl: `${seed.EVIDENCE}/development-ownership` }))
  await adopt().catch(async (error) => {
    if (!/earn revenue differently|recognizes revenue at sale/.test(error.message)) throw error
    const contracts = kit.rows(`select id, contract_type from public.contracts where project_id=${kit.q(projectId)} and status='active'`)
    for (const contract of contracts) {
      const proposal = await kit.as(org.owner, () => policies.proposeRevenuePolicy({ projectId, contractId: contracts.length === 1 ? null : contract.id, method: "closing", billingMethod: contract.contract_type === "purchase_agreement" ? "purchase_agreement" : "fixed_price", effectiveFrom: "2026-06-01", rationale: "Development cost is inventory; nothing here earns revenue before the lots sell." }))
      await kit.as(org.reviewer, () => policies.reviewRevenuePolicy({ policyId: proposal.policyId, approve: true }))
    }
    await adopt()
  })
}

// ---------------------------------------------------------------------------
// 1. EP04-01: a land deal tracks diligence with owners, due dates and evidence; each
//    submitted version is kept, approvers are named, and a takedown waits on approval.

async function landDealDiligenceAndReviewedVersions(kit, expected, check) {
  const { org } = await world(kit)
  const deals = app("land-opportunities"), communities = app("communities")
  const land = org.team.land, q = kit.q
  const deal = await kit.as(land, () => deals.createLandOpportunity({ name: "Cypress Landing North parcel", code: "CLN", divisionId: org.divisionId, city: "Naples", state: "FL", county: "Collier",
    acreage: 12.5, plannedLotCount: 40, purchasePriceCents: 280000000, depositCents: 5000000, diligenceEndsOn: seed.isoDay(30), leadUserId: land.userId }))
  // The parcel extends Cypress Landing.
  await kit.as(land, () => deals.linkLandOpportunityCommunity(deal.id, { communityId: org.communityId }))
  const title = await kit.as(land, () => deals.createDiligenceItem(deal.id, { title: "Title commitment and exceptions", category: "title", ownerUserId: land.userId, dueOn: seed.isoDay(-3) }))
  const survey = await kit.as(land, () => deals.createDiligenceItem(deal.id, { title: "Boundary and topographic survey", category: "survey", ownerCompanyId: org.vendorIds["Cypress Sitework"], dueOn: seed.isoDay(14) }))
  // The surveyor's PDF, filed on the deal and linked to the survey item. The stack has no file
  // storage, so the records attachDiligenceEvidence writes after the upload stand in (fixture).
  const surveyFileId = fileRecord(kit, org, "north-parcel-boundary-survey.pdf", { land_opportunity_id: deal.id, visibility: "private", folder_path: "/Land deals/Cypress Landing North parcel" })
  kit.sql(`insert into public.file_links(org_id,file_id,entity_type,entity_id,land_opportunity_id,link_role,created_by) values(${q(org.orgId)},${q(surveyFileId)},'land_diligence_item',${q(survey.id)},${q(deal.id)},'evidence',${q(land.userId)})`)
  await kit.as(land, () => deals.resolveDiligenceItem(survey.id, { status: "satisfied" }))
  const detail = () => kit.as(land, () => deals.getLandOpportunity(deal.id))
  const opened = await detail()
  const { nextDueOn, ...summary } = opened.summary
  const observed = {
    checklist: opened.items.map((item) => ({ title: item.title, owner: item.ownerUserId === land.userId ? "land manager" : item.ownerCompanyName, status: item.status, evidence: item.evidence.map((file) => file.fileName) })),
    summary,
    linkedCommunity: opened.communityName,
    communityLandOrigin: (await kit.as(land, () => deals.getCommunityLandOrigin(org.communityId))).map((row) => row.name),
  }

  const approvers = [{ userId: org.owner.userId, label: "Owner" }, { userId: org.team.admin.userId, label: "Land committee" }]
  const submit = (list = approvers) => kit.as(land, () => deals.submitAcquisitionReview(deal.id, { decision: "acquire", summary: "Forty lots at $7,000 a lot; survey clean, title exceptions under review.", approvers: list }))
  observed.submitterNamesThemself = await attempt(() => submit([{ userId: land.userId, label: "Land manager" }, approvers[0]]))
  const r1 = (await submit()).reviewId
  observed.stageInReview = (await detail()).stage
  const review = (id) => one(kit, `select revision, status, content_hash, (snapshot->'terms'->>'purchase_price_cents')::bigint price, jsonb_array_length(snapshot->'items') items, jsonb_array_length(snapshot->'evidence') evidence, jsonb_array_length(snapshot->'takedowns') takedowns from public.land_acquisition_reviews where id=${q(id)}`)
  const approval = (reviewId, approverId) => one(kit, `select id from public.land_acquisition_approvals where review_id=${q(reviewId)} and approver_id=${q(approverId)}`).id
  const decide = (actor, reviewId, contentHash) => attempt(() => kit.as(actor, () => deals.decideAcquisitionApproval(approval(reviewId, actor.userId), { decision: "approved", contentHash })))
  const r1Hash = review(r1).content_hash
  // The seller comes down $80,000: the version in review is superseded, never edited.
  await kit.as(land, () => deals.updateLandOpportunity(deal.id, { purchasePriceCents: 272000000 }))
  observed.afterPriceChange = { r1: review(r1).status, stage: (await detail()).stage }
  observed.decideSupersededVersion = await decide(org.owner, r1, r1Hash)
  // The tranche the deal becomes, linked before the second version so it is part of what is approved.
  const takedown = await kit.as(land, () => communities.createLotTakedown(org.communityId, { name: "North parcel tranche 1", scheduledDate: "2027-09-01", lotCount: 0, landOpportunityId: deal.id }))
  const r2 = (await submit()).reviewId
  const r2Row = review(r2)
  observed.versions = [review(r1), r2Row].map((row) => ({ revision: row.revision, status: row.status, purchasePriceCents: Number(row.price), items: row.items, evidence: row.evidence, takedowns: row.takedowns }))
  observed.versionsHashDiffer = r1Hash !== r2Row.content_hash
  observed.approveWithStaleHash = await decide(org.owner, r2, r1Hash)
  const close = () => attempt(() => kit.as(land, () => communities.closeLotTakedown(takedown.id, { actualDate: seed.isoDay(0) })))
  observed.closeBeforeApproval = await close()
  observed.ownerApproves = await decide(org.owner, r2, r2Row.content_hash)
  observed.afterOneApproval = { r2: review(r2).status, stage: (await detail()).stage }
  observed.adminApproves = await decide(org.team.admin, r2, r2Row.content_hash)
  observed.afterBothApprovals = { r2: review(r2).status, stage: (await detail()).stage }
  observed.approvalsBoundToTheVersion = kit.rows(`select step, label, decision, reviewed_hash=${q(r2Row.content_hash)} bound from public.land_acquisition_approvals where review_id=${q(r2)} order by step`)
  observed.closeAfterApproval = await close()
  observed.afterClose = { takedown: one(kit, `select status from public.lot_takedowns where id=${q(takedown.id)}`).status, stage: (await detail()).stage }
  observed.audited = {
    reviewsSubmitted: count(kit, `select 1 from public.audit_log where org_id=${q(org.orgId)} and entity_type='land_acquisition_review' and action='insert'`),
    approvalsDecided: count(kit, `select 1 from public.audit_log where org_id=${q(org.orgId)} and entity_type='land_acquisition_approval' and action='update'`),
    reviewDecidedEvents: count(kit, `select 1 from public.events where org_id=${q(org.orgId)} and event_type='land_acquisition_review.decided'`),
  }

  // Treasure Coast's land manager: not the deal, not its checklist, not its file.
  const walled = org.treasure.land
  observed.otherDivision = {
    deal: await attempt(() => kit.as(walled, () => deals.getLandOpportunity(deal.id))),
    file: await attempt(() => kit.as(walled, () => deals.assertLandFileReadable(deal.id))),
    listed: (await kit.as(walled, () => deals.listLandOpportunities({}))).rows.some((row) => row.id === deal.id),
    rows: await kit.as(walled, async () => {
      const { supabase } = await context().requireOrgContext()
      const reach = async (table, column, value) => {
        const { data, error } = await supabase.from(table).select("id").eq(column, value)
        if (error) throw new Error(`${table}: ${error.message}`)
        return data.length
      }
      return { land_opportunities: await reach("land_opportunities", "id", deal.id), land_diligence_items: await reach("land_diligence_items", "land_opportunity_id", deal.id), files: await reach("files", "id", surveyFileId), file_links: await reach("file_links", "file_id", surveyFileId) }
    }),
  }
  observed.ownDivisionReadsTheFile = await kit.as(land, async () => {
    const { supabase } = await context().requireOrgContext()
    const { data, error } = await supabase.from("files").select("id").eq("id", surveyFileId)
    if (error) throw new Error(error.message)
    return data.length
  })
  check.equal("a deal's diligence carries owners, due dates and evidence; each submitted version is kept and superseded by any change; named approvers decide only the version they saw, never the submitter; the linked takedown closes only after approval; another division reaches neither the deal nor its file", expected.expected, observed)
  return { orgId: org.orgId, dealId: deal.id, reviewIds: [r1, r2], takedownId: takedown.id, evidenceFileId: surveyFileId }
}

// ---------------------------------------------------------------------------
// 2. EP04-02: an overdue condition of approval scoped to one phase is a community blocker
//    and holds the entitlements gate of that phase's starts, and only that phase's.

async function entitlementsHoldStarts(kit, expected, check) {
  const { org } = await world(kit)
  const entitlements = app("land-entitlements"), communities = app("communities"), starts = app("starts")
  const land = org.team.land
  const phase3 = await kit.as(land, () => communities.createCommunityPhase(org.communityId, { name: "Phase 3", phaseNumber: 3, status: "open" }))
  const ids = await newLots(kit, org, [{ lotNumber: "31", phaseId: phase3.id, status: "developed" }, { lotNumber: "32", phaseId: org.phaseIds[0], status: "developed" }])
  // The final plat is recorded; the county's turn-lane condition for phase 3 is not met, and is late.
  const plat = await kit.as(land, () => entitlements.createEntitlement(org.communityId, { kind: "final_plat", name: "Cypress Landing final plat", jurisdiction: "Collier County", status: "approved", approvedOn: "2026-05-20", requiredBefore: "vertical_start" }))
  const condition = await kit.as(land, () => entitlements.createCondition(plat.id, { title: "Phase 3 turn lane accepted by the county", communityPhaseId: phase3.id, requiredBefore: "vertical_start", dueOn: seed.isoDay(-10), ownerUserId: land.userId }))
  const readiness = async () => {
    const tab = await kit.as(land, () => entitlements.listCommunityEntitlements(org.communityId))
    const start = (phaseId) => tab.readiness.find((row) => row.phaseId === phaseId).start.map((blocker) => ({ kind: blocker.kind, title: blocker.title, reason: blocker.reason, requiredBefore: blocker.requiredBefore, overdueDays: blocker.overdueDays }))
    return { phase3: start(phase3.id), phase1: start(org.phaseIds[0]) }
  }
  const pressure = () => kit.as(land, async () => {
    const { supabase } = await context().requireOrgContext()
    return (await entitlements.countEntitlementBlockersByCommunity(supabase, org.orgId, [org.communityId])).get(org.communityId) ?? null
  })
  const observed = { communityBlockers: await readiness(), communityPressure: await pressure() }
  const gate = (gates) => gates.find((row) => row.key === "entitlements")?.status ?? "missing"
  const held = await kit.as(org.team.starts, () => starts.openStartPackage(ids["31"], { isFinanced: false }))
  const free = await kit.as(org.team.starts, () => starts.openStartPackage(ids["32"], { isFinanced: false }))
  observed.entitlementsGate = {
    phase3Lot: gate(await kit.as(org.team.starts, () => starts.refreshAutoGates(held.id))),
    phase1Lot: gate(await kit.as(org.team.starts, () => starts.refreshAutoGates(free.id))),
  }
  observed.meetCondition = await attempt(() => kit.as(land, () => entitlements.meetCondition(condition.id, { metOn: seed.isoDay(0) })))
  observed.afterMet = {
    phase3LotGate: gate(await kit.as(org.team.starts, () => starts.refreshAutoGates(held.id))),
    communityBlockers: await readiness(),
    communityPressure: await pressure(),
  }
  check.equal("an overdue phase-3 condition required before vertical start shows on the community and holds the entitlements gate of a phase-3 start; a phase-1 start is not held; meeting the condition clears both", expected.expected, observed)
  return { orgId: org.orgId, entitlementId: plat.id, conditionId: condition.id, packageIds: [held.id, free.id] }
}

// ---------------------------------------------------------------------------
// 3. EP04-03: a land contract's signed terms hold, deposits move with receipts, a takedown's
//    date moves only by a recorded extension, and the cash plan carries the obligations.

async function landContractDepositsExtensionsAndCash(kit, expected, check) {
  const { org } = await world(kit)
  const contracts = app("land-contracts"), communities = app("communities"), forecast = app("reports/cash-flow-forecast")
  const land = org.team.land, q = kit.q
  const contract = await kit.as(land, () => contracts.createLandContract(org.communityId, { title: "Cypress Landing phase 2 option", kind: "option", totalLots: 10, basePricePerLotCents: 7500000 }))
  const takedown = await kit.as(land, () => communities.createLotTakedown(org.communityId, { name: "Phase 2 option tranche", communityPhaseId: org.phaseIds[1], scheduledDate: "2027-04-15", lotCount: 10, pricePerLotCents: 7500000, landContractId: contract.id }))
  const earnest = await kit.as(land, () => contracts.scheduleLandContractDeposit(contract.id, { label: "Option deposit", takedownId: takedown.id, dueOn: "2026-10-01", amountCents: 500000, refundability: "refundable" }))
  const second = await kit.as(land, () => contracts.scheduleLandContractDeposit(contract.id, { label: "Second deposit", takedownId: takedown.id, dueOn: "2027-02-10", amountCents: 250000, refundability: "non_refundable" }))
  // The signed option agreement, the wire receipt and the signed extension (fixture: no file storage).
  const signedFileId = fileRecord(kit, org, "cypress-landing-phase-2-option.pdf")
  const receiptFileId = fileRecord(kit, org, "phase-2-option-deposit-wire.pdf")
  const extensionFileId = fileRecord(kit, org, "phase-2-extension-letter.pdf")
  const observed = { execute: await attempt(() => kit.as(land, () => contracts.executeLandContract(contract.id, { executedOn: "2026-09-28", executedFileId: signedFileId }))) }
  observed.termsAfterExecution = {
    service: await attempt(() => kit.as(land, () => contracts.updateLandContract(contract.id, { totalLots: 12 }))),
    database: sqlAttempt(kit, `update public.land_contracts set total_lots=12 where id=${q(contract.id)}`),
  }
  observed.scheduleAfterExecution = await attempt(() => kit.as(land, () => contracts.scheduleLandContractDeposit(contract.id, { label: "Late deposit", takedownId: takedown.id, dueOn: "2027-01-05", amountCents: 100000 })))
  observed.paymentWithoutReceipt = {
    service: await attempt(() => kit.as(land, () => contracts.recordLandContractDepositPayment(earnest.id, { paidOn: "2026-10-01", paymentReference: "Wire 1001" }))),
    database: sqlAttempt(kit, `update public.land_contract_deposits set status='paid', paid_on='2026-10-01' where id=${q(earnest.id)}`),
  }
  observed.paymentWithReceipt = await attempt(() => kit.as(land, () => contracts.recordLandContractDepositPayment(earnest.id, { paidOn: "2026-10-01", paymentReference: "Wire 1001", evidenceFileId: receiptFileId })))
  const scheduledDate = () => one(kit, `select scheduled_date::text d from public.lot_takedowns where id=${q(takedown.id)}`).d
  observed.extension = await attempt(() => kit.as(land, () => contracts.recordLandContractExtension({ takedownId: takedown.id, toDate: "2027-06-15", feeCents: 1500000, feeDueOn: "2027-03-01", reason: "Seller granted sixty days while the county records the phase 2 plat", evidenceFileId: extensionFileId })))
  observed.takedownAfterExtension = scheduledDate()
  const amendment = one(kit, `select id from public.land_contract_amendments where land_contract_id=${q(contract.id)}`)
  observed.amendmentIsAppendOnly = {
    rewrite: sqlAttempt(kit, `update public.land_contract_amendments set reason='Rewritten after the fact to hide the fee' where id=${q(amendment.id)}`),
    delete: sqlAttempt(kit, `delete from public.land_contract_amendments where id=${q(amendment.id)}`),
  }
  observed.dateEditWithoutExtension = {
    service: await attempt(() => kit.as(land, () => communities.updateLotTakedown(takedown.id, { scheduledDate: "2027-07-01" }))),
    database: sqlAttempt(kit, `update public.lot_takedowns set scheduled_date='2027-07-01' where id=${q(takedown.id)}`),
  }
  observed.takedownAfterRefusals = scheduledDate()
  const recorded = (await kit.as(land, () => contracts.listCommunityLandContracts(org.communityId))).find((row) => row.id === contract.id)
  observed.contract = {
    status: recorded.status, totalLots: recorded.totalLots,
    deposits: recorded.deposits.map((row) => ({ label: row.label, amountCents: row.amountCents, status: row.status, receipt: row.evidenceFileId === receiptFileId })),
    amendments: recorded.amendments.map((row) => ({ kind: row.kind, fromDate: row.fromDate, toDate: row.toDate, feeCents: row.feeCents, dueOn: row.dueOn, evidence: row.evidenceFileId === extensionFileId })),
  }
  // The cash plan, by the owner: land obligations in the months this contract touches.
  const months = ["2027-02", "2027-03", "2027-04", "2027-06"]
  const landCash = async (lens) => {
    const plan = await kit.as(org.owner, () => forecast.getCashFlowForecast(lens))
    return Object.fromEntries(months.map((month) => [month, plan.rows.find((row) => row.month === month)?.land_obligations_cents ?? 0]))
  }
  observed.cashPlan = { organization: await landCash({}), cypressLanding: await landCash({ communityId: org.communityId }), seagrapeHammock: await landCash({ communityId: org.treasure.communityId }) }
  check.equal("an executed land contract refuses term and schedule changes; a deposit is paid only with its receipt; an extension moves the takedown and stays an append-only amendment; the date never moves without one; the cash plan nets credited deposits off the takedown in its month and carries the scheduled deposit and the fee, by organization and by community", expected.expected, observed)
  return { orgId: org.orgId, contractId: contract.id, takedownId: takedown.id, depositIds: [earnest.id, second.id], amendmentId: amendment.id }
}

// ---------------------------------------------------------------------------
// 4. EP04-04: a development job is linked to the phase it develops; Books allocates its cost
//    only to that phase's lots; the community reconciles budget, commitments, cost and allocation.

async function developmentReconcilesToPhasesAndLots(kit, expected, check) {
  const { org } = await world(kit)
  const communities = app("communities"), budgets = app("budgets"), commitments = app("commitments"), bills = app("vendor-bills"), inventory = app("books/inventory"), ledger = app("land-development")
  const vendorId = org.vendorIds["Cypress Sitework"], costCodeId = org.costCodeIds["31-000"]
  const jobId = await bareHome(kit, org, "Cypress Landing phase 1 site development")
  await adoptInventory(kit, org, jobId)
  await kit.as(org.owner, () => budgets.createBudget({ project_id: jobId, status: "approved", lines: [{ cost_code_id: costCodeId, description: "Phase 1 mass grading, utilities and paving", amount_cents: 30000000 }] }))
  // The office enters the subcontract and the first draw; the owner approves both (an enterer never approves).
  const subcontract = await kit.as(org.bookkeeper, () => commitments.createCommitment({ input: { project_id: jobId, company_id: vendorId, commitment_type: "subcontract", title: "Phase 1 site work", total_cents: 25000000 } }))
  await kit.as(org.bookkeeper, () => commitments.createCommitmentLine(subcontract.id, { cost_code_id: costCodeId, description: "Phase 1 site work", quantity: 1, unit: "ls", unit_cost_cents: 25000000 }))
  await kit.as(org.owner, () => commitments.updateCommitment({ commitmentId: subcontract.id, input: { status: "approved", prequal_override_note: "Acceptance trade: no prequalification on file for this vendor." } }))
  const draw = await kit.as(org.bookkeeper, () => bills.createProjectVendorBill({ projectId: jobId, input: { company_id: vendorId, commitment_id: subcontract.id, bill_number: "CLS-1001", bill_date: seed.isoDay(-3), due_date: seed.isoDay(27),
    total_cents: 12000000, actual_lines: [{ cost_code_id: costCodeId, description: "Mass grading and utilities, draw 1", amount_cents: 12000000, project_id: jobId }] } }))
  await kit.as(org.owner, () => bills.approveVendorBillsAtomic([{ id: draw.id }]))
  await kit.drainOutbox(org.orgId)
  await project(kit, org)

  const [lot9, lot10, lot11] = [org.lots[8], org.lots[9], org.lots[10]]
  const proposal = (lots) => ({ projectId: jobId, date: seed.isoDay(0), reference: "Cypress Landing phase 1 site work", basis: "equal", totalCents: 6000000,
    weights: lots.map((lot) => ({ lotId: lot.id, weight: 1 })), evidenceUrl: `${seed.EVIDENCE}/phase-1-site-allocation`, note: "Draw 1 grading and utilities serve the phase 1 lots equally." })
  const propose = (lots) => attempt(() => kit.as(org.reviewer, () => inventory.proposeDevelopmentAllocation(proposal(lots))))
  const observed = { proposeBeforeLink: await propose([lot9, lot10]) }
  const link = (actor) => attempt(() => kit.as(actor, () => communities.linkPhaseDevelopmentProject(org.phaseIds[0], { developmentProjectId: jobId })))
  observed.linkByLandManager = await link(org.team.land)
  observed.linkByOwner = await link(org.owner)
  const read = async () => {
    const result = await kit.as(org.team.land, () => ledger.getCommunityDevelopmentLedger(org.communityId))
    const job = result.jobs.find((row) => row.projectId === jobId)
    const phase = (phaseId) => result.phases.find((row) => row.phaseId === phaseId)
    return {
      job: job ? { phases: job.phaseIds.map((id) => (id === org.phaseIds[0] ? "Phase 1" : id)), budgetCents: job.budgetCents, committedCents: job.committedCents, actualCents: job.actualCents, allocatedCents: job.allocatedCents, unallocatedCents: job.unallocatedCents, flags: job.flags } : null,
      phase1: { developedBy: phase(org.phaseIds[0]).projectId === jobId ? "the job" : phase(org.phaseIds[0]).projectId, allocatedCents: phase(org.phaseIds[0]).allocatedCents, flags: phase(org.phaseIds[0]).flags },
      phase2: { developedBy: phase(org.phaseIds[1]).projectId, allocatedCents: phase(org.phaseIds[1]).allocatedCents },
    }
  }
  observed.ledgerBeforeAllocation = await read()
  observed.proposeOutsideThePhase = await propose([lot10, lot11])
  observed.proposeInsideThePhase = await propose([lot9, lot10])
  const allocationId = one(kit, `select id from public.books_development_allocations where org_id=${kit.q(org.orgId)} and project_id=${kit.q(jobId)} and status='proposed'`).id
  observed.proposerApproves = await attempt(() => kit.as(org.reviewer, () => inventory.reviewDevelopmentAllocation({ allocationId, approve: true })))
  observed.ownerApproves = await attempt(() => kit.as(org.owner, () => inventory.reviewDevelopmentAllocation({ allocationId, approve: true })))
  await kit.drainOutbox(org.orgId)
  await project(kit, org)
  observed.shares = kit.rows(`select shares from public.books_development_allocations where id=${kit.q(allocationId)}`)[0].shares
    .map((share) => ({ lot: share.lot_id === lot9.id ? "9" : share.lot_id === lot10.id ? "10" : share.lot_id, amountCents: Number(share.amount_cents) })).sort((a, b) => a.lot.localeCompare(b.lot))
  observed.ledger = await read()
  // Gross job cost as posted, allocation rows included: what the reconciliation must not report as actual.
  observed.postedJobCostNetOfAllocation = Number(one(kit, `select coalesce(sum(cost_cents),0)::bigint n from public.job_cost_entries where org_id=${kit.q(org.orgId)} and project_id=${kit.q(jobId)} and status='posted'`).n)
  check.equal("a development allocation is refused until the job is linked to its phase and for any lot outside that phase; once a second member approves it, the ledger reconciles the job's budget, commitments, gross actual cost, allocated and unallocated cost to the phase", expected.expected, observed)
  return { orgId: org.orgId, developmentProjectId: jobId, allocationId, commitmentId: subcontract.id, billId: draw.id }
}

// ---------------------------------------------------------------------------
// 5. EP04-04: a vertical start cannot consume a lot land development has not delivered,
//    unless a holder of lot.delivery_override records an exception with a reason.

async function undeliveredLotNeedsAuthorizedException(kit, expected, check) {
  const { org } = await world(kit)
  const lots = app("lots"), starts = app("starts")
  const land = org.team.land, q = kit.q
  const ids = await newLots(kit, org, ["41", "42", "43"].map((lotNumber) => ({ lotNumber, phaseId: org.phaseIds[1], status: "owned" })))
  // The start pipeline's refusal, whichever of its two delivery rules says it.
  const pipeline = (text) => (/not been delivered|Only developed or assigned lots/.test(text) ? "refused: land not delivered" : text)
  const openPackage = async (lotId) => pipeline(await attempt(() => kit.as(org.team.starts, () => starts.openStartPackage(lotId, { isFinanced: false }))))
  const attach = async (lotId, name) => { const homeId = await bareHome(kit, org, name); return { homeId, result: await attempt(() => kit.as(org.owner, () => lots.attachProjectToLot(lotId, homeId))) } }
  const reason = "Pad is graded and the sewer stub is in; the plat records next week."
  const observed = { withoutException: { openPackage: await openPackage(ids["41"]) } }
  const home41 = await attach(ids["41"], "Cypress Landing lot 41")
  observed.withoutException.attachHome = home41.result
  observed.withoutException.startedByDatabase = sqlAttempt(kit, `update public.lots set project_id=${q(home41.homeId)}, status='started' where id=${q(ids["41"])}`)
  observed.recordWithoutAuthority = await attempt(() => kit.as(org.team.starts, () => lots.recordLotDeliveryException(ids["41"], { reason })))
  observed.recordWithoutReason = await attempt(() => kit.as(land, () => lots.recordLotDeliveryException(ids["41"], { reason: "later" })))
  observed.record = await attempt(() => kit.as(land, () => lots.recordLotDeliveryException(ids["41"], { reason })))
  observed.exception = kit.rows(`select approved_by=${q(land.userId)} by_land_manager, revoked_at is null live from public.lot_delivery_exceptions where lot_id=${q(ids["41"])}`)
  observed.withException = { openPackage: await openPackage(ids["41"]) }
  // Lot 42: an exception recorded and revoked no longer lets a house start.
  observed.recordThenRevoke = {
    record: await attempt(() => kit.as(land, () => lots.recordLotDeliveryException(ids["42"], { reason }))),
    revoke: await attempt(() => kit.as(land, () => lots.revokeLotDeliveryException(ids["42"]))),
  }
  observed.afterRevoke = { openPackage: await openPackage(ids["42"]), attachHome: (await attach(ids["42"], "Cypress Landing lot 42")).result }
  // Lot 43: under a live exception a home attaches and the database lets the lot start.
  await kit.as(land, () => lots.recordLotDeliveryException(ids["43"], { reason }))
  observed.underException = { attachHome: (await attach(ids["43"], "Cypress Landing lot 43")).result }
  observed.underException.lot = kit.rows(`select status, delivered_at is null undelivered from public.lots where id=${q(ids["43"])}`)[0]
  observed.lots = Object.fromEntries(kit.rows(`select lot_number, status, project_id is not null has_home from public.lots where id in (${q(ids["42"])},${q(ids["43"])}) order by lot_number`).map((row) => [row.lot_number, { status: row.status, hasHome: row.has_home }]))
  observed.events = Object.fromEntries(kit.rows(`select event_type, count(*)::int n from public.events where org_id=${q(org.orgId)} and event_type in ('lot.delivery_exception_recorded','lot.delivery_exception_revoked') group by 1 order by 1`).map((row) => [row.event_type, row.n]))
  check.equal("an undelivered lot refuses a start package, a home and a started status; only a lot.delivery_override holder records an exception, with a reason; under it the start proceeds, and a revoked exception refuses again", expected.expected, observed)
  return { orgId: org.orgId, lotIds: ids }
}

// ---------------------------------------------------------------------------
// 6. EP04-05: a lot's status agrees with its home, for every writer; reversals need an
//    explicit, authorized force; a legacy row is not revalidated until its status moves.

async function lotStateRequiresHome(kit, expected, check) {
  const { org } = await world(kit)
  const lots = app("lots")
  const land = org.team.land, q = kit.q
  const ids = await newLots(kit, org, [{ lotNumber: "51", phaseId: org.phaseIds[0], status: "developed" }, { lotNumber: "52", phaseId: org.phaseIds[0], status: "developed" }])
  const set = (actor, lotId, status, force = false) => attempt(() => kit.as(actor, () => lots.setLotStatus(lotId, status, { force })))
  const statusOf = (lotId) => one(kit, `select status from public.lots where id=${q(lotId)}`).status
  const observed = {
    startedWithoutHome: { service: await set(land, ids["51"], "started"), database: sqlAttempt(kit, `update public.lots set status='started' where id=${q(ids["51"])}`) },
    closedWithoutHome: { service: await set(land, ids["51"], "closed"), database: sqlAttempt(kit, `update public.lots set status='closed' where id=${q(ids["51"])}`) },
  }
  const homeId = await bareHome(kit, org, "Cypress Landing lot 52")
  await kit.as(org.owner, () => lots.attachProjectToLot(ids["52"], homeId))
  observed.homeAttached = statusOf(ids["52"])
  observed.developedWithHome = { service: await set(land, ids["52"], "developed"), database: sqlAttempt(kit, `update public.lots set status='developed' where id=${q(ids["52"])}`) }
  observed.leaveStarted = {
    withoutForce: await set(land, ids["52"], "assigned"),
    forceWithoutCommunityWrite: await set(org.team.starts, ids["52"], "assigned", true),
    forceByLandManager: await set(land, ids["52"], "assigned", true),
    status: statusOf(ids["52"]),
  }
  observed.backTwoSteps = { withoutForce: await set(land, ids["51"], "controlled"), withForce: await set(land, ids["51"], "controlled", true), status: statusOf(ids["51"]) }
  // A lot started before the guard existed, with no home (production holds five): written
  // directly with triggers off, as the legacy data was (fixture).
  const legacyId = randomUUID()
  kit.sql(`begin;
set local session_replication_role = replica;
insert into public.lots(id,org_id,community_id,division_id,community_phase_id,lot_number,status,delivered_at,address) values(${q(legacyId)},${q(org.orgId)},${q(org.communityId)},${q(org.divisionId)},${q(org.phaseIds[0])},'53','started',now(),'53 Cypress Landing Way');
commit;`, "supabase_admin")
  observed.legacyStartedWithoutHome = {
    editUnrelated: await attempt(() => kit.as(land, () => lots.updateLot(legacyId, { notes: "Started under the 2025 import with no home record" }))),
    leaveWithoutForce: await set(land, legacyId, "developed"),
    leaveWithForce: await set(land, legacyId, "developed", true),
    status: statusOf(legacyId),
  }
  observed.statusEvents = count(kit, `select 1 from public.events where org_id=${q(org.orgId)} and event_type='lot.status_changed' and entity_id in (${q(ids["51"])},${q(ids["52"])},${q(legacyId)})`)
  check.equal("started and closed need a home and developed refuses one, in the service and in the database; leaving started needs force from a community.write holder; a backward jump needs force; a legacy homeless started lot keeps working until its status moves, and then answers to the same rules", expected.expected, observed)
  return { orgId: org.orgId, lotIds: { ...ids, "53": legacyId }, homeId }
}

// ---------------------------------------------------------------------------
// 7. EP04-06, one step at a time: a lapsed hold frees its lot, a release refunds once and
//    returns the home to inventory, and a home cannot be attached past another buyer's hold.

async function noDoubleSellingSequential(kit, expected, check) {
  const { org } = await world(kit)
  const sales = app("community-sales"), lots = app("lots")
  const q = kit.q
  const future = () => new Date(Date.now() + 14 * 86400000).toISOString()
  const hold = async (name, lotId) => {
    const prospect = await seed.registerBuyer(kit, org, { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@acceptance.example.test` })
    return kit.as(org.team.sales, () => sales.createLotHoldFromProspect({ prospectId: prospect.id, lotId, expiresAt: future() }))
  }
  const statusOf = (id) => one(kit, `select status from public.lot_reservations where id=${q(id)}`).status
  const liveOn = (lotId) => count(kit, `select 1 from public.lot_reservations where lot_id=${q(lotId)} and status in ('hold','reserved','converted') and (status <> 'hold' or expires_at is null or expires_at > now())`)

  // Lot 2: a hold whose expiry has passed (the stack cannot wait two weeks: its expiry is moved back, fixture).
  const [lot2, lot3, lot4] = [org.lots[1], org.lots[2], org.lots[3]]
  const lapsed = await hold("Lapsed Buyer", lot2.id)
  kit.sql(`update public.lot_reservations set expires_at = now() - interval '1 minute' where id=${q(lapsed.id)}`)
  let next = null
  const observed = { lapsedHold: { nextBuyerHolds: await attempt(async () => { next = await hold("Next Buyer", lot2.id) }) } }
  Object.assign(observed.lapsedHold, { lapsed: statusOf(lapsed.id), next: next ? statusOf(next.id) : null, liveOnLot: liveOn(lot2.id),
    expiryEvents: count(kit, `select 1 from public.events where org_id=${q(org.orgId)} and event_type='lot_hold_expired' and entity_id=${q(lapsed.id)}`) })

  // Lot 3: a reserved buyer with a received deposit walks away; the owner releases with a refund, twice.
  const prospect = await seed.registerBuyer(kit, org, { name: "Refund Buyer", email: "refund.buyer@acceptance.example.test" })
  const { reservation } = await seed.reserveLot(kit, org, { prospect, lotId: lot3.id, depositCents: 1500000, receivedOn: "2026-06-06" })
  const release = () => attempt(() => kit.as(org.owner, () => sales.releaseReservation({ reservationId: reservation.id, reason: "Buyer financing was declined", depositDisposition: "refund" })))
  observed.release = { first: await release(), second: await release() }
  const home = one(kit, `select l.project_id is not null has_home, p.client_id from public.lots l left join public.projects p on p.id=l.project_id where l.id=${q(lot3.id)}`)
  Object.assign(observed.release, {
    reservation: statusOf(reservation.id),
    refundsCents: kit.rows(`select r.amount_cents::bigint cents from public.payment_reversals r join public.payments p on p.id=r.payment_id where r.org_id=${q(org.orgId)} and p.invoice_id=${q(reservation.depositInvoiceId)} and r.reversal_type='refund' and r.status='succeeded'`).map((row) => Number(row.cents)),
    homeBackInInventory: home.has_home && home.client_id === null,
    liveOnLot: liveOn(lot3.id),
  })

  // Lot 4: a live hold; a home without that buyer cannot be attached, by the service or directly.
  await hold("Holding Buyer", lot4.id)
  const otherHome = await bareHome(kit, org, "Cypress Landing lot 4 (another buyer)")
  observed.attachPastAHold = {
    service: await attempt(() => kit.as(org.owner, () => lots.attachProjectToLot(lot4.id, otherHome))),
    database: sqlAttempt(kit, `update public.lots set project_id=${q(otherHome)} where id=${q(lot4.id)}`),
    lotHasHome: one(kit, `select project_id is not null h from public.lots where id=${q(lot4.id)}`).h,
    liveOnLot: liveOn(lot4.id),
  }
  check.equal("a lapsed hold is expired by the next buyer's hold, which owns the lot; a reservation releases once with one refund and its home returns to inventory; no home is attached past another buyer's live hold", expected.expected, observed)
  return { orgId: org.orgId, lapsedHoldId: lapsed.id, reservationId: reservation.id }
}

// ---------------------------------------------------------------------------
// 8. EP04-07: a spec home outside Books ages only from a completion date sales records,
//    never from the schedule, and never from a future date.

async function specAgingFromRecordedCompletion(kit, expected, check) {
  const { org } = await world(kit)
  const starts = app("starts"), sales = app("community-sales"), dispositions = app("spec-dispositions"), projects = app("projects")
  const lot5 = org.lots[4]
  // The starts desk opens lot 5 with no buyer: a spec home Books does not carry.
  const pkg = await kit.as(org.team.starts, () => starts.openStartPackage(lot5.id, { isFinanced: false }))
  const projectId = one(kit, `select project_id from public.start_packages where id=${kit.q(pkg.id)}`).project_id
  const age = async () => {
    const page = await kit.as(org.team.sales, () => sales.listSpecInventoryPage({ communityId: org.communityId, availability: "spec", limit: 250 }))
    const row = page.lots.find((lot) => lot.lotId === lot5.id)
    return row ? { completedAt: row.completedAt === seed.isoDay(-30) ? "<30 days ago>" : row.completedAt, underConstruction: row.underConstruction, agingDays: row.agingDays, completionFromBooks: row.completionFromBooks } : null
  }
  const observed = { building: await age() }
  // The house is finished; nobody recorded the day.
  await kit.as(org.owner, () => projects.updateProject({ projectId, input: { status: "completed" } }))
  observed.finishedNotRecorded = await age()
  const record = (completedOn, reason) => attempt(() => kit.as(org.team.sales, () => dispositions.recordSpecCompletion({ projectId, completedOn, ...(reason ? { reason } : {}) })))
  observed.futureDate = await record(seed.isoDay(5))
  observed.afterFutureRefusal = await age()
  observed.record = await record(seed.isoDay(-30))
  observed.recorded = await age()
  observed.changeWithoutReason = await record(seed.isoDay(-20))
  observed.audited = count(kit, `select 1 from public.audit_log where org_id=${kit.q(org.orgId)} and entity_type='project' and entity_id=${kit.q(projectId)} and after_data->>'completed_on'=${kit.q(seed.isoDay(-30))}`)
  check.equal("a spec home still building has no age; finished without a recorded date it says so and has no age; a future date is refused; a recorded past date ages it from that day; changing it needs a reason", expected.expected, observed)
  return { orgId: org.orgId, projectId, packageId: pkg.id }
}

// ---------------------------------------------------------------------------
// 9. EP04-08: small spec price moves apply; large ones need a second person; a below-cost
//    bulk sale is approved, waits for its Books write-down, and is carried out by the bulk
//    buyer's agreement, leaving margin baselines and earlier sale records as they were.

async function specPriceApprovalAndDisposition(kit, expected, check) {
  const { org } = await world(kit)
  const sales = app("community-sales"), dispositions = app("spec-dispositions"), lots = app("lots"), contacts = app("contacts"), inventory = app("books/inventory")
  const q = kit.q
  const lot7 = org.lots[6], plan = org.plans[0]
  // A spec Mangrove on lot 7, started and released (Books carries it from its start).
  await kit.as(org.team.starts, () => lots.assignPlanToLot(lot7.id, { versionId: plan.versionId, elevationId: plan.elevationIds[0] }))
  const gates = await seed.clearStartGates(kit, org, { lotId: lot7.id, spec: true })
  const released = await seed.releaseHome(kit, org, { packageId: gates.packageId, projectId: gates.projectId })
  const projectId = gates.projectId
  const asking = () => Number(one(kit, `select asking_price_cents from public.sellable_lot_inventory where lot_id=${q(lot7.id)}`).asking_price_cents)
  const observed = { released: released.released.status, askingBefore: asking() }

  // A $9,500 cut (2.5%, under both the 5% and the $10,000 band) applies at once.
  const move = (actor, toCents) => kit.as(actor, () => sales.proposeSpecPriceChange({ kind: "price", lotId: lot7.id, toCents, expectedAskingPriceCents: asking(), reason: "Matching the resale comps on Heron Court" }))
  const small = await move(org.team.sales, asking() - 950000)
  observed.smallMove = { status: small.status, requiredPermission: small.requiredPermission, askingAfter: asking() }
  // An 8% cut is a proposal until someone else holding sales.price_approve approves it.
  const eight = Math.round(asking() * 0.08)
  const large = await move(org.owner, asking() - eight)
  observed.largeMove = { status: large.status, requiredPermission: large.requiredPermission, moveCents: eight, askingWhileProposed: asking() }
  const decide = (actor) => attempt(() => kit.as(actor, () => sales.decideSpecPriceChange({ proposalId: large.proposalId, approve: true, note: "Aged spec; the cut is within the quarter's margin plan." })))
  observed.largeMove.proposerApproves = await decide(org.owner)
  observed.largeMove.salesAgentApproves = await decide(org.team.sales)
  observed.largeMove.adminApproves = await decide(org.team.admin)
  observed.largeMove.askingAfter = asking()

  // A retail buyer held the home and walked away: that record must outlive the sale-off.
  const walkaway = await seed.registerBuyer(kit, org, { name: "Retail Walkaway", email: "retail.walkaway@acceptance.example.test" })
  const retailHold = await kit.as(org.team.sales, () => sales.createLotHoldFromProspect({ prospectId: walkaway.id, lotId: lot7.id, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() }))
  await kit.as(org.team.sales, () => sales.releaseReservation({ reservationId: retailHold.id, reason: "Buyer chose a resale home" }))
  const priorRecords = () => JSON.stringify(kit.rows(`select id, status, buyer_contact_id, released_at, release_reason, contract_id, deposit_invoice_id from public.lot_reservations where lot_id=${q(lot7.id)} and status not in ('hold','reserved','converted') order by created_at`))
  const priorBefore = priorRecords()

  // The bulk buyer, entered in the directory by the office before the sale-off names them.
  const bulk = await kit.as(org.bookkeeper, () => contacts.createContact({ input: { full_name: "Gulf Coast Rental Partners", email: "acquisitions@gulf-rental.acceptance.example.test", contact_type: "client" } }))
  const carrying = Number(await kit.service(async () => (await require("../../../lib/supabase/server").createServiceSupabaseClient().rpc("books_home_carrying_cents", { p_org_id: org.orgId, p_project_id: projectId, p_as_of: seed.isoDay(0) })).data))
  const priceCents = 6500000
  const proposed = await kit.as(org.team.sales, () => dispositions.proposeSpecDisposition({ lotId: lot7.id, kind: "bulk_sale", counterpartyContactId: bulk.id, counterpartyCompanyId: null, priceCents, reason: "Rental operator takes the aged spec at land value to clear the phase" }))
  const dispositionId = proposed.dispositionId
  const execute = () => attempt(() => kit.as(org.team.sales, () => dispositions.executeSpecDisposition({ dispositionId })))
  observed.disposition = { status: proposed.status, carryingIsBooks: proposed.carryingCents === carrying, priceBelowCarrying: priceCents < carrying }
  observed.disposition.proposerApproves = await attempt(() => kit.as(org.team.sales, () => dispositions.decideSpecDisposition({ dispositionId, approve: true })))
  observed.disposition.adminApproves = await attempt(() => kit.as(org.team.admin, () => dispositions.decideSpecDisposition({ dispositionId, approve: true, note: "Sell-off approved at land value" })))
  observed.disposition.executeBeforeWriteDown = await execute()
  observed.disposition.writeDownProposed = await attempt(() => kit.as(org.owner, () => dispositions.proposeSpecDispositionWriteDown({ dispositionId, costToCompleteCents: 0, costToSellCents: 200000, evidenceUrl: `${seed.EVIDENCE}/lot-7-bulk-offer`, assumptions: "Bulk offer at land value; the buyer finishes the house; closing costs $2,000." })))
  observed.disposition.executeWhileWriteDownPending = await execute()
  const impairmentId = one(kit, `select impairment_id from public.spec_dispositions where id=${q(dispositionId)}`).impairment_id
  observed.disposition.writeDownApproved = await attempt(() => kit.as(org.reviewer, () => inventory.reviewInventoryImpairment({ impairmentId, approve: true })))
  observed.disposition.executeWithoutAgreement = await execute()

  // While the approved sale-off names its buyer, nobody else may hold the home.
  const shopper = await seed.registerBuyer(kit, org, { name: "Retail Shopper", email: "retail.shopper@acceptance.example.test" })
  observed.otherBuyerHolds = await attempt(() => kit.as(org.team.sales, () => sales.createLotHoldFromProspect({ prospectId: shopper.id, lotId: lot7.id, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() })))
  // The bulk buyer holds, reserves and signs; the agreement is priced through the disposition.
  const buyer = await kit.as(org.team.sales, () => app("sales-inquiries").registerProductionInquiry({ buyerName: "Gulf Coast Rental Partners", existingContactId: bulk.id, communityId: org.communityId, ownerUserId: org.team.sales.userId, channel: "phone", planInterest: "Mangrove", loggedDate: seed.isoDay(0) }))
  const { reservation } = await seed.reserveLot(kit, org, { prospect: buyer, lotId: lot7.id, depositCents: 500000 })
  const swing = one(kit, `select swing from public.lots where id=${q(lot7.id)}`).swing
  const sale = await seed.signAgreement(kit, org, { reservationId: reservation.id, config: seed.configuration(org, { lotId: lot7.id, plan, swing }) })
  const agreement = one(kit, `select total_cents, buyer_contact_id, snapshot->'purchase_agreement'->'pricing'->'disposition'->>'id' disposition_id from public.contracts where id=${q(sale.contractId)}`)
  observed.bulkAgreement = { buyerIsTheDispositionBuyer: agreement.buyer_contact_id === bulk.id, totalIsTheDispositionPrice: Number(agreement.total_cents) === priceCents, pricedThroughTheDisposition: agreement.disposition_id === dispositionId }
  const baselines = () => JSON.stringify(kit.rows(`select * from public.home_margin_baselines where project_id=${q(projectId)} order by stage`))
  const baselinesBefore = baselines()
  observed.execute = await execute()
  observed.after = {
    disposition: one(kit, `select status, contract_id=${q(sale.contractId)} carried_by_the_agreement, impairment_id is not null write_down_linked from public.spec_dispositions where id=${q(dispositionId)}`),
    writeDown: one(kit, `select status from public.books_inventory_impairments where id=${q(impairmentId)}`).status,
    marginBaselinesUnchanged: baselines() === baselinesBefore,
    earlierSaleRecordsUnchanged: priorRecords() === priorBefore,
  }
  check.equal("a small spec price cut applies at once; an 8% cut waits for a second sales.price_approve holder; a below-cost bulk sale is approved by someone else, cannot be carried out until its Books write-down is approved and the bulk buyer's agreement is written at the approved price, refuses other buyers meanwhile, and leaves margin baselines and earlier sale records untouched", expected.expected, observed)
  return { orgId: org.orgId, projectId, dispositionId, impairmentId, proposalIds: [small.proposalId, large.proposalId], contractId: sale.contractId }
}

module.exports = {
  id: "LAND-01",
  subcases: {
    "land-deal-diligence-and-reviewed-versions": landDealDiligenceAndReviewedVersions,
    "entitlements-hold-starts": entitlementsHoldStarts,
    "land-contract-deposits-extensions-and-cash": landContractDepositsExtensionsAndCash,
    "development-reconciles-to-phases-and-lots": developmentReconcilesToPhasesAndLots,
    "undelivered-lot-needs-authorized-exception": undeliveredLotNeedsAuthorizedException,
    "lot-state-requires-home": lotStateRequiresHome,
    "no-double-selling-sequential": noDoubleSellingSequential,
    "spec-aging-from-recorded-completion": specAgingFromRecordedCompletion,
    "spec-price-approval-and-disposition": specPriceApprovalAndDisposition,
  },
}
