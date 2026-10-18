"use strict"

/**
 * A land acquisition decision keeps the version it decided.
 *
 * The database freezes the deal, its diligence and its evidence into a review
 * with a content hash; approvers decide that hash and nothing else; the person
 * who submits can never approve; a change to what was frozen supersedes the
 * open version; and the deal, its checklist, its reviews and its documents sit
 * behind the same division wall and land permissions.
 */

const crypto = require("node:crypto")
const test = require("node:test")
const assert = require("node:assert/strict")

const { asRole, createDatabase, insert, rpc, seedMember } = require("./support/pglite")

async function member(db, orgId, role, { divisions } = {}) {
  const { userId } = await seedMember(db, { orgId, role })
  if (divisions) {
    const { rows } = await db.query(
      "update memberships set division_scope = 'assigned' where org_id = $1 and user_id = $2 returning id",
      [orgId, userId],
    )
    for (const divisionId of divisions) {
      await insert(db, "membership_divisions", { membership_id: rows[0].id, division_id: divisionId })
    }
  }
  return userId
}

/** An org with two divisions, a deal in North with a two-item checklist, and the people who work it. */
async function landOrg(t) {
  const db = await createDatabase(t)
  const { orgId, userId: ownerId } = await seedMember(db)
  const north = await insert(db, "divisions", { org_id: orgId, name: "North" })
  const south = await insert(db, "divisions", { org_id: orgId, name: "South" })
  const landManager = await member(db, orgId, "org_land_manager")
  const cfo = await member(db, orgId, "org_admin")
  const president = await member(db, orgId, "org_admin")
  const southManager = await member(db, orgId, "org_land_manager", { divisions: [south.id] })
  const superintendent = await member(db, orgId, "org_superintendent")
  const deal = await insert(db, "land_opportunities", {
    org_id: orgId,
    division_id: north.id,
    name: "Hawthorne 80",
    planned_lot_count: 120,
    purchase_price_cents: 6_000_000_00,
    deposit_cents: 250_000_00,
    diligence_ends_on: "2026-11-30",
    created_by: landManager,
  })
  const title = await insert(db, "land_diligence_items", {
    org_id: orgId, land_opportunity_id: deal.id, title: "Title commitment", category: "title", sort_order: 10,
  })
  const survey = await insert(db, "land_diligence_items", {
    org_id: orgId, land_opportunity_id: deal.id, title: "ALTA survey", category: "survey", sort_order: 20,
  })
  return { db, orgId, ownerId, north, south, landManager, cfo, president, southManager, superintendent, deal, title, survey }
}

const as = (db, userId, fn) => asRole(db, { role: "authenticated", userId }, fn)

function submit(db, userId, { orgId, dealId, approvers, decision = "acquire" }) {
  return rpc(
    db,
    "submit_land_acquisition_review",
    {
      p_org_id: orgId,
      p_opportunity_id: dealId,
      p_decision: decision,
      p_summary: "Go hard on Hawthorne",
      p_approvers: JSON.stringify(approvers.map((user_id, index) => ({ user_id, label: `Approver ${index + 1}` }))),
    },
    { role: "authenticated", userId },
  )
}

function decide(db, userId, { orgId, approvalId, decision, hash, reason = null }) {
  return rpc(
    db,
    "decide_land_acquisition_approval",
    { p_org_id: orgId, p_approval_id: approvalId, p_decision: decision, p_reason: reason, p_content_hash: hash },
    { role: "authenticated", userId },
  )
}

async function review(db, reviewId) {
  const { rows } = await db.query("select * from land_acquisition_reviews where id = $1", [reviewId])
  return rows[0]
}

async function approvalFor(db, reviewId, approverId) {
  const { rows } = await db.query("select * from land_acquisition_approvals where review_id = $1 and approver_id = $2", [reviewId, approverId])
  return rows[0]
}

