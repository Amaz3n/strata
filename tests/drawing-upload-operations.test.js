const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  createDatabase,
  migrate,
  id,
} = require("./fixtures/drawing-lifecycle/database.cjs");
test("real atomic upload migration: admission, retries, cancellation, expiry and rollback", async (t) => {
  const db = await createDatabase();
  t.after(() => db.close());
  await migrate(db, "20261001122054_drawing_upload_operations.sql");
  const intent = {
    projectId: id(4),
    fileName: "fixture.pdf",
    fileSize: 123,
    mimeType: "application/pdf",
  };
  const reserve = async (op = 10, value = intent) =>
    (
      await db.query("select reserve_drawing_upload($1,$2,$3,$4,$5) as op", [
        id(op),
        id(1),
        id(4),
        id(3),
        value,
      ])
    ).rows[0].op;
  const finalize = async (op, generation, size = 123) =>
    (
      await db.query(
        "select finalize_drawing_upload($1,$2,$3,$4,$5,$6,$7) as op",
        [op.id, id(1), id(4), id(3), op.storage_path, generation, size],
      )
    ).rows[0].op;
  const first = await reserve();
  assert.equal((await reserve()).id, first.id);
  await assert.rejects(reserve(11), /Another upload/);
  await assert.rejects(reserve(10, { ...intent, fileSize: 124 }), /conflicts/);
  await assert.rejects(
    db.query("select cancel_drawing_upload($1,$2,$3,$4)", [
      id(10),
      id(2),
      id(4),
      id(3),
    ]),
    /not found/,
  );
  await assert.rejects(finalize(first, id(90)), /not active/);
  await assert.rejects(finalize(first, first.generation, 122), /size mismatch/);
  await db.exec(
    `create function reject_queue() returns trigger language plpgsql as $$begin raise exception 'queue unavailable';end$$;create trigger fail_queue before insert on outbox for each row execute function reject_queue();`,
  );
  await assert.rejects(finalize(first, first.generation), /queue unavailable/);
  assert.equal(
    (await db.query("select count(*)::int n from files")).rows[0].n,
    0,
  );
  assert.equal(
    (await db.query("select count(*)::int n from drawing_revisions")).rows[0].n,
    0,
  );
  await db.exec("drop trigger fail_queue on outbox");
  const completed = await finalize(first, first.generation);
  for (let i = 0; i < 10; i++)
    assert.deepEqual(await finalize(first, first.generation), completed);
  assert.equal(
    (await db.query("select count(*)::int n from outbox")).rows[0].n,
    1,
  );
  const cancelAfter = (
    await db.query("select cancel_drawing_upload($1,$2,$3,$4) op", [
      id(10),
      id(1),
      id(4),
      id(3),
    ])
  ).rows[0].op;
  assert.equal(cancelAfter.status, "registered");
  assert.equal(
    (await db.query("select source_file_id from drawing_sets")).rows[0]
      .source_file_id,
    null,
    "draft never changes live source",
  );
  await db.exec("update drawing_revisions set status='published'");
  const second = await reserve(11);
  await db.query("select cancel_drawing_upload($1,$2,$3,$4)", [
    second.id,
    id(1),
    id(4),
    id(3),
  ]);
  await assert.rejects(finalize(second, second.generation), /not active/);
  const third = await reserve(12);
  await db.exec(
    `update drawing_upload_operations set expires_at=now()-interval '1 second' where id='${third.id}'`,
  );
  const replacement = await reserve(13);
  await assert.rejects(reserve(12), /Another upload/);
  await db.query("select cancel_drawing_upload($1,$2,$3,$4)", [
    replacement.id,
    id(1),
    id(4),
    id(3),
  ]);
  const renewed = await reserve(12);
  assert.notEqual(renewed.generation, third.generation);
  assert.notEqual(renewed.storage_path, third.storage_path);
  assert.equal(renewed.transfer_id, null);
  assert.equal(renewed.multipart_upload_id, null);
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from drawing_abandoned_uploads where operation_id=$1",
        [third.id],
      )
    ).rows[0].n,
    1,
  );
  await assert.rejects(finalize(third, third.generation), /not active/);
});

