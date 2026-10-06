require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  Module = require("node:module");
const {
  setup,
  id,
  org,
  entity,
  maker,
  reviewer,
  notes,
  supportBytes,
} = require("./fixtures/books-project-owner-database");
async function harness(t) {
  const f = await setup(t),
    state = {
      user: maker,
      denied: null,
      bytes: supportBytes,
      calls: [],
      authorizationCalls: [],
      readOnly: false,
      afterStorage: null,
      storageError: false,
      forge: null,
    };
  const service = {
    rpc: async (name, args) => {
      state.calls.push(name);
      try {
        let data = await f.rpc(name, Object.values(args));
        data = state.forge ? state.forge(name, data) : data;
        return { data, error: null };
      } catch (e) {
        return { data: null, error: { message: e.message } };
      }
    },
    from: (table) => {
      assert.ok(["files", "doc_versions"].includes(table));
      const filters = [],
        sets = [],
        greater = [];
      let rowLimit = null,
        order = null,
        single = false;
      const q = {
        select() {
          return q;
        },
        order(k) {
          order = k;
          return q;
        },
        limit(n) {
          rowLimit = n;
          return q;
        },
        gt(k, v) {
          greater.push([k, v]);
          return q;
        },
        maybeSingle() {
          single = true;
          return q;
        },
        eq(k, v) {
          filters.push([k, v]);
          return q;
        },
        in(k, values) {
          sets.push([k, values]);
          return q;
        },
        then(resolve, reject) {
          state.calls.push(table === "files" ? "files" : "documents");
          const args = [],
            where = [];
          for (const [k, v] of filters) {
            args.push(v);
            where.push(`${k}=$${args.length}`);
          }
          for (const [k, v] of greater) {
            args.push(v);
            where.push(`${k}>$${args.length}`);
          }
          for (const [k, vs] of sets) {
            const slots = vs.map((v) => {
              args.push(v);
              return "$" + args.length;
            });
            where.push(`${k} in (${slots.join(",")})`);
          }
          return f.db
            .query(
              "select * from " +
                table +
                " where " +
                where.join(" and ") +
                (order ? ` order by ${order}` : "") +
                (rowLimit ? ` limit ${rowLimit}` : ""),
              args,
            )
            .then(
              (r) =>
                resolve({
                  data: JSON.parse(
                    JSON.stringify(single ? (r.rows[0] ?? null) : r.rows),
                  ),
                  error: null,
                }),
              reject,
            );
        },
      };
      return q;
    },
  };
  const path =
      require.resolve("../lib/services/books/project-entity-ownership"),
    original = Module._load;
  let api;
  try {
    Module._load = function (name, ...args) {
      if (name === "./module" && args[0]?.filename === path)
        return {
          requireBooksWorkspaceEnabled: async () => {
            state.calls.push("workspace");
            if (state.denied === "workspace") throw Error("Disabled");
            return { orgId: org, userId: state.user, supabase: service };
          },
        };
      if (name === "./access" && args[0]?.filename === path)
        return {
          requireBooksAuthorization: async (input) => {
            state.calls.push(input.permission);
            if (input.resourceType === "legal_entity")
              assert.equal(input.resourceId, entity);
            else assert.match(input.resourceId, /^[a-f0-9-]{36}$/);
            if (state.denied === "books") throw Error("Books denied");
          },
        };
      if (name === "@/lib/services/authorization")
        return {
          authorize: async () => ({
            allowed: !state.readOnly,
            divisionScope: "all",
          }),
          requireAuthorization: async (input) => {
            state.calls.push(input.permission);
            state.authorizationCalls.push({
              permission: input.permission,
              projectId: input.projectId,
              resourceId: input.resourceId,
            });
            if (input.resourceType === "project")
              assert.equal(input.projectId, input.resourceId);
            assert.equal(input.orgId, org);
            if (state.denied === "project") throw Error("Project denied");
            if (
              state.denied === "documents" &&
              input.permission === "docs.read"
            )
              throw Error("Document denied");
          },
        };
      if (name === "@/lib/supabase/server")
        return { createServiceSupabaseClient: () => service };
      if (name === "@/lib/storage/files-storage")
        return {
          getFilesObjectStream: async (input) => {
            state.calls.push("storage");
            assert.equal(input.orgId, org);
            assert.equal(input.path, org + "/ownership-original.pdf");
            if (state.storageError) throw Error("PRIVATE provider diagnostics");
            await state.afterStorage?.();
            return {
              body: new ReadableStream({
                start(c) {
                  c.enqueue(state.bytes.subarray(0, 7));
                  c.enqueue(state.bytes.subarray(7));
                  c.close();
                },
              }),
            };
          },
        };
      return original.call(this, name, ...args);
    };
    delete require.cache[path];
    delete require.cache[
      require.resolve("../lib/services/books/tax-attachments")
    ];
    api = require(path);
  } finally {
    Module._load = original;
  }
  const prep = (change = {}) =>
    api.prepareBooksProjectEntity({
      expectedOrgId: org,
      expectedActorId: state.user,
      id: id(90),
      entityId: entity,
      projectId: id(70),
      profileId: id(20),
      effectiveOn: "2026-01-01",
      evidence: f.decision,
      notes,
      ...change,
    });
  const review = (change = {}) =>
    api.reviewBooksProjectEntity({
      expectedOrgId: org,
      expectedActorId: state.user,
      id: id(91),
      entityId: entity,
      projectId: id(70),
      proposalId: id(90),
      notes,
      ...change,
    });
  const read = (change = {}) =>
    api.readBooksProjectEntityProposal({
      entityId: entity,
      projectId: id(70),
      proposalId: id(90),
      ...change,
    });
  return {
    ...f,
    state,
    prep,
    review,
    read,
    api,
    workspace: (change = {}) =>
      api.getBooksProjectOwnerWorkspace({ projectId: id(70), ...change }),
  };
}
test("workspace, Books, project and live entity boundaries reject before loading documents or streaming bytes", async (t) => {
  const f = await harness(t);
  await assert.rejects(f.prep({ projectId: "invalid" }));
  assert.deepEqual(f.state.calls, []);
  for (const denied of ["workspace", "books", "project"]) {
    f.state.calls = [];
    f.state.denied = denied;
    await assert.rejects(f.prep());
    assert.ok(!f.state.calls.includes("documents"));
    assert.ok(!f.state.calls.includes("storage"));
    assert.ok(!f.state.calls.includes("prepare_books_project_entity"));
  }
  f.state.denied = null;
  f.state.calls = [];
  await assert.rejects(
    f.prep({ projectId: id(72) }),
    /unavailable in organization/,
  );
  assert.ok(!f.state.calls.includes("documents"));
  await f.db.query(
    "update memberships set status='inactive' where org_id=$1 and user_id=$2",
    [org, maker],
  );
  await assert.rejects(f.prep(), /operation access/);
  assert.ok(!f.state.calls.includes("storage"));
});
test("original bytes precede actual prepare/review and committed exact retries survive later metadata or object changes", async (t) => {
  const f = await harness(t);
  const p = await f.prep();
  assert.equal(p.ledgerActivated, false);
  assert.equal(p.proposal.project_id, id(70));
  assert.ok(
    f.state.calls.indexOf("project.manage") <
      f.state.calls.indexOf("documents"),
  );
  assert.ok(
    f.state.calls.indexOf("storage") <
      f.state.calls.indexOf("prepare_books_project_entity"),
  );
  await assert.rejects(f.review(), /operation access|separate reviewer/);
  f.state.user = reviewer;
  f.state.calls = [];
  const r = await f.review();
  assert.equal(r.sourceOwnerEstablished, true);
  assert.equal(r.ledgerActivated, false);
  assert.ok(
    f.state.calls.indexOf("storage") <
      f.state.calls.indexOf("review_books_project_entity"),
  );
  await f.db.exec("update doc_versions set checksum=repeat('a',64)");
  f.state.bytes = Buffer.from("Changed original bytes");
  f.state.calls = [];
  assert.deepEqual(await f.review(), r);
  assert.ok(!f.state.calls.includes("storage"));
  f.state.user = maker;
  assert.deepEqual(await f.prep(), p);
  assert.ok(!f.state.calls.includes("storage"));
  await assert.rejects(
    f.prep({ notes: "Changed original request rationale" }),
    /retry differs/,
  );
  f.state.user = reviewer;
  await assert.rejects(f.review({ id: id(95) }), /retry differs/);
  assert.equal((await f.read()).proposal.id, p.proposal.id);
});
test("missing versions, corrupt bytes, changed prepared metadata and access revoked during byte verification cannot establish an owner", async (t) => {
  const f = await harness(t);
  f.state.bytes = Buffer.from("bad");
  await assert.rejects(f.prep(), /bytes differ/);
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_project_entity_proposals",
      )
    ).rows[0].n,
    0,
  );
  f.state.bytes = supportBytes;
  await assert.rejects(
    f.prep({ evidence: { ...f.decision, document_version_ids: [id(99)] } }),
    /unavailable/,
  );
  await f.prep();
  f.state.user = reviewer;
  await f.db.exec("update doc_versions set checksum=repeat('b',64)");
  f.state.calls = [];
  await assert.rejects(f.review(), /metadata changed/);
  assert.ok(!f.state.calls.includes("storage"));
  await f.db.query("update doc_versions set checksum=$1", [
    require("node:crypto")
      .createHash("sha256")
      .update(supportBytes)
      .digest("hex"),
  ]);
  f.state.afterStorage = () =>
    f.rpc("set_books_legal_entity_member", [
      org,
      entity,
      maker,
      reviewer,
      "revoked",
      notes,
    ]);
  await assert.rejects(f.review(), /review access/);
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_project_entity_reviews",
      )
    ).rows[0].n,
    0,
  );
});
test("forged scoped details and preparation/review receipts reject without accepting an invented assignment", async (t) => {
  const f = await harness(t);
  f.state.forge = (name, data) =>
    name === "read_books_project_entity_proposal"
      ? { ...data, projectId: id(71) }
      : data;
  await assert.rejects(f.prep(), /request scope/);
  assert.ok(!f.state.calls.includes("storage"));
  f.state.forge = (name, data) =>
    name === "prepare_books_project_entity"
      ? { ...data, proposal: { ...data.proposal, profile_id: id(99) } }
      : data;
  await assert.rejects(f.prep(), /receipt differs/);
  f.state.forge = null;
  f.state.user = reviewer;
  f.state.forge = (name, data) =>
    name === "review_books_project_entity"
      ? { ...data, review: { ...data.review, project_id: id(71) } }
      : data;
  await assert.rejects(f.review(), /receipt differs/);
  f.state.forge = null;
  assert.equal((await f.read()).review.project_id, id(70));
});