test("a submitted review freezes the deal, its checklist and its evidence under a hash", async (t) => {
  const { db, orgId, landManager, cfo, deal, title } = await landOrg(t)
  const file = await insert(db, "files", {
    org_id: orgId, land_opportunity_id: deal.id, file_name: "commitment.pdf", storage_path: `${orgId}/general/land/c.pdf`, checksum: "abc123",
  })
  await insert(db, "file_links", {
    org_id: orgId, file_id: file.id, entity_type: "land_diligence_item", entity_id: title.id, land_opportunity_id: deal.id,
  })

  const reviewId = await submit(db, landManager, { orgId, dealId: deal.id, approvers: [cfo] })

  const frozen = await review(db, reviewId)
  assert.equal(frozen.revision, 1)
  assert.equal(frozen.status, "in_review")
  assert.equal(frozen.snapshot.terms.purchase_price_cents, 6_000_000_00)
  assert.deepEqual(frozen.snapshot.items.map((item) => item.title), ["Title commitment", "ALTA survey"])
  assert.deepEqual(frozen.snapshot.evidence.map((entry) => [entry.file_name, entry.checksum]), [["commitment.pdf", "abc123"]])
  const { rows } = await db.query("select snapshot::text as text from land_acquisition_reviews where id = $1", [reviewId])
  assert.equal(frozen.content_hash, crypto.createHash("sha256").update(rows[0].text).digest("hex"))
})

test("a review cannot be rewritten, by anyone", async (t) => {
  const { db, orgId, landManager, cfo, deal } = await landOrg(t)
  const reviewId = await submit(db, landManager, { orgId, dealId: deal.id, approvers: [cfo] })

  await assert.rejects(db.query("update land_acquisition_reviews set snapshot = '{}' where id = $1", [reviewId]), /cannot be changed/)
  await assert.rejects(db.query("update land_acquisition_reviews set content_hash = repeat('0', 64) where id = $1", [reviewId]), /cannot be changed/)
  await assert.rejects(
    as(db, landManager, (tx) => tx.query("update land_acquisition_reviews set status = 'approved' where id = $1", [reviewId])),
    /permission denied/,
  )
  await assert.rejects(
    as(db, cfo, (tx) => tx.query("update land_acquisition_approvals set decision = 'approved' where review_id = $1", [reviewId])),
    /permission denied/,
  )
  await assert.rejects(as(db, landManager, (tx) => tx.query("delete from land_opportunities where id = $1", [deal.id])), /permission denied/)
})

test("a deal has one open review at a time", async (t) => {
  const { db, orgId, landManager, cfo, deal } = await landOrg(t)
  await submit(db, landManager, { orgId, dealId: deal.id, approvers: [cfo] })

  await assert.rejects(submit(db, landManager, { orgId, dealId: deal.id, approvers: [cfo] }), /already has a review open/)
})

test("the person who submits a review can never approve it", async (t) => {
  const { db, orgId, ownerId, cfo, deal } = await landOrg(t)

  await assert.rejects(submit(db, ownerId, { orgId, dealId: deal.id, approvers: [ownerId, cfo] }), /cannot approve a review you submit/)

  const reviewId = await submit(db, ownerId, { orgId, dealId: deal.id, approvers: [cfo] })
  await assert.rejects(
    insert(db, "land_acquisition_approvals", { org_id: orgId, review_id: reviewId, step: 2, label: "Owner", approver_id: ownerId }),
    /cannot approve it/,
  )
})

test("only holders of land approval in the deal's division can be named or decide", async (t) => {
  const { db, orgId, landManager, cfo, superintendent, deal } = await landOrg(t)

  await assert.rejects(submit(db, landManager, { orgId, dealId: deal.id, approvers: [superintendent] }), /must hold land approval/)
  await assert.rejects(submit(db, superintendent, { orgId, dealId: deal.id, approvers: [cfo] }), /permission to submit/)

  const reviewId = await submit(db, landManager, { orgId, dealId: deal.id, approvers: [cfo] })
  const approval = await approvalFor(db, reviewId, cfo)
  const { content_hash: hash } = await review(db, reviewId)
  await assert.rejects(decide(db, landManager, { orgId, approvalId: approval.id, decision: "approved", hash }), /permission to approve/)
})

