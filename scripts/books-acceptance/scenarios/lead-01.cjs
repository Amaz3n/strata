// LEAD-01 — lead ingestion and routing (EP05-01). One production builder (Cypress Landing in the
// Gulf Coast division with two sales consultants; Treasure Coast with Seagrape Hammock, which has
// no consultant but a division fallback owner) receives website leads through its signed endpoint,
// exactly as a website's server would post them: the route handler is called with a signed request.
// Every person acts through `kit.as`, so row-level security and permission checks are the real ones.
//
//   signed-lead-files-and-routes            a signed lead files once, on the Sales desk, to the next consultant, with its attribution
//   duplicates-merge-and-keep-attribution   email/phone matches merge into the open deal; keys replay; a namesake is a new deal
//   routing-fallbacks-respect-divisions     division fallback, rules, unrouted leads, and the division wall on the delivery log
//   bad-deliveries-are-visible-not-filed    unsigned, stale, nameless and unknown-source deliveries are refused or shown, never filed
//   transient-failure-retries-then-surfaces a database fault retries through the outbox, fails visibly, and Retry files it once
//   secret-rotation-grace                   a rotated secret keeps working for its grace window and no longer
//   only-sales-can-touch-leads              a superintendent cannot create or reassign a deal; a consultant can
//
// SQL is used only for what a subcase is not about and says so where it happens: a temporary
// trigger that makes filing fail (the fault under test), moving a queued retry's time to now (the
// stack cannot wait fifteen minutes), and ending a rotated secret's grace window. Reads that check
// the outcome are SQL as the stack superuser.
const seed = require("../production-seed.cjs")
const { app } = require("./shared.cjs")

const context = () => require("../../../lib/services/context")
const attempt = async (work) => {
  try { await work(); return "allowed" } catch (error) { return error.issues ? `invalid: ${error.issues.map((issue) => issue.message).join("; ")}` : error.message }
}
// A refusal for want of a permission, however the authorization layer words it.
const permissionAttempt = async (work) => {
  const outcome = await attempt(work)
  return /permission|not authorized|forbidden/i.test(outcome) ? "refused: permission" : outcome
}
const one = (kit, sql) => kit.rows(sql)[0]
const count = (kit, sql) => Number(kit.rows(`select count(*)::int n from (${sql}) t`)[0].n)

const WORLDS = new WeakMap()
function world(kit) {
  if (!WORLDS.has(kit)) WORLDS.set(kit, build(kit))
  return WORLDS.get(kit)
}

async function limitedMember(kit, org, role, divisionIds) {
  const actor = kit.addMember(org, role)
  const membershipId = one(kit, `select id from public.memberships where org_id=${kit.q(org.orgId)} and user_id=${kit.q(actor.userId)}`).id
  await kit.as(org.owner, () => app("team").updateMemberRole({ membershipId, role, divisionScope: "assigned", divisionIds }))
  return actor
}

async function build(kit) {
  const org = await seed.productionBuilder(kit, { name: "LEAD-01 lead intake" })
  await seed.seedCommunity(kit, org)
  // A second Cypress Landing consultant, assigned by the owner (community.write).
  org.consultantB = kit.addMember(org, "org_sales_agent")
  await kit.as(org.owner, () => app("community-assignments").assignCommunityMember({ communityId: org.communityId, userId: org.consultantB.userId, role: "sales" }))
  // Treasure Coast: a community with no consultant, and a fallback owner limited to that division.
  const divisionId = (await kit.as(org.owner, () => app("divisions").createDivision({ name: "Treasure Coast", code: "TC", region: "Southeast Florida" }))).id
  const communityId = (await kit.as(org.owner, () => app("communities").createCommunity({ name: "Seagrape Hammock", code: "SGH", divisionId, status: "active", city: "Stuart", state: "FL", postalCode: "34994", plannedLotCount: 2, targetAbsorptionPerMonth: 1 }))).id
  org.treasure = { divisionId, communityId, owner: await limitedMember(kit, org, "org_sales_agent", [divisionId]) }
  await kit.as(org.owner, () => app("lead-intake").setDivisionLeadOwner({ divisionId, ownerUserId: org.treasure.owner.userId }))
  // The online sales counselor works Gulf Coast only.
  org.osc = await limitedMember(kit, org, "org_sales_agent", [org.divisionId])
  const created = await kit.as(org.owner, () => app("lead-intake").createLeadSource({ name: "Company website", defaultSourceLabel: "Website" }))
  org.source = created.source
  org.secret = created.secret
  return { org }
}