test("supporting documents require their actual project permission before privileged storage reads", async (t) => {
  const f = await harness(t);
  f.state.denied = "documents";
  await assert.rejects(f.prep(), /Document denied/);
  assert.ok(!f.state.calls.includes("storage"));
  assert.equal(
    (
      await f.db.query(
        "select count(*)::int n from books_project_entity_proposals",
      )
    ).rows[0].n,
    0,
  );
  f.state.denied = null;
  await f.db.query("update files set project_id=$1", [id(71)]);
  await f.prep();
  assert.ok(f.state.calls.includes("docs.read"));
  assert.ok(
    f.state.authorizationCalls.some(
      (c) =>
        c.permission === "docs.read" &&
        c.projectId === id(71) &&
        c.resourceId === id(80),
    ),
  );
});

test("invalid accounting dates and inaccessible supporting files fail before original bytes or writes", async (t) => {
  const f = await harness(t);
  await assert.rejects(f.prep({ effectiveOn: "2026-02-30" }));
  assert.deepEqual(f.state.calls, []);
  await f.db.exec("delete from files");
  await assert.rejects(f.prep(), /supporting file is unavailable/);
  assert.ok(!f.state.calls.includes("storage"));
  assert.ok(!f.state.calls.includes("prepare_books_project_entity"));
});

