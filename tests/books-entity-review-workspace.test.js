require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  fs = require("node:fs"),
  Module = require("node:module");
const {
  setup,
  id,
  org,
  actor,
  reviewer,
  reader,
  entity,
  notes,
} = require("./fixtures/books-legacy-entity-database");
async function workspace(t) {
  const f = await setup(t);
  await f.db.exec(
    `alter table app_users add full_name text, add email text; alter table doc_versions add version_number integer default 1, add created_at timestamptz default now(); update app_users set full_name='Builder member',email='builder@example.test';`,
  );
  await f.db.exec(
    fs.readFileSync(
      "supabase/migrations/20261004185829_books_entity_review_workspace.sql",
      "utf8",
    ),
  );
  return f;
}
test("bounded proposal summaries retain every page and latest approval without transferring private populations", async (t) => {
  const f = await workspace(t);
  await f.prepare();
  await f.review();
  for (let n = 200; n < 226; n++) await f.prepare(id(n), id(30));
  const first = await f.rpc("list_books_legacy_entity_proposals", [
    org,
    entity,
    actor,
    null,
    25,
  ]);
  assert.equal(first.proposals.length, 25);
  assert.equal(first.latestReviewedProposalId, id(30));
  assert.equal(first.nextCursor, first.proposals.at(-1).id);
  const last = await f.rpc("list_books_legacy_entity_proposals", [
    org,
    entity,
    actor,
    first.nextCursor,
    25,
  ]);
  assert.equal(last.nextCursor, null);
  assert.equal(last.latestReviewedProposalId, id(30));
  assert.equal(
    new Set([...first.proposals, ...last.proposals].map((p) => p.id)).size,
    27,
  );
  assert.equal(JSON.stringify(first).includes("source_population"), false);
  assert.equal(
    JSON.stringify(first).includes("Original legal identity"),
    false,
  );
  await assert.rejects(
    f.rpc("list_books_legacy_entity_proposals", [org, entity, actor, null, 26]),
    /page size/,
  );
});
test("original-version and active-member pickers paginate, match literal searches, and reject cross-tenant or revoked access", async (t) => {
  const f = await workspace(t);
  await f.db.query(
    `insert into doc_versions(id,org_id,file_id,storage_path,checksum,size_bytes,file_name,mime_type,version_number) select ('88600000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,$1::uuid,$2::uuid,$1::text||'/evidence/original-'||n,repeat('a',64),10,case when n=300 then 'Literal%_original.pdf' else 'Evidence.pdf' end,'application/pdf',n from generate_series(300,325)n`,
    [org, id(90)],
  );
  const first = await f.rpc("list_books_entity_review_options", [
    org,
    entity,
    reader,
    "documents",
    "",
    null,
    25,
  ]);
  const last = await f.rpc("list_books_entity_review_options", [
    org,
    entity,
    reader,
    "documents",
    "",
    first.nextCursor,
    25,
  ]);
  assert.equal(
    new Set([...first.options, ...last.options].map((p) => p.id)).size,
    27,
  );
  assert.equal(last.nextCursor, null);
  assert.match(last.options[0].detail, /Version 324/);
  const literal = await f.rpc("list_books_entity_review_options", [
    org,
    entity,
    actor,
    "documents",
    "%_",
    null,
    25,
  ]);
  assert.deepEqual(
    literal.options.map((p) => p.id),
    [id(300)],
  );
  await f.db.exec(
    `insert into app_users select ('88600000-0000-4000-8000-'||lpad(n::text,12,'0'))::uuid,'Member '||n,'member'||n||'@example.test' from generate_series(400,425)n; insert into memberships select '${org}',id,'active' from app_users where id>='${id(400)}'; insert into app_users values('${id(500)}','Foreign secret','foreign@example.test'); insert into memberships values('${id(100)}','${id(500)}','active');`,
  );
  const people = await f.rpc("list_books_entity_review_options", [
    org,
    entity,
    actor,
    "people",
    "",
    null,
    25,
  ]);
  const more = await f.rpc("list_books_entity_review_options", [
    org,
    entity,
    actor,
    "people",
    "",
    people.nextCursor,
    25,
  ]);
  assert.equal(
    new Set([...people.options, ...more.options].map((p) => p.id)).size,
    29,
  );
  assert.equal(JSON.stringify(more).includes("Foreign secret"), false);
  await assert.rejects(
    f.rpc("list_books_entity_review_options", [
      org,
      entity,
      reader,
      "people",
      "",
      null,
      25,
    ]),
    /manager/,
  );
  await assert.rejects(
    f.rpc("list_books_entity_review_options", [
      id(100),
      entity,
      actor,
      "documents",
      "",
      null,
      25,
    ]),
    /access/,
  );
  await assert.rejects(
    f.rpc("list_books_entity_review_options", [
      org,
      entity,
      actor,
      "documents",
      "x".repeat(101),
      null,
      25,
    ]),
    /search/,
  );
  await f.rpc("set_books_legal_entity_member", [
    org,
    entity,
    actor,
    reader,
    "revoked",
    notes,
  ]);
  await assert.rejects(
    f.rpc("read_books_entity_setup_access", [org, entity, reader]),
    /read access/,
  );
});
test("review readers remain private invokers and setup capabilities reflect explicit entity roles", async (t) => {
  const f = await workspace(t);
  assert.deepEqual(
    await f.rpc("read_books_entity_setup_access", [org, entity, reader]),
    {
      orgId: org,
      entityId: entity,
      actorId: reader,
      prepare: false,
      review: false,
      manage: false,
    },
  );
  assert.equal(
    (await f.rpc("read_books_entity_setup_access", [org, entity, reviewer]))
      .review,
    true,
  );
  const rows = (
    await f.db.query(
      "select oid::regprocedure::text signature,prosecdef from pg_proc where proname in ('list_books_legacy_entity_proposals','list_books_entity_review_options','read_books_entity_setup_access')",
    )
  ).rows;
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.prosecdef, false);
    for (const role of ["anon", "authenticated"])
      assert.equal(
        (
          await f.db.query(
            "select has_function_privilege($1,$2,'execute') allowed",
            [role, row.signature],
          )
        ).rows[0].allowed,
        false,
      );
    assert.equal(
      (
        await f.db.query(
          "select has_function_privilege('service_role',$1,'execute') allowed",
          [row.signature],
        )
      ).rows[0].allowed,
      true,
    );
  }
});
test("service gates export populations separately from setup, validates RPC scope, and exposes only review summaries", async (t) => {
  const f = await workspace(t);
  await f.prepare();
  let denied = false,
    forged = false;
  const permissions = [],
    calls = [];
  const service = {
    rpc: async (name, args) => {
      calls.push(name);
      try {
        let data = await f.rpc(name, Object.values(args));
        if (forged) data = { ...data, orgId: id(999) };
        return { data, error: null };
      } catch (e) {
        return { data: null, error: { message: e.message } };
      }
    },
  };
  const filename =
      require.resolve("../lib/services/books/entity-review-workspace"),
    original = Module._load;
  let api;
  try {
    Module._load = function (name, ...args) {
      if (args[0]?.filename === filename && name === "./module")
        return {
          requireBooksWorkspaceEnabled: async () => ({
            orgId: org,
            userId: actor,
            supabase: service,
          }),
        };
      if (args[0]?.filename === filename && name === "./access")
        return {
          requireBooksAuthorization: async (input) => {
            permissions.push(input.permission);
            if (denied) throw Error("Books denied");
          },
        };
      if (
        args[0]?.filename === filename &&
        name === "./legacy-entity-ownership-service"
      )
        return { readBooksLegacyEntityProposal: async () => f.read() };
      if (name === "@/lib/supabase/server")
        return { createServiceSupabaseClient: () => service };
      return original.call(this, name, ...args);
    };
    delete require.cache[filename];
    api = require(filename);
  } finally {
    Module._load = original;
  }
  await api.getBooksEntitySetupAccess(entity);
  assert.deepEqual(permissions.splice(0), ["books.read"]);
  await api.listBooksEntityReviewOptions({ entityId: entity, kind: "people" });
  assert.deepEqual(permissions.splice(0), ["books.manage"]);
  await api.listBooksEntityProposals({ entityId: entity });
  assert.deepEqual(permissions.splice(0), ["books.read", "books.export"]);
  await api.listBooksEntityReviewOptions({
    entityId: entity,
    kind: "documents",
  });
  assert.deepEqual(permissions.splice(0), ["books.read", "books.export"]);
  const detail = await api.getBooksEntityProposalReview({
    entityId: entity,
    proposalId: id(30),
  });
  assert.equal(detail.approvedForLedgerActivation, false);
  assert.equal(detail.documents[0].name, "original.pdf");
  assert.equal("proposal" in detail, false);
  assert.equal(
    JSON.stringify(detail).includes("source_population_text"),
    false,
  );
  assert.ok(
    detail.populations.some(
      (row) => row.table === "doc_versions" && row.rows === 1,
    ),
  );
  forged = true;
  await assert.rejects(api.getBooksEntitySetupAccess(entity));
  forged = false;
  denied = true;
  const before = calls.length;
  await assert.rejects(
    api.listBooksEntityProposals({ entityId: entity }),
    /Books denied/,
  );
  assert.equal(calls.length, before);
});