let keys = 0
/** One delivery as the builder's website posts it: signed, keyed, through the public route. */
async function deliver(kit, org, body, { key = `lead-01-${Date.now()}-${(keys += 1)}`, secret = org.secret, timestamp = String(Math.floor(Date.now() / 1000)), publicId = org.source.publicId, signature } = {}) {
  const { NextRequest } = require("next/server")
  const { signInboundPayload } = require("../../../lib/inbound/signature")
  const route = require("../../../app/api/leads/intake/[sourceId]/route")
  const raw = JSON.stringify(body)
  const response = await kit.service(() => route.POST(
    new NextRequest(`http://127.0.0.1/api/leads/intake/${publicId}`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-arc-timestamp": timestamp, "x-arc-signature": signature ?? signInboundPayload(secret, timestamp, raw), "idempotency-key": key },
      body: raw,
    }),
    { params: Promise.resolve({ sourceId: publicId }) },
  ))
  return { status: response.status, body: await response.json(), key }
}

const receipt = (kit, id) => one(kit, `select status, failure_code, attempts, next_attempt_at is not null retry_scheduled, routing_outcome, matched_by, prospect_id from public.lead_intake_receipts where id=${kit.q(id)}`)
const prospectsFor = (kit, org, email) => kit.rows(`select p.id, p.owner_user_id, p.community_id from public.prospects p join public.prospect_contacts pc on pc.prospect_id=p.id and pc.is_primary where p.org_id=${kit.q(org.orgId)} and pc.email_normalized=${kit.q(email.toLowerCase())} order by p.created_at`)
const touches = (kit, prospectId) => kit.rows(`select touch, channel, source_label, utm_source, utm_medium, utm_campaign, utm_term, utm_content, click_ids, landing_url, referrer_url from public.prospect_attributions where prospect_id=${kit.q(prospectId)} order by touch`)
const webTraffic = (kit, org) => Number(one(kit, `select coalesce(sum(web_inquiries),0)::int n from public.community_traffic where community_id=${kit.q(org.communityId)}`).n)
const attention = (kit, actor) => kit.as(actor, () => app("lead-intake").listLeadAttention({ desk: "sales", customBuildNavigation: false }))
const who = (org, userId) => ({ [org.team.sales.userId]: "consultant A", [org.consultantB.userId]: "consultant B", [org.osc.userId]: "online sales counselor", [org.treasure.owner.userId]: "Treasure Coast fallback", [org.owner.userId]: "owner" })[userId] ?? (userId ? "someone else" : null)

// ---------------------------------------------------------------------------
// 1. A signed lead lands on the Sales board, owned by the next consultant, with its attribution.

async function signedLeadFilesAndRoutes(kit, expected, check) {
  const { org } = await world(kit)
  const trafficBefore = webTraffic(kit, org)
  const first = await deliver(kit, org, {
    first_name: "Dana", last_name: "Rivers", email: "dana.rivers@lead-01.example.test", phone: "(239) 555-0142", community: "CYP",
    plan_interest: "Mangrove", message: "Touring Saturday", utm_source: "google", utm_medium: "cpc", utm_campaign: "spring-open-house",
    utm_term: "naples new homes", utm_content: "hero", gclid: "gclid-123", referrer_url: "https://www.google.com/", landing_url: "https://builder.example.test/cypress-landing",
  })
  const second = await deliver(kit, org, { name: "Lee Park", email: "lee.park@lead-01.example.test", community: "cyp" })
  const [dana] = prospectsFor(kit, org, "dana.rivers@lead-01.example.test")
  const [lee] = prospectsFor(kit, org, "lee.park@lead-01.example.test")
  const board = await kit.as(org.team.sales, () => app("sales-deals").listSalesBoard({ includeClosed: false }))
  const observed = {
    responses: [first.status, second.status],
    receipt: (({ status, routing_outcome }) => ({ status, routing_outcome }))(receipt(kit, first.body.receipt_id)),
    onSalesBoard: board.deals.some((deal) => deal.prospectId === dana.id),
    ownedByAConsultant: ["consultant A", "consultant B"].includes(who(org, dana.owner_user_id)),
    secondLeadToTheOtherConsultant: dana.owner_user_id !== lee.owner_user_id && ["consultant A", "consultant B"].includes(who(org, lee.owner_user_id)),
    community: dana.community_id === org.communityId,
    firstTouch: touches(kit, dana.id)[0],
    webTrafficAdded: webTraffic(kit, org) - trafficBefore,
    ownerNotified: count(kit, `select 1 from public.notifications where org_id=${kit.q(org.orgId)} and user_id=${kit.q(dana.owner_user_id)} and notification_type='lead_assigned' and payload->>'entity_id'=${kit.q(dana.id)}`),
    directoryContact: Boolean(one(kit, `select contact_id from public.prospect_contacts where prospect_id=${kit.q(dana.id)} and is_primary`).contact_id),
  }
  check.equal("a signed website lead files once on the Sales board, owned by the next Cypress Landing consultant in rotation, counted as web traffic, with every UTM and click id on its first touch, and its owner told", expected.expected, observed)
  return { orgId: org.orgId, prospectId: dana.id, receiptId: first.body.receipt_id }
}