const {
  loadHandler,
  database,
  blockNetwork,
} = require("./fixtures/drawing-lifecycle/harness.cjs");
function uploadService(fixture, head) {
  return loadHandler("lib/services/drawing-upload-operations.ts", {
    "@/lib/services/context": {
      requireOrgContext: async () => ({ orgId: id(1), userId: id(3) }),
    },
    "@/lib/services/permissions": { requireProjectPermission: async () => {} },
    "@/lib/supabase/server": {
      createServiceSupabaseClient: () => fixture.client,
    },
    "@/lib/storage/drawings-pdfs-storage": { headDrawingPdfObject: head },
    "@/lib/services/drawings": { getDrawingSet: async () => ({ id: id(40) }) },
    "@/lib/services/drawings-pipeline-trigger": {
      triggerDrawingsPipeline: async () => ({ triggered: true }),
    },
  });
}
function operation(overrides = {}) {
  return {
    id: id(10),
    org_id: id(1),
    project_id: id(4),
    user_id: id(3),
    generation: id(20),
    storage_path: `${id(1)}/${id(4)}/drawings/uploads/${id(10)}/${id(20)}.pdf`,
    status: "reserved",
    expires_at: "2030-01-01T00:00:00Z",
    transfer_id: id(30),
    multipart_upload_id: "upload",
    file_id: null,
    revision_id: null,
    drawing_set_id: null,
    intent: {
      projectId: id(4),
      fileName: "plans.pdf",
      fileSize: 123,
      mimeType: "application/pdf",
      fingerprint: `sha256-chain-v1:123:${"a".repeat(64)}`,
    },
    ...overrides,
  };
}
test("real registration handler rejects same-size wrong identity and retries commit with zero HEAD/PUT", async (t) => {
  blockNetwork(t);
  const op = operation(),
    calls = [];
  const db = database({ drawing_upload_operations: [op] }, async (name) => {
    calls.push(name);
    return {
      data: {
        ...op,
        status: "registered",
        file_id: id(39),
        revision_id: id(41),
        drawing_set_id: id(40),
      },
    };
  });
  const input = {
    ...op.intent,
    operationId: op.id,
    storagePath: op.storage_path,
  };
  delete input.fingerprint;
  await assert.rejects(
    uploadService(db, async () => ({
      size: 123,
      metadata: {},
    })).finalizeDrawingUpload(input),
    /identity/,
  );
  assert.equal(calls.length, 0);
  const service = uploadService(db, async () => ({
    size: 123,
    metadata: {
      operation_id: op.id,
      generation: op.generation,
      "content-identity": op.intent.fingerprint,
      "transfer-id": op.transfer_id,
    },
  }));
  assert.equal(
    (await service.finalizeDrawingUpload(input)).draftRevisionId,
    id(41),
  );
  Object.assign(op, {
    status: "registered",
    file_id: id(39),
    revision_id: id(41),
    drawing_set_id: id(40),
  });
  await uploadService(db, async () => {
    throw Error("HEAD forbidden on receipt replay");
  }).finalizeDrawingUpload(input);
  assert.equal(calls.length, 1);
  await assert.rejects(
    service.finalizeDrawingUpload({ ...input, fileName: "changed.pdf" }),
    /intent/,
  );
});
test("library handler canonicalizes empty legacy action inputs and reuses owned source", async (t) => {
  blockNetwork(t);
  const op = operation({ transfer_id: null, multipart_upload_id: null });
  op.intent = {
    projectId: id(4),
    sourceFileId: id(39),
    fileName: "library.pdf",
    fileSize: 123,
    mimeType: "application/pdf",
  };
  const db = database(
    {
      drawing_upload_operations: [op],
      files: [
        {
          id: id(39),
          org_id: id(1),
          project_id: id(4),
          file_name: "library.pdf",
          size_bytes: 123,
          mime_type: "application/pdf",
          storage_path: "library-path",
          archived_at: null,
        },
      ],
    },
    async (name, input) => {
      assert.equal(name, "finalize_drawing_upload");
      assert.equal(input.p_storage_path, "library-path");
      return {
        data: {
          ...op,
          status: "registered",
          file_id: id(39),
          revision_id: id(41),
          drawing_set_id: id(40),
        },
      };
    },
  );
  const result = await uploadService(db, async ({ path }) => {
    assert.equal(path, "library-path");
    return { size: 123 };
  }).finalizeDrawingUpload({
    operationId: op.id,
    projectId: id(4),
    sourceFileId: id(39),
    fileName: "",
    fileSize: 0,
    mimeType: "application/pdf",
    storagePath: "",
  });
  assert.equal(result.draftRevisionId, id(41));
  assert.equal(db.tables.files.length, 1);
});
