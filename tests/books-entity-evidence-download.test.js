require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  Module = require("node:module"),
  fs = require("node:fs/promises"),
  os = require("node:os");
const {
  setup,
  id,
  org,
  actor,
  reader,
  entity,
  notes,
} = require("./fixtures/books-legacy-entity-database");
async function harness(t) {
  const f = await setup(t);
  await f.db.query("update doc_versions set file_name=$1", [
    'Original "formation"\r\n.pdf',
  ]);
  await f.prepare();
  const state = {
    user: actor,
    denied: false,
    bytes: f.bytes,
    storageError: false,
    afterStorage: null,
    calls: [],
    forged: false,
  };
  const filename =
    require.resolve("../lib/services/books/entity-evidence-download");
  const service = {
    rpc: async (name, args) => {
      state.calls.push(name);
      try {
        return { data: await f.rpc(name, Object.values(args)), error: null };
      } catch (e) {
        return { data: null, error: { message: e.message } };
      }
    },
  };
  const original = Module._load;
  let download, GET;
  try {
    Module._load = function (name, ...args) {
      if (name === "./module" && args[0]?.filename === filename)
        return {
          requireBooksWorkspaceEnabled: async () => ({
            orgId: org,
            userId: state.user,
            supabase: service,
          }),
        };
      if (name === "./access" && args[0]?.filename === filename)
        return {
          requireBooksAuthorization: async (input) => {
            state.calls.push(input.permission);
            if (state.denied) throw Error("Denied");
          },
        };
      if (
        name === "./legacy-entity-ownership-service" &&
        args[0]?.filename === filename
      )
        return {
          readBooksLegacyEntityProposal: async () => {
            state.calls.push("detail");
            const d = await f.read(id(30), state.user);
            return state.forged
              ? { ...d, proposal: { ...d.proposal, org_id: id(100) } }
              : d;
          },
        };
      if (name === "@/lib/supabase/server")
        return { createServiceSupabaseClient: () => service };
      if (name === "@/lib/storage/files-storage")
        return {
          getFilesObjectStream: async (input) => {
            state.calls.push("storage");
            assert.equal(input.path, org + "/books/ownership/original.pdf");
            assert.equal(input.orgId, org);
            if (state.storageError) throw Error("Private provider secret");
            await state.afterStorage?.();
            return {
              body: new ReadableStream({
                start(c) {
                  c.enqueue(state.bytes.subarray(0, 5));
                  c.enqueue(state.bytes.subarray(5));
                  c.close();
                },
              }),
            };
          },
        };
      return original.call(this, name, ...args);
    };
    for (const path of [
      filename,
      require.resolve("../lib/services/books/tax-attachments"),
      require.resolve("../app/api/books/entities/[entityId]/proposals/[proposalId]/originals/[versionId]/route"),
    ])
      delete require.cache[path];
    download = require(filename).downloadBooksEntityEvidence;
    GET =
      require("../app/api/books/entities/[entityId]/proposals/[proposalId]/originals/[versionId]/route").GET;
  } finally {
    Module._load = original;
  }
  return { ...f, state, download, GET };
}
const staging = async () =>
  new Set(
    (await fs.readdir(os.tmpdir())).filter((n) =>
      n.startsWith("arc-tax-evidence-"),
    ),
  );