// ---------------------------------------------------------------------------
// 2. The same buyer again — by email in another case, then by phone alone — merges and keeps both touches.

async function duplicatesMergeAndKeepAttribution(kit, expected, check) {
  const { org } = await world(kit)
  const email = "sam.ortiz@lead-01.example.test"
  const original = await deliver(kit, org, { name: "Sam Ortiz", email, phone: "239-555-0177", community: "CYP", utm_campaign: "spring" })
  const [sam] = prospectsFor(kit, org, email)
  const trafficBefore = webTraffic(kit, org)
  const byEmail = await deliver(kit, org, { name: "Sam Ortiz", email: "SAM.Ortiz@lead-01.example.test", community: "CYP", utm_campaign: "summer" })
  const byPhone = await deliver(kit, org, { name: "Sam O.", phone: "+1 239 555 0177", community: "CYP" })
  const replay = await deliver(kit, org, { name: "Sam Ortiz", email, phone: "239-555-0177", community: "CYP", utm_campaign: "spring" }, { key: original.key })
  const conflict = await deliver(kit, org, { name: "Sam Ortiz", email, community: "CYP", utm_campaign: "changed" }, { key: original.key })
  // The consultant registers the same person walking in: same deal, a walk-in touch.
  await kit.as(org.team.sales, () => app("sales-inquiries").registerProductionInquiry({ buyerName: "Sam Ortiz", email, communityId: org.communityId, channel: "walk_in", loggedDate: seed.isoDay(0) }))
  // A different buyer who shares the name.
  await deliver(kit, org, { name: "Sam Ortiz", email: "sam.ortiz.other@lead-01.example.test", community: "CYP" })
  const observed = {
    statuses: { byEmail: byEmail.status, byPhone: byPhone.status, replay: replay.status, conflict: conflict.status },
    merged: [receipt(kit, byEmail.body.receipt_id), receipt(kit, byPhone.body.receipt_id)].map((row) => ({ status: row.status, matched_by: row.matched_by, sameDeal: row.prospect_id === sam.id, routing_outcome: row.routing_outcome })),
    replayIsTheFirstReceipt: replay.body.receipt_id === original.body.receipt_id,
    dealsForThisBuyer: prospectsFor(kit, org, email).length,
    touches: touches(kit, sam.id).map((touch) => ({ touch: touch.touch, channel: touch.channel, utm_campaign: touch.utm_campaign })),
    ownerUnchanged: one(kit, `select owner_user_id from public.prospects where id=${kit.q(sam.id)}`).owner_user_id === sam.owner_user_id,
    webTrafficAdded: webTraffic(kit, org) - trafficBefore,
    namesakeIsANewDeal: prospectsFor(kit, org, "sam.ortiz.other@lead-01.example.test").length === 1,
  }
  check.equal("a returning buyer matched by email in any case, or by phone in any format, merges into their open deal with each touch kept and the owner untouched; a replayed key answers with the first receipt and a changed body under it is refused; a walk-in by the same person joins the same deal; a namesake is a new deal", expected.expected, observed)
  return { orgId: org.orgId, prospectId: sam.id }
}

