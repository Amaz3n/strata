require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  { createHash } = require("node:crypto");
const {
  setup,
  id,
  org,
  entity,
  maker,
  reviewer,
  notes,
} = require("./fixtures/books-project-owner-database");
const {
  verifyProjectOwnerResolutionArchive,
  PROJECT_OWNER_RESOLUTION_TABLE,
} = require("../lib/services/books/project-owner-resolution-archive");
function request(f, kind = "prepare", v = {}) {
  return {
    expectedOrgId: org,
    expectedActorId: kind === "prepare" ? maker : reviewer,
    entityId: entity,
    projectId: id(70),
    id: kind === "prepare" ? id(90) : id(91),
    notes,
    ...(kind === "prepare"
      ? { profileId: id(20), effectiveOn: "2026-01-01", evidence: f.decision }
      : { proposalId: id(90) }),
    ...v,
  };
}
function resolve(f, kind = "prepare", r = request(f, kind), v = {}) {
  return f.rpc("resolve_books_project_owner_request", [
    v.org ?? org,
    v.entity ?? entity,
    v.project ?? id(70),
    v.actor ?? (kind === "prepare" ? maker : reviewer),
    v.id ?? id(500),
    kind,
    JSON.stringify(r),
    v.reason ?? "Original request cannot succeed; retain a cancellation fence",
  ]);
}
test("absent preparation cancellation is immutable and fences late RPC and direct insert; a new nonce can proceed", async (t) => {
  const f = await setup(t),
    r = await resolve(f);
  assert.equal(r.outcome, "cancelled");
  assert.equal(r.ledgerActivated, false);
  assert.equal(
    r.resolution.request_sha256,
    createHash("sha256").update(r.resolution.request_text).digest("hex"),
  );
  assert.deepEqual(await resolve(f), r);
  await assert.rejects(f.prepare(), /cancelled/);
  await assert.rejects(
    f.db.query(
      `insert into books_project_entity_proposals(id,org_id,project_id,legal_entity_id,profile_id,effective_on,project_name,decision_evidence,documents,prepared_by,prepared_at,prepared_access_event_id,preparation_notes) values($1,$2,$3,$4,$5,'2026-01-01','pending',$6,'[]',$7,now(),$1,$8)`,
      [
        id(90),
        org,
        id(70),
        entity,
        id(20),
        JSON.stringify(f.decision),
        maker,
        notes,
      ],
    ),
    /cancelled/,
  );
  await assert.rejects(
    f.db.exec("delete from books_project_owner_request_resolutions"),
    /immutable/,
  );
  await assert.rejects(
    f.db.exec(
      "update books_project_owner_request_resolutions set reason='Changed original explanation'",
    ),
    /immutable/,
  );
  await f.prepare({ id: id(92) });
  await f.review({ proposal: id(92) });
});
test("resolution recovers exact committed preparation and review without canceling or rewriting ownership", async (t) => {
  const f = await setup(t),
    p = await f.prepare(),
    r = await f.review();
  const prep = await resolve(f);
  assert.equal(prep.outcome, "committed_original");
  assert.deepEqual(prep.proposal, p.proposal);
  assert.equal(prep.resolution, null);
  const review = await resolve(f, "review");
  assert.equal(review.outcome, "committed_original");
  assert.deepEqual(review.review, r.review);
  assert.equal(review.resolution, null);
  await assert.rejects(
    resolve(f, "prepare", request(f, "prepare", { notes: notes + " changed" })),
    /differs/,
  );
  await assert.rejects(
    resolve(f, "review", request(f, "review", { proposalId: id(999) })),
    /differs/,
  );
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_project_owner_request_resolutions",
      )
    ).rows[0].n,
    0,
  );
  assert.deepEqual(await f.review(), r);
});
test("failed or self review cancellation retains observed target; a different existing owner cannot be undone", async (t) => {
  const f = await setup(t);
  await f.prepare();
  const self = request(f, "review", { expectedActorId: maker, id: id(94) });
  const selfResolution = await resolve(f, "review", self, {
    actor: maker,
    id: id(502),
  });
  assert.equal(selfResolution.outcome, "cancelled");
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_project_entity_reviews",
      )
    ).rows[0].n,
    0,
  );
  const r = await resolve(f, "review");
  assert.equal(r.resolution.observed_proposal_id, id(90));
  await assert.rejects(f.review(), /cancelled/);
  await f.review({ id: id(93) });
  assert.deepEqual(await resolve(f, "review"), r);
  assert.equal(
    (await f.db.query("select id from books_project_entity_reviews")).rows[0]
      .id,
    id(93),
  );
});
test("cancellation tolerates unavailable originals and missing targets but rejects malformed/foreign requests and altered retries", async (t) => {
  const f = await setup(t);
  const malformed = [
    { extra: true },
    { expectedActorId: reviewer },
    { entityId: id(999) },
    { projectId: id(72) },
    { expectedOrgId: id(9) },
    { id: null },
    { notes: "short" },
    { effectiveOn: "2026-02-30" },
    { evidence: { ...f.decision, document_version_ids: [id(81), id(81)] } },
  ];
  for (const v of malformed)
    await assert.rejects(resolve(f, "prepare", request(f, "prepare", v)));
  const r = request(f, "prepare", {
    profileId: id(999),
    evidence: { ...f.decision, document_version_ids: [id(999)] },
  });
  await resolve(f, "prepare", r);
  await assert.rejects(
    resolve(f, "prepare", r, { id: id(501) }),
    /retry differs/,
  );
  await assert.rejects(
    resolve(f, "prepare", r, { reason: "Changed resolution explanation" }),
    /retry differs/,
  );
  await assert.rejects(resolve(f, "prepare", request(f)), /retry differs/);
  await assert.rejects(
    resolve(f, "review", request(f, "review"), { id: id(500) }),
    /identity already used/,
  );
  const missing = await resolve(
    f,
    "review",
    request(f, "review", { proposalId: id(999) }),
    { id: id(501) },
  );
  assert.equal(missing.resolution.observed_proposal_id, null);
  await f.db.exec(
    `update memberships set status='revoked' where user_id='${maker}'`,
  );
  await assert.rejects(resolve(f, "prepare", r), /access|membership/);
});
async function tables(f) {
  const out = {};
  for (const name of [
    "books_legal_entities",
    "books_legal_entity_access_history",
    "books_project_entity_proposals",
    "books_project_entity_reviews",
    PROJECT_OWNER_RESOLUTION_TABLE,
    "projects",
  ])
    out[name] = (
      await f.db.query(
        `select to_jsonb(r) row from ${name} r where org_id=$1`,
        [org],
      )
    ).rows.map((r) => r.row);
  return out;
}
test("schema24 cancellation capture rejects rehashed provenance corruption, coexistence, downgrade and missing rows", async (t) => {
  const f = await setup(t);
  await f.prepare();
  await resolve(f, "review");
  const archive = await tables(f),
    captured = await f.rpc("capture_books_export_snapshot", [org]);
  assert.deepEqual(
    captured.tables[PROJECT_OWNER_RESOLUTION_TABLE],
    archive[PROJECT_OWNER_RESOLUTION_TABLE],
  );
  assert.deepEqual(verifyProjectOwnerResolutionArchive(archive, org, 24), []);
  assert.ok(verifyProjectOwnerResolutionArchive(archive, org, 23).length);
  for (const change of [
    (r) => (r.actor_id = maker),
    (r) => (r.project_id = id(999)),
    (r) => (r.resolved_access_event_id = id(999)),
    (r) => (r.observed_proposal_id = null),
    (r) => (r.request_id = id(999)),
    (r) => (r.resolved_at = "1900-01-01T00:00:00Z"),
    (r) =>
      (r.request_text = JSON.stringify({
        ...JSON.parse(r.request_text),
        expectedActorId: maker,
      })),
  ]) {
    const bad = structuredClone(archive),
      r = bad[PROJECT_OWNER_RESOLUTION_TABLE][0];
    change(r);
    r.request_sha256 = createHash("sha256")
      .update(r.request_text)
      .digest("hex");
    assert.ok(verifyProjectOwnerResolutionArchive(bad, org, 24).length);
  }
  const bad = structuredClone(archive);
  bad.books_project_entity_reviews.push({ id: id(91) });
  assert.ok(verifyProjectOwnerResolutionArchive(bad, org, 24).length);
  const missing = structuredClone(archive);
  delete missing[PROJECT_OWNER_RESOLUTION_TABLE];
  assert.ok(verifyProjectOwnerResolutionArchive(missing, org, 24).length);
});
test("restored cancellation alone reconstructs nonce fences and preserves original retry receipt", async (t) => {
  const source = await setup(t),
    cancel = await resolve(source),
    target = await setup(t),
    row = cancel.resolution,
    cols = Object.keys(row);
  await target.db.exec("begin;set local session_replication_role=replica");
  await target.db.query(
    `insert into books_project_owner_request_resolutions (${cols.join(",")}) values (${cols.map((_, i) => "$" + (i + 1)).join(",")})`,
    cols.map((c) => row[c]),
  );
  await target.db.exec("set local session_replication_role=origin;commit");
  assert.equal(
    (
      await target.db.query(
        "select count(*)::int n from books_project_owner_request_fences",
      )
    ).rows[0].n,
    0,
  );
  await assert.rejects(target.prepare(), /cancelled/);
  assert.deepEqual(await resolve(target), cancel);
  await target.prepare({ id: id(92) });
  await target.review({ proposal: id(92) });
});
