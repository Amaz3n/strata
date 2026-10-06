const assert = require("node:assert/strict");
const test = require("node:test");
const {
  loadHandler,
  fakeClock,
  blockNetwork,
  database,
} = require("./fixtures/drawing-lifecycle/harness.cjs");
const { startDrawingLifecycleStage } = loadHandler(
  "lib/drawings/lifecycle-metrics.ts",
);

test("telemetry uses injected clock, redacts unrecognized input, and finishes once", () => {
  const clock = fakeClock(),
    events = [];
  const finish = startDrawingLifecycleStage(
    "transfer",
    {
      operationId: "op-1",
      revisionId: "https://secret.invalid",
      filename: "secret.pdf",
    },
    { now: clock.now, sink: (e) => events.push(e) },
  );
  clock.advance(125);
  finish("success", {
    bytesTransferred: 24,
    attempts: 1,
    signedUrl: "secret",
    databaseCalls: NaN,
  });
  finish("failure");
  assert.deepEqual(events, [
    {
      stage: "transfer",
      outcome: "success",
      durationMs: 125,
      operationId: "op-1",
      bytesTransferred: 24,
      attempts: 1,
    },
  ]);
  assert.doesNotThrow(() =>
    startDrawingLifecycleStage(
      "publish",
      {},
      {
        sink: () => {
          throw Error("telemetry down");
        },
      },
    )("success"),
  );
});

test("fixtures reject non-fixture network and missing dependencies", async (t) => {
  blockNetwork(t);
  await assert.rejects(
    fetch("https://production.invalid"),
    /Non-fixture URL blocked/,
  );
  const pipeline = loadHandler("lib/services/drawings-pipeline.ts");
  await assert.rejects(
    pipeline.hasPendingDrawingJobs(),
    /Missing fixture dependency/,
  );
});

test("lease recovery calls its dedicated database boundary and surfaces failure", async (t) => {
  blockNetwork(t);
  const calls = [];
  let failure = false;
  const fixture = database({}, async (name, input) => {
    calls.push({ name, input });
    return { error: failure ? { message: "database unavailable" } : null };
  });
  const pipeline = loadHandler("lib/services/drawings-pipeline.ts");
  await pipeline.recoverDrawingJobs(fixture.client);
  assert.equal(calls[0].name, "recover_drawing_job_leases");
  failure = true;
  await assert.rejects(
    pipeline.recoverDrawingJobs(fixture.client),
    /database unavailable/,
  );
});

test("publish uses one atomic RPC and does not enqueue jobs after commit", async (t) => {
  blockNetwork(t);
  const revision = "00000000-0000-4000-8000-000000000010";
  const fixture = database(
    {
      drawing_revisions: [
        { id: revision, org_id: "org", project_id: "project", status: "draft" },
      ],
      outbox: [],
    },
    async (name) => {
      assert.equal(name, "publish_drawing_revision");
      return { error: null };
    },
  );
  fixture.faults.set("outbox:insert", "postcommit insertion is forbidden");
  const service = loadHandler("lib/services/drawings.ts", {
    "@/lib/services/context": {
      requireOrgContext: async () => ({ orgId: "org", userId: "user" }),
    },
    "@/lib/services/permissions": { requireProjectPermission: async () => {} },
    "@/lib/supabase/server": {
      createServiceSupabaseClient: () => fixture.client,
    },
  });
  await service.publishRevision({ revisionId: revision });
  assert.equal(fixture.tables.outbox.length, 0);
  assert.equal(fixture.counts.databaseCalls, 2);
});

test("metadata delivery is idempotent and a discarded revision cannot become reviewable", async (t) => {
  blockNetwork(t);
  const fixture = database({
    outbox: [],
    drawing_revisions: [],
    drawing_sheet_versions: [
      { id: "version", org_id: "org", extracted_metadata: {} },
    ],
  });
  const pipeline = loadHandler("lib/services/drawings-pipeline.ts", {}, [
    "enqueueDrawingMetadata",
    "finishMetadataProgress",
  ]);
  const payload = {
    orgId: "org",
    draftRevisionId: "discarded",
    sheetVersionId: "version",
    sheetId: "sheet",
  };
  await pipeline.enqueueDrawingMetadata(fixture.client, payload);
  await pipeline.enqueueDrawingMetadata(fixture.client, payload);
  assert.equal(fixture.tables.outbox.length, 1);
  fixture.client.rpc=async()=>({data:null});
  await pipeline.finishMetadataProgress(fixture.client, "discarded", "org");
  assert.equal(fixture.tables.drawing_revisions.length, 0);
});