// ---------------------------------------------------------------------------
// 3. Fallbacks, rules, unrouted leads and the division wall.

async function routingFallbacksRespectDivisions(kit, expected, check) {
  const { org } = await world(kit)
  const intake = app("lead-intake")
  const seagrape = await deliver(kit, org, { name: "Ana Torres", email: "ana.torres@lead-01.example.test", community: "SGH" })
  const rule = await kit.as(org.owner, () => intake.createLeadRoutingRule({ name: "Zillow to the OSC", priority: 10, utmSource: "zillow", assignedUserId: org.osc.userId }))
  const zillow = await deliver(kit, org, { name: "Rob Zane", email: "rob.zane@lead-01.example.test", community: "CYP", utm_source: "Zillow" })
  await kit.as(org.owner, () => intake.deleteLeadRoutingRule(rule.id))
  await kit.as(org.owner, () => intake.setDivisionLeadOwner({ divisionId: org.treasure.divisionId, ownerUserId: null }))
  const unrouted = await deliver(kit, org, { name: "Kim Hale", email: "kim.hale@lead-01.example.test", community: "SGH" })
  const unknown = await deliver(kit, org, { name: "Lou Grant", email: "lou.grant@lead-01.example.test", community: "NOPE" })
  const ownerView = await attention(kit, org.owner)
  const oscView = await attention(kit, org.osc)
  const kim = prospectsFor(kit, org, "kim.hale@lead-01.example.test")[0]
  const kinds = (view) => view.rows.map((row) => [row.kind, row.contactName]).filter(([, name]) => ["Kim Hale", "Lou Grant"].includes(name)).sort()
  const assign = await attempt(() => kit.as(org.owner, () => app("prospects").updateDealDetails({ prospectId: kim.id, input: { fullName: "Kim Hale", email: "kim.hale@lead-01.example.test", ownerUserId: org.owner.userId, communityId: org.treasure.communityId } })))
  const observed = {
    divisionFallback: { outcome: receipt(kit, seagrape.body.receipt_id).routing_outcome, owner: who(org, prospectsFor(kit, org, "ana.torres@lead-01.example.test")[0].owner_user_id) },
    ruleWins: { outcome: receipt(kit, zillow.body.receipt_id).routing_outcome, owner: who(org, prospectsFor(kit, org, "rob.zane@lead-01.example.test")[0].owner_user_id) },
    unrouted: { status: unrouted.status, outcome: receipt(kit, unrouted.body.receipt_id).routing_outcome, owner: kim.owner_user_id },
    unknownCommunity: { status: unknown.status, reason: unknown.body.reason, filed: prospectsFor(kit, org, "lou.grant@lead-01.example.test").length },
    ownerSees: kinds(ownerView),
    gulfCoastOscSees: kinds(oscView),
    assignOwner: assign,
    afterAssignment: kinds(await attention(kit, org.owner)),
  }
  check.equal("a Seagrape lead goes to its division's fallback owner, a matching rule beats the rotation, a lead nobody can take is filed unrouted and shown until someone owns it, an unknown community is refused and shown, and a Gulf-Coast-only counselor never sees Treasure Coast's deliveries", expected.expected, observed)
  return { orgId: org.orgId, unroutedProspectId: kim.id }
}

// ---------------------------------------------------------------------------
// 4. Deliveries Arc refuses.