async function clean(before) {
  for (let i = 0; i < 100; i++) {
    const current = await staging();
    if ([...current].every((n) => before.has(n))) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.deepEqual(await staging(), before);
}
test("invalid identity, Books denial, revoked entity access, forged scope and unselected versions reject before storage", async (t) => {
  const f = await harness(t);
  await assert.rejects(
    f.download("invalid", id(30), id(91)),
    (e) => e.status === 400,
  );
  assert.deepEqual(f.state.calls, []);
  f.state.denied = true;
  await assert.rejects(
    f.download(entity, id(30), id(91)),
    (e) => e.status === 403,
  );
  f.state.denied = false;
  f.state.user = reader;
  await f.rpc("set_books_legal_entity_member", [
    org,
    entity,
    actor,
    reader,
    "revoked",
    notes,
  ]);
  await assert.rejects(
    f.download(entity, id(30), id(91)),
    (e) => e.status === 403,
  );
  f.state.user = actor;
  f.state.forged = true;
  await assert.rejects(
    f.download(entity, id(30), id(91)),
    (e) => e.status === 409,
  );
  f.state.forged = false;
  await assert.rejects(
    f.download(entity, id(30), id(92)),
    (e) => e.status === 409,
  );
  await assert.rejects(
    f.download(id(10), id(999), id(91)),
    (e) => e.status === 409,
  );
  assert.equal(f.state.calls.includes("storage"), false);
});
test("frozen originals remain downloadable after current file/version metadata changes and staged bytes clean on completion", async (t) => {
  const f = await harness(t),
    before = await staging();
  await f.db.query("update files set storage_path=$1,current_version_id=$2", [
    org + "/current/replacement.pdf",
    id(999),
  ]);
  await f.db.query(
    "update doc_versions set storage_path=$1,checksum=repeat('b',64) where id=$2",
    [org + "/current/changed.pdf", id(91)],
  );
  const attachment = await f.download(entity, id(30), id(91));
  assert.deepEqual(
    Buffer.from(await new Response(attachment.body).arrayBuffer()),
    f.bytes,
  );
  assert.equal(attachment.name, 'Original "formation"\r\n.pdf');
  assert.equal(
    f.state.calls.filter((c) => c === "assert_books_legacy_entity_operation")
      .length,
    2,
  );
  await clean(before);
});
test("corrupt, missing or aborted originals return no body and clean staging; authority is checked again after verification", async (t) => {
  const f = await harness(t),
    before = await staging();
  for (const bytes of [
    Buffer.from("x".repeat(f.bytes.length)),
    f.bytes.subarray(1),
    Buffer.concat([f.bytes, Buffer.from("extra")]),
  ]) {
    f.state.bytes = bytes;
    await assert.rejects(
      f.download(entity, id(30), id(91)),
      (e) => e.status === 409,
    );
    await clean(before);
  }
  f.state.bytes = f.bytes;
  f.state.storageError = true;
  await assert.rejects(
    f.download(entity, id(30), id(91)),
    (e) => e.status === 409,
  );
  await clean(before);
  f.state.storageError = false;
  const c = new AbortController();
  c.abort();
  await assert.rejects(
    f.download(entity, id(30), id(91), c.signal),
    (e) => e.status === 409,
  );
  await clean(before);
  f.state.afterStorage = async () => {
    f.state.denied = true;
  };
  await assert.rejects(
    f.download(entity, id(30), id(91)),
    (e) => e.status === 403,
  );
  await clean(before);
  f.state.denied = false;
  f.state.user = reader;
  f.state.afterStorage = async () => {
    await f.rpc("set_books_legal_entity_member", [
      org,
      entity,
      actor,
      reader,
      "revoked",
      notes,
    ]);
  };
  await assert.rejects(
    f.download(entity, id(30), id(91)),
    (e) => e.status === 403,
  );
  await clean(before);
});
test("actual download route delivers private safe attachment headers and hides original storage failures", async (t) => {
  const f = await harness(t),
    before = await staging(),
    request = new Request("http://localhost/original"),
    params = Promise.resolve({
      entityId: entity,
      proposalId: id(30),
      versionId: id(91),
    });
  const r = await f.GET(request, { params });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "private, no-store");
  assert.equal(r.headers.get("x-content-type-options"), "nosniff");
  assert.equal(r.headers.get("content-type"), "application/octet-stream");
  assert.equal(r.headers.get("content-length"), String(f.bytes.length));
  assert.match(r.headers.get("content-disposition"), /^attachment;/);
  assert.equal(r.headers.get("content-disposition").includes("%0D"), false);
  assert.deepEqual(Buffer.from(await r.arrayBuffer()), f.bytes);
  await clean(before);
  f.state.storageError = true;
  const failure = await f.GET(request, { params });
  assert.equal(failure.status, 409);
  const body = await failure.text();
  assert.equal(body.includes("Private provider secret"), false);
  assert.equal(body.includes("original.pdf"), false);
  await clean(before);
});