test("a decision on a version other than the one under review is refused", async (t) => {
  const { db, orgId, landManager, cfo, deal } = await landOrg(t)
  const reviewId = await submit(db, landManager, { orgId, dealId: deal.id, approvers: [cfo] })
  const approval = await approvalFor(db, reviewId, cfo)

  await assert.rejects(
    decide(db, cfo, { orgId, approvalId: approval.id, decision: "approved", hash: "f".repeat(64) }),
    /version you reviewed has changed/,
  )
  await assert.rejects(
    db.query("update land_acquisition_approvals set decision = 'approved', reviewed_hash = $2, decided_at = now() where id = $1", [approval.id, "e".repeat(64)]),
    /not the version under review/,
  )
  assert.equal((await approvalFor(db, reviewId, cfo)).decision, "pending")
})

test("changing the terms, an item or the evidence supersedes the open version", async (t) => {
  const { db, orgId, landManager, cfo, deal, title, survey } = await landOrg(t)

  const first = await submit(db, landManager, { orgId, dealId: deal.id, approvers: [cfo] })
  await as(db, landManager, (tx) => tx.query("update land_opportunities set notes = 'Seller is motivated' where id = $1", [deal.id]))
  assert.equal((await review(db, first)).status, "in_review", "a note is not a term")
  await as(db, landManager, (tx) => tx.query("update land_opportunities set purchase_price_cents = 5800000000 where id = $1", [deal.id]))
  assert.equal((await review(db, first)).status, "superseded")

  const second = await submit(db, landManager, { orgId, dealId: deal.id, approvers: [cfo] })
  assert.equal((await review(db, second)).revision, 2)
  await as(db, landManager, (tx) => tx.query("update land_diligence_items set sort_order = 99 where id = $1", [title.id]))
  assert.equal((await review(db, second)).status, "in_review", "reordering changes nothing an approver read")
  await as(db, landManager, (tx) =>
    tx.query("update land_diligence_items set status = 'issue', finding = 'Easement across lots 4-9', resolved_at = now() where id = $1", [survey.id]),
  )
  assert.equal((await review(db, second)).status, "superseded")

  const third = await submit(db, landManager, { orgId, dealId: deal.id, approvers: [cfo] })
  const file = await insert(db, "files", {
    org_id: orgId, land_opportunity_id: deal.id, file_name: "survey.pdf", storage_path: `${orgId}/general/land/s.pdf`,
  })
  await insert(db, "file_links", {
    org_id: orgId, file_id: file.id, entity_type: "land_diligence_item", entity_id: survey.id, land_opportunity_id: deal.id,
  })
  assert.equal((await review(db, third)).status, "superseded")
  const approval = await approvalFor(db, third, cfo)
  await assert.rejects(
    decide(db, cfo, { orgId, approvalId: approval.id, decision: "approved", hash: (await review(db, third)).content_hash }),
    /no longer open/,
  )
})