test("storage failures cannot write ownership or expose private provider diagnostics", async (t) => {
  const f = await harness(t);
  f.state.storageError = true;
  await assert.rejects(
    f.prep(),
    (e) =>
      e.message ===
      "Original project ownership document could not be read or verified",
  );
  assert.ok(!f.state.calls.includes("prepare_books_project_entity"));
  f.state.storageError = false;
  const p = await f.prep();
  assert.equal(p.proposal.id, id(90));
});

test("project workspace lists only scoped proposals with stable cursors and retains approved owner independently of selected proposal page", async (t) => {
  const f = await harness(t);
  for (let n = 1000; n < 1028; n++) await f.prepare({ id: id(n) });
  const first = await f.workspace({ entityId: entity });
  assert.equal(first.proposals.length, 25);
  assert.equal(first.nextProposalCursor, id(1024));
  assert.equal(first.ledgerActivated, false);
  assert.equal(first.entities[0].legal_name, "Builder LLC");
  const next = await f.workspace({
    entityId: entity,
    afterProposal: first.nextProposalCursor,
  });
  assert.equal(next.proposals.length, 3);
  assert.equal(next.nextProposalCursor, null);
  assert.ok(next.proposals.every((p) => p.id > first.nextProposalCursor));
  f.state.user = reviewer;
  await f.review({ proposalId: id(1000), id: id(2000) });
  const owned = await f.workspace({
    entityId: entity,
    afterProposal: id(1024),
  });
  assert.equal(owned.owner.proposal.id, id(1000));
  assert.equal(owned.hasReviewedOwner, true);
  assert.equal(owned.owner.review.id, id(2000));
  await assert.rejects(
    f.workspace({ afterProposal: id(1000) }),
    /Proposal cursor/,
  );
  await assert.rejects(
    f.workspace({ projectId: id(72) }),
    /unavailable in organization/,
  );
});
test("revoked entity readers retain only assignment presence and cannot retrieve owner evidence; workspace rejects forged scope/cursors", async (t) => {
  const f = await harness(t);
  await f.prep();
  f.state.user = reviewer;
  await f.review();
  await f.rpc("set_books_legal_entity_member", [
    org,
    entity,
    maker,
    reviewer,
    "revoked",
    notes,
  ]);
  const hidden = await f.workspace();
  assert.equal(hidden.hasReviewedOwner, true);
  assert.equal(hidden.owner, null);
  assert.deepEqual(hidden.entities, []);
  await assert.rejects(f.workspace({ entityId: entity }), /entity read access/);
  f.state.user = maker;
  f.state.forge = (name, r) =>
    name === "read_books_project_owner_workspace"
      ? { ...r, projectId: id(71) }
      : r;
  await assert.rejects(f.workspace(), /request scope/);
  f.state.forge = (name, r) =>
    name === "read_books_project_owner_workspace"
      ? { ...r, nextEntityCursor: id(999) }
      : r;
  await assert.rejects(f.workspace(), /cursor differs/);
});