async function badDeliveriesAreVisibleNotFiled(kit, expected, check) {
  const { org } = await world(kit)
  const prospectsBefore = count(kit, `select 1 from public.prospects where org_id=${kit.q(org.orgId)}`)
  const rejectedBefore = one(kit, `select rejected_count from public.lead_intake_sources where id=${kit.q(org.source.id)}`).rejected_count
  const wrongSignature = await deliver(kit, org, { name: "Eve", email: "eve@lead-01.example.test" }, { signature: "0".repeat(64) })
  const stale = await deliver(kit, org, { name: "Eve", email: "eve@lead-01.example.test" }, { timestamp: String(Math.floor(Date.now() / 1000) - 3600) })
  const nameless = await deliver(kit, org, { first_name: "No", last_name: "Contact", community: "CYP" })
  const unknownSource = await deliver(kit, org, { name: "Eve", email: "eve@lead-01.example.test" }, { publicId: "lis_000000000000000000000000" })
  const observed = {
    wrongSignature: [wrongSignature.status, wrongSignature.body.reason],
    stale: [stale.status, stale.body.reason],
    nameless: [nameless.status, nameless.body.reason],
    unknownSource: unknownSource.status,
    rejectedCountAdded: one(kit, `select rejected_count from public.lead_intake_sources where id=${kit.q(org.source.id)}`).rejected_count - rejectedBefore,
    prospectsAdded: count(kit, `select 1 from public.prospects where org_id=${kit.q(org.orgId)}`) - prospectsBefore,
    namelessShownToConsultant: (await attention(kit, org.team.sales)).rows.some((row) => row.receiptId === nameless.body.receipt_id && row.kind === "failed"),
  }
  check.equal("a wrongly signed or stale delivery is refused and counted on its source, one naming nobody is kept and shown as not filed, an unknown source is a 404, and none of them files a deal", expected.expected, observed)
  return { orgId: org.orgId }
}

// ---------------------------------------------------------------------------
// 5. A database fault: retried through the outbox, then failed visibly, then filed once by Retry.

async function transientFailureRetriesThenSurfaces(kit, expected, check) {
  const { org } = await world(kit)
  const email = "faulty.buyer@lead-01.example.test"
  // The fault under test: filing this buyer fails until the trigger is dropped.
  kit.sql(`create or replace function public.lead_01_fault() returns trigger language plpgsql as $$ begin if new.name = 'Faulty Buyer' then raise exception 'injected filing fault'; end if; return new; end $$;
    create trigger lead_01_fault before insert on public.prospects for each row execute function public.lead_01_fault();`)
  const delivered = await deliver(kit, org, { name: "Faulty Buyer", email, community: "CYP" })
  const afterInline = receipt(kit, delivered.body.receipt_id)
  // The stack cannot wait for the backoff: each queued retry is made due now.
  const dueNow = () => kit.sql(`update public.outbox set run_at=now() where org_id=${kit.q(org.orgId)} and job_type='file_lead_intake' and status='pending' and payload->>'receipt_id'=${kit.q(delivered.body.receipt_id)}`)
  dueNow(); await kit.drainOutbox(org.orgId)
  dueNow(); await kit.drainOutbox(org.orgId)
  const afterRetries = receipt(kit, delivered.body.receipt_id)
  const shown = (await attention(kit, org.team.sales)).rows.find((row) => row.receiptId === delivered.body.receipt_id)
  const superintendentDismisses = await permissionAttempt(() => kit.as(org.team.superintendent, () => app("lead-intake").dismissLeadReceipt({ receiptId: delivered.body.receipt_id, note: "Not a real lead" })))
  kit.sql("drop trigger lead_01_fault on public.prospects; drop function public.lead_01_fault();")
  const retried = await kit.as(org.team.sales, () => app("lead-intake").retryLeadReceipt(delivered.body.receipt_id))
  const observed = {
    response: [delivered.status, delivered.body.status],
    afterInline: { status: afterInline.status, attempts: afterInline.attempts, retryScheduled: afterInline.retry_scheduled },
    afterRetries: { status: afterRetries.status, failure: afterRetries.failure_code, attempts: afterRetries.attempts },
    shownAs: shown ? shown.kind : null,
    superintendentDismisses,
    retry: retried.status,
    deals: prospectsFor(kit, org, email).length,
  }
  check.equal("a filing fault leaves the delivery received with a retry scheduled, the outbox retries it, after the third attempt it fails visibly on the desk, a member without a deal write key cannot dismiss it, and the consultant's Retry files it exactly once", expected.expected, observed)
  return { orgId: org.orgId, receiptId: delivered.body.receipt_id }
}

// ---------------------------------------------------------------------------
// 6. Rotation.