test("every named approver must approve, and one rejection returns the version", async (t) => {
  const { db, orgId, landManager, cfo, president, deal } = await landOrg(t)

  const approved = await submit(db, landManager, { orgId, dealId: deal.id, approvers: [cfo, president] })
  const { content_hash: hash } = await review(db, approved)
  const first = await decide(db, cfo, { orgId, approvalId: (await approvalFor(db, approved, cfo)).id, decision: "approved", hash })
  assert.equal(first.review_status, "in_review")
  await assert.rejects(
    decide(db, president, { orgId, approvalId: (await approvalFor(db, approved, cfo)).id, decision: "approved", hash }),
    /Only the named approver/,
  )
  const last = await decide(db, president, { orgId, approvalId: (await approvalFor(db, approved, president)).id, decision: "approved", hash })
  assert.equal(last.review_status, "approved")
  assert.equal((await review(db, approved)).status, "approved")
  assert.equal((await approvalFor(db, approved, president)).reviewed_hash, hash)
  await assert.rejects(
    db.query("update land_acquisition_approvals set reason = 'changed my mind on this' where review_id = $1 and approver_id = $2", [approved, cfo]),
    /already been decided/,
  )

  await as(db, landManager, (tx) => tx.query("update land_opportunities set deposit_cents = 300000000 where id = $1", [deal.id]))
  const returned = await submit(db, landManager, { orgId, dealId: deal.id, approvers: [cfo, president] })
  const returnedHash = (await review(db, returned)).content_hash
  await assert.rejects(
    decide(db, cfo, { orgId, approvalId: (await approvalFor(db, returned, cfo)).id, decision: "rejected", hash: returnedHash, reason: "short" }),
    /reject_reason_check/,
  )
  const outcome = await decide(db, cfo, {
    orgId, approvalId: (await approvalFor(db, returned, cfo)).id, decision: "rejected", hash: returnedHash, reason: "Price is above the land budget",
  })
  assert.equal(outcome.review_status, "rejected")
  assert.equal((await review(db, approved)).status, "approved", "an earlier decided version keeps its outcome")
})

test("an approved termination drops the deal", async (t) => {
  const { db, orgId, landManager, cfo, deal } = await landOrg(t)
  const reviewId = await submit(db, landManager, { orgId, dealId: deal.id, approvers: [cfo], decision: "terminate" })
  const { content_hash: hash } = await review(db, reviewId)

  await decide(db, cfo, { orgId, approvalId: (await approvalFor(db, reviewId, cfo)).id, decision: "approved", hash })

  const { rows } = await db.query("select dropped_at, dropped_reason from land_opportunities where id = $1", [deal.id])
  assert.ok(rows[0].dropped_at)
  assert.equal(rows[0].dropped_reason, "Terminated by acquisition review r1")
  await assert.rejects(submit(db, landManager, { orgId, dealId: deal.id, approvers: [cfo] }), /dropped land deal/)
})

test("a division-restricted member reaches neither another division's deal nor anything filed under it", async (t) => {
  const { db, orgId, landManager, cfo, southManager, deal, title } = await landOrg(t)
  const file = await insert(db, "files", {
    org_id: orgId, land_opportunity_id: deal.id, file_name: "phase-1-esa.pdf", storage_path: `${orgId}/general/land/esa.pdf`,
  })
  await insert(db, "file_links", {
    org_id: orgId, file_id: file.id, entity_type: "land_diligence_item", entity_id: title.id, land_opportunity_id: deal.id,
  })
  await submit(db, landManager, { orgId, dealId: deal.id, approvers: [cfo] })
  await insert(db, "search_documents", { org_id: orgId, entity_type: "land_opportunity", entity_id: deal.id, title: "Hawthorne 80" })

  const seen = await as(db, southManager, async (tx) => ({
    deals: (await tx.query("select id from land_opportunities")).rows.length,
    items: (await tx.query("select id from land_diligence_items")).rows.length,
    reviews: (await tx.query("select id from land_acquisition_reviews")).rows.length,
    approvals: (await tx.query("select id from land_acquisition_approvals")).rows.length,
    files: (await tx.query("select id from files where land_opportunity_id is not null")).rows.length,
    links: (await tx.query("select id from file_links where land_opportunity_id is not null")).rows.length,
    search: (await tx.query("select id from search_documents where entity_type = 'land_opportunity'")).rows.length,
  }))
  assert.deepEqual(seen, { deals: 0, items: 0, reviews: 0, approvals: 0, files: 0, links: 0, search: 0 })

  const unchanged = await as(db, southManager, (tx) =>
    tx.query("update land_diligence_items set title = 'Hijacked' where land_opportunity_id = $1", [deal.id]),
  )
  assert.equal(unchanged.affectedRows, 0)
  await assert.rejects(
    submit(db, southManager, { orgId, dealId: deal.id, approvers: [cfo] }),
    /Land deal not found/,
  )

  const northView = await as(db, landManager, async (tx) => ({
    deals: (await tx.query("select id from land_opportunities")).rows.length,
    files: (await tx.query("select id from files where land_opportunity_id is not null")).rows.length,
    search: (await tx.query("select division_id from search_documents where entity_type = 'land_opportunity'")).rows,
  }))
  assert.equal(northView.deals, 1)
  assert.equal(northView.files, 1)
  assert.equal(northView.search.length, 1)
})