test("entity choices page independently from project proposals without duplicate or foreign scope rows", async (t) => {
  const f = await harness(t);
  for (let n = 3100; n < 3127; n++) await f.create(id(n), id(n + 1000));
  const a = await f.workspace();
  assert.equal(a.entities.length, 25);
  assert.equal(a.nextEntityCursor, id(3123));
  const b = await f.workspace({ afterEntity: a.nextEntityCursor });
  assert.equal(b.entities.length, 3);
  assert.equal(b.nextEntityCursor, null);
  assert.ok(
    b.entities.every((e) => e.org_id === org && e.id > a.nextEntityCursor),
  );
  assert.deepEqual(b.proposals, []);
  assert.equal(b.canPrepare, false);
  assert.equal(b.canReview, false);
});

test("read-only workspace viewers do not receive preparation/review capabilities from entity grants alone", async (t) => {
  const f = await harness(t);
  f.state.readOnly = true;
  const r = await f.workspace({ entityId: entity });
  assert.equal(r.canPrepare, false);
  assert.equal(r.canReview, false);
  assert.ok(r.entities.every((e) => !e.can_prepare && !e.can_review));
  assert.equal(r.entities.length, 1);
});

test("original choices use live file permissions without requiring unrelated export authority", async (t) => {
  const f = await harness(t);
  const r = await f.api.listBooksProjectOwnerDocuments({
    projectId: id(70),
    entityId: entity,
  });
  assert.equal(r.options.length, 1);
  assert.equal(r.options[0].id, id(81));
  assert.equal(r.nextCursor, null);
  f.state.readOnly = true;
  assert.deepEqual(
    (
      await f.api.listBooksProjectOwnerDocuments({
        projectId: id(70),
        entityId: entity,
      })
    ).options,
    [],
  );
});
test("original download delivers frozen verified bytes after current-version metadata changes and rechecks entity authority", async (t) => {
  const f = await harness(t);
  await f.prep();
  await f.db.exec(
    "update doc_versions set storage_path='different',checksum=repeat('b',64)",
  );
  const r = await f.api.downloadBooksProjectOwnerOriginal({
    projectId: id(70),
    entityId: entity,
    proposalId: id(90),
    versionId: id(81),
  });
  assert.deepEqual(
    Buffer.from(await new Response(r.body).arrayBuffer()),
    supportBytes,
  );
  await assert.rejects(
    f.api.downloadBooksProjectOwnerOriginal({
      projectId: id(70),
      entityId: entity,
      proposalId: id(90),
      versionId: id(99),
    }),
    /unavailable/,
  );
});
test("saved expected actor and organization must match the authenticated mutation context", async (t) => {
  const f = await harness(t);
  await assert.rejects(
    f.prep({ expectedOrgId: id(9) }),
    /another organization or actor/,
  );
  await assert.rejects(
    f.prep({ expectedActorId: reviewer }),
    /another organization or actor/,
  );
  assert.ok(!f.state.calls.includes("storage"));
  assert.ok(!f.state.calls.includes("prepare_books_project_entity"));
});
test("original download route serves verified bytes privately and returns safe errors for unknown evidence", async (t) => {
  const f = await harness(t);
  await f.prep();
  const path =
    require.resolve("../app/api/books/projects/[projectId]/entities/[entityId]/proposals/[proposalId]/originals/[versionId]/route");
  delete require.cache[path];
  const { GET } = require(path);
  const args = {
      projectId: id(70),
      entityId: entity,
      proposalId: id(90),
      versionId: id(81),
    },
    r = await GET(new Request("https://arc.test/original"), {
      params: Promise.resolve(args),
    });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), supportBytes);
  const bad = await GET(new Request("https://arc.test/original"), {
    params: Promise.resolve({ ...args, versionId: id(99) }),
  });
  assert.equal(bad.status, 404);
  assert.deepEqual(await bad.json(), {
    error: "Original supporting document is unavailable",
  });
});