async function secretRotationGrace(kit, expected, check) {
  const { org } = await world(kit)
  const oldSecret = org.secret
  const rotated = await kit.as(org.owner, () => app("lead-intake").rotateLeadSourceSecret(org.source.id))
  const oldDuringGrace = await deliver(kit, org, { name: "Grace One", email: "grace.one@lead-01.example.test", community: "CYP" }, { secret: oldSecret })
  // The 24-hour grace window ends (fixture: the stack cannot wait a day).
  kit.sql(`update public.lead_intake_sources set previous_secret_expires_at=now() - interval '1 second' where id=${kit.q(org.source.id)}`)
  const oldAfterGrace = await deliver(kit, org, { name: "Grace Two", email: "grace.two@lead-01.example.test", community: "CYP" }, { secret: oldSecret })
  const newSecret = await deliver(kit, org, { name: "Grace Three", email: "grace.three@lead-01.example.test", community: "CYP" }, { secret: rotated.secret })
  org.secret = rotated.secret
  const observed = {
    secretChanged: rotated.secret !== oldSecret,
    hintIsTheNewSecret: rotated.source.secretHint === rotated.secret.slice(-4),
    secretNotReadable: await attempt(() => kit.as(org.owner, async () => {
      const { supabase } = await context().requireOrgContext()
      const { error } = await supabase.from("lead_intake_sources").select("signing_secret_encrypted").eq("id", org.source.id)
      if (error) throw new Error("permission denied")
    })),
    oldDuringGrace: oldDuringGrace.status,
    oldAfterGrace: oldAfterGrace.status,
    newSecret: newSecret.status,
  }
  check.equal("after rotation the old secret files leads until its grace window ends and is refused after, the new one files, and no member can read a stored secret", expected.expected, observed)
  return { orgId: org.orgId }
}

// ---------------------------------------------------------------------------
// 7. The prospect permission hole is closed.

async function onlySalesCanTouchLeads(kit, expected, check) {
  const { org } = await world(kit)
  const prospects = app("prospects")
  const consultantCreates = await kit.as(org.team.sales, () => prospects.createProspect({ input: { name: "Desk Lead", community_id: org.communityId } }))
  const superintendentCreates = await permissionAttempt(() => kit.as(org.team.superintendent, () => prospects.createProspect({ input: { name: "Field Lead" } })))
  const superintendentReassigns = await permissionAttempt(() => kit.as(org.team.superintendent, () => prospects.updateProspect({ prospectId: consultantCreates.id, input: { owner_user_id: org.team.superintendent.userId } })))
  const superintendentDeletes = await permissionAttempt(() => kit.as(org.team.superintendent, () => prospects.deleteProspect({ prospectId: consultantCreates.id })))
  const directWrite = await kit.as(org.team.superintendent, async () => {
    const { supabase } = await context().requireOrgContext()
    const { error } = await supabase.from("prospects").insert({ org_id: org.orgId, name: "Direct write" })
    return error ? "refused" : "allowed"
  })
  const superintendentAssignsThemself = await kit.as(org.team.superintendent, async () => {
    const { supabase } = await context().requireOrgContext()
    const { error } = await supabase.from("community_assignments").insert({ org_id: org.orgId, community_id: org.communityId, user_id: org.team.superintendent.userId, role: "sales" })
    return error ? "refused" : "allowed"
  })
  const observed = {
    consultantCreates: Boolean(consultantCreates.id),
    superintendentCreates,
    superintendentReassigns,
    superintendentDeletes,
    directWrite,
    superintendentAssignsThemself,
    dealStillOwnedByConsultant: one(kit, `select owner_user_id from public.prospects where id=${kit.q(consultantCreates.id)}`).owner_user_id === org.team.sales.userId,
  }
  check.equal("only a holder of sales.manage or pipeline.write creates, reassigns or deletes a deal, through the service or directly, and nobody without community.write staffs a community", expected.expected, observed)
  return { orgId: org.orgId, prospectId: consultantCreates.id }
}

module.exports = {
  id: "LEAD-01",
  subcases: {
    "signed-lead-files-and-routes": signedLeadFilesAndRoutes,
    "duplicates-merge-and-keep-attribution": duplicatesMergeAndKeepAttribution,
    "routing-fallbacks-respect-divisions": routingFallbacksRespectDivisions,
    "bad-deliveries-are-visible-not-filed": badDeliveriesAreVisibleNotFiled,
    "transient-failure-retries-then-surfaces": transientFailureRetriesThenSurfaces,
    "secret-rotation-grace": secretRotationGrace,
    "only-sales-can-touch-leads": onlySalesCanTouchLeads,
  },
}
