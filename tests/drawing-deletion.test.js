const test = require("node:test"),
  assert = require("node:assert/strict");
const {
  loadHandler,
  database,
  blockNetwork,
} = require("./fixtures/drawing-lifecycle/harness.cjs");
const org = "00000000-0000-4000-8000-000000000001";
function service(storage) {
  return loadHandler("lib/services/drawing-storage-cleanup.ts", {
    "@/lib/storage/drawings-tiles-storage": storage,
  });
}
test("actual collector removes 2501 keys across bounded batches, retries failures and rejects unowned prefixes", async (t) => {
  blockNetwork(t);
  const keys = Array.from(
    { length: 2501 },
    (_, i) => `${org}/artifacts/a/${i}`,
  );
  let calls = 0,
    fail = true;
  const api = service({
    listTilesObjectsPage: async () => ({
      objects: keys.slice(0, 1000).map((name) => ({ name })),
    }),
    deleteTilesObjects: async ({ paths }) => {
      calls++;
      if (fail) {
        fail = false;
        throw Error("per-key failure");
      }
      keys.splice(0, paths.length);
    },
  });
  await assert.rejects(
    api.deleteDrawingArtifactPrefix({}, org, `${org}/artifacts/a`),
    /per-key/,
  );
  assert.equal(keys.length, 2501);
  const first = await api.deleteDrawingArtifactPrefix(
    {},
    org,
    `${org}/artifacts/a`,
    1000,
  );
  assert.equal(first.complete, false);
  assert.equal(keys.length, 1501);
  const rest = await api.deleteDrawingArtifactPrefix(
    {},
    org,
    `${org}/artifacts/a`,
  );
  assert.equal(rest.complete, true);
  assert.equal(keys.length, 0);
  assert.equal(calls, 4);
  await assert.rejects(
    api.deleteDrawingArtifactPrefix({}, org, "foreign/artifacts/a"),
    /Unowned/,
  );
});
test("one failing prefix backs off durably while independent cleanup completes", async (t) => {
  blockNetwork(t);
  const bad = "00000000-0000-4000-8000-000000000002",
    good = "00000000-0000-4000-8000-000000000003";
  const events = [],
    objects = new Set([`${org}/artifacts/${good}/tile`]);
  const db = database(
    { drawing_abandoned_uploads: [], drawing_cleanup_failures: [] },
    async (name, input) => {
      events.push([name, input]);
      if (name === "drawing_storage_cleanup_candidates")
        return { data: [bad, good].map((id) => ({ id, kind: "artifact" })) };
      if (name === "retire_drawing_artifact")
        return {
          data: {
            retired: true,
            storage_prefix: `${org}/artifacts/${input.p_artifact_id}`,
            generation: input.p_artifact_id,
          },
        };
      return { data: true };
    },
  );
  const api = service({
    listTilesObjectsPage: async ({ prefix }) => {
      if (prefix.includes(bad)) throw Error("listing outage");
      return { objects: [...objects].map((name) => ({ name })) };
    },
    deleteTilesObjects: async ({ paths }) =>
      paths.forEach((p) => objects.delete(p)),
  });
  await api.runDrawingStorageCleanup(db.client, org);
  assert.equal(objects.size, 0);
  assert.ok(
    events.some(
      ([name, p]) =>
        name === "record_drawing_cleanup_failure" && p.p_entity_id === bad,
    ),
  );
  assert.ok(
    events.some(
      ([name, p]) =>
        name === "complete_drawing_artifact_deletion" &&
        p.p_artifact_id === good,
    ),
  );
});

test('abandoned source cleanup preserves library and registered references and isolates storage failures',async t=>{
 blockNetwork(t)
 const bad='00000000-0000-4000-8000-000000000002',good='00000000-0000-4000-8000-000000000003',owned='00000000-0000-4000-8000-000000000004',registered='00000000-0000-4000-8000-000000000005'
 const records=[bad,good,owned,registered].map(id=>({id,org_id:org,operation_id:id,storage_path:`${org}/project/drawings/uploads/${id}/generation.pdf`,multipart_upload_id:null,not_before:'2000-01-01T00:00:00Z'}))
 const calls=[],removed=[]
 const db=database({drawing_abandoned_uploads:records,files:[{id:owned,org_id:org,storage_path:records[2].storage_path}],drawing_upload_operations:[{id:registered,org_id:org,storage_path:records[3].storage_path,status:'registered'}]},async(name,input)=>{calls.push([name,input]);return {data:name==='drawing_storage_cleanup_candidates'?[]:true}})
 const api=loadHandler('lib/services/drawing-storage-cleanup.ts',{'@/lib/storage/drawings-pdfs-storage':{abortDrawingPdfMultipartUpload:async()=>{},deleteDrawingPdfObject:async({path})=>{if(path.includes(bad))throw Error('storage unavailable');removed.push(path)}}})
 await api.runDrawingStorageCleanup(db.client,org)
 assert.deepEqual(removed,[records[1].storage_path])
 assert.ok(calls.some(([name,args])=>name==='record_drawing_cleanup_failure'&&args.p_kind==='upload'&&args.p_entity_id===bad))
 assert.ok(records[1].cleaned_at)
 assert.ok(Date.parse(records[2].not_before)>Date.now(),'retained reference is deferred rather than starving later candidates')
})