function resolutionRequest(f, v = {}) {
  return {
    version: 1,
    kind: "prepare",
    request: {
      expectedOrgId: org,
      expectedActorId: maker,
      entityId: entity,
      projectId: id(70),
      id: id(90),
      profileId: id(20),
      effectiveOn: "2026-01-01",
      evidence: f.decision,
      notes,
      ...v,
    },
    resolution: {
      id: id(500),
      reason: "Unusable original evidence requires a retained resolution",
    },
  };
}
test("ownership resolution enforces actor, Books/project and live entity permissions before private SQL, without reading broken documents", async (t) => {
  const f = await harness(t),
    input = resolutionRequest(f);
  await assert.rejects(
    f.api.resolveBooksProjectOwnerRequest(
      resolutionRequest(f, { expectedActorId: reviewer }),
    ),
    /another organization or actor/,
  );
  assert.ok(
    !f.state.calls.some((c) => c.startsWith("resolve_") || c === "storage"),
  );
  for (const denied of ["workspace", "books", "project"]) {
    f.state.calls = [];
    f.state.denied = denied;
    await assert.rejects(f.api.resolveBooksProjectOwnerRequest(input));
    assert.ok(
      !f.state.calls.some((c) => c.startsWith("resolve_") || c === "storage"),
    );
  }
  f.state.calls = [];
  f.state.denied = null;
  f.state.storageError = true;
  const r = await f.api.resolveBooksProjectOwnerRequest(input);
  assert.equal(r.outcome, "cancelled");
  assert.deepEqual(f.state.calls, [
    "workspace",
    "books.manage",
    "project.manage",
    "resolve_books_project_owner_request",
  ]);
  await f.db.exec(
    `update memberships set status='revoked' where user_id='${maker}'`,
  );
  await assert.rejects(
    f.api.resolveBooksProjectOwnerRequest(input),
    /access|membership/,
  );
});
test("ownership resolution service rejects forged cancellation digest, foreign scope and changed reason", async (t) => {
  const f = await harness(t),
    input = resolutionRequest(f);
  for (const field of ["request_sha256", "actor_id", "reason"]) {
    f.state.forge = (name, data) =>
      name === "resolve_books_project_owner_request"
        ? {
            ...data,
            resolution: {
              ...data.resolution,
              [field]:
                field === "request_sha256"
                  ? "f".repeat(64)
                  : field === "actor_id"
                    ? reviewer
                    : "Changed original resolution reason",
            },
          }
        : data;
    await assert.rejects(
      f.api.resolveBooksProjectOwnerRequest(input),
      /differs/,
    );
  }
  f.state.forge = null;
  assert.equal(
    (await f.api.resolveBooksProjectOwnerRequest(input)).outcome,
    "cancelled",
  );
});