test("land deals and their documents need land permissions, not just membership", async (t) => {
  const { db, orgId, superintendent, landManager, deal } = await landOrg(t)
  await insert(db, "files", {
    org_id: orgId, land_opportunity_id: deal.id, file_name: "loi.pdf", storage_path: `${orgId}/general/land/loi.pdf`,
  })

  const seen = await as(db, superintendent, async (tx) => ({
    deals: (await tx.query("select id from land_opportunities")).rows.length,
    items: (await tx.query("select id from land_diligence_items")).rows.length,
    files: (await tx.query("select id from files where land_opportunity_id is not null")).rows.length,
  }))
  assert.deepEqual(seen, { deals: 0, items: 0, files: 0 })
  await assert.rejects(
    as(db, superintendent, (tx) =>
      tx.query("insert into land_opportunities (org_id, name, created_by) values ($1, 'Shadow deal', $2)", [orgId, superintendent]),
    ),
    /row-level security/,
  )
  await assert.rejects(
    as(db, landManager, (tx) =>
      tx.query("insert into land_opportunities (org_id, name, created_by) values ($1, 'Someone else''s deal', $2)", [orgId, superintendent]),
    ),
    /row-level security/,
  )
})

test("evidence must be a document filed on the same deal as the item it supports", async (t) => {
  const { db, orgId, landManager, deal, title } = await landOrg(t)
  const other = await insert(db, "land_opportunities", { org_id: orgId, name: "Cedar Ridge", created_by: landManager })
  const otherFile = await insert(db, "files", {
    org_id: orgId, land_opportunity_id: other.id, file_name: "cedar.pdf", storage_path: `${orgId}/general/land/cedar.pdf`,
  })
  const looseFile = await insert(db, "files", { org_id: orgId, file_name: "loose.pdf", storage_path: `${orgId}/general/loose.pdf` })

  await assert.rejects(
    insert(db, "file_links", { org_id: orgId, file_id: otherFile.id, entity_type: "land_diligence_item", entity_id: title.id, land_opportunity_id: deal.id }),
    /same land deal/,
  )
  await assert.rejects(
    insert(db, "file_links", { org_id: orgId, file_id: looseFile.id, entity_type: "land_diligence_item", entity_id: title.id }),
    /must name its land deal/,
  )
})

test("a takedown links only to a deal for its own community", async (t) => {
  const { db, orgId, north, deal } = await landOrg(t)
  const hawthorne = await insert(db, "communities", { org_id: orgId, name: "Hawthorne", division_id: north.id })
  const elsewhere = await insert(db, "communities", { org_id: orgId, name: "Elsewhere", division_id: north.id })
  await db.query("update land_opportunities set community_id = $2 where id = $1", [deal.id, hawthorne.id])

  await insert(db, "lot_takedowns", { org_id: orgId, community_id: hawthorne.id, name: "Phase 1", land_opportunity_id: deal.id })
  await assert.rejects(
    insert(db, "lot_takedowns", { org_id: orgId, community_id: elsewhere.id, name: "Stray", land_opportunity_id: deal.id }),
    /not linked to this takedown's community/,
  )
})
