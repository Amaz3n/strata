require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  crypto = require("node:crypto");
const { fixture } = require("./support/raster-door-fixture");
const {
  RecognitionSourceFactIndex,
  createRecognitionSourceFacts,
  restoreRecognitionSourceFacts,
} = require("../lib/drawings/recognition-source-facts");
const { sourceWallNetwork } = require("../lib/drawings/vector-wall-network");
const {
  bindWallHypothesis,
} = require("../lib/drawings/wall-hypothesis-semantics");
const {
  interpretArchitecturalElements,
} = require("../lib/drawings/area-semantics");
const {
  pruneRecognizedSourceRequest,
  settledSourceWallSpans,
} = require("../lib/drawings/recognition-resume");
const { runAreaEngine } = require("../lib/drawings/area-engine");
const scope = "d".repeat(64),
  region = { x0: 0, y0: 0, x1: 1, y1: 1 },
  clone = (v) => JSON.parse(JSON.stringify(v));
function setup() {
  const f = fixture();
  f.evidence.raster.sourceHash = "a".repeat(64);
  const index = new RecognitionSourceFactIndex(f.evidence, 12, 12),
    path = f.evidence.paths.find((p) => p.rasterLine),
    network = sourceWallNetwork({
      ...f.args,
      textRuns: [],
      inspectUnfilledPairs: true,
    }),
    body =
      network.candidates.find((b) => b.pathIds.includes(path.id)) ??
      network.candidates[0],
    binding = bindWallHypothesis(f.evidence, body, 12, 12),
    image = {
      profile: "registered-source-image-1",
      kind: "original-pdf",
      fileId: "file",
      pageIndex: 0,
      sourceHash: f.evidence.raster.sourceHash,
      evidenceHash: index.evidenceHash,
      requestedRegion: region,
      sourceRegion: region,
      width: 600,
      height: 600,
      nativeWidth: 600,
      nativeHeight: 600,
      renderDpi: 300,
      sampling: {
        profile: "pdf-native-density-1",
        kind: "native-raster",
        minimumSourceDpi: 300,
        maximumSourceDpi: 300,
        renderScale: 300 / 72,
        warnings: [],
      },
      nativeDensityPreserved: true,
      imageSha256: crypto
        .createHash("sha256")
        .update(f.rasterInput.pixels)
        .digest("hex"),
      annotatedSha256: "c".repeat(64),
    },
    observation = {
      id: "original",
      sourceImage: image,
      region,
      suppliedPathIds: [path.id],
      elements: [{ pathIds: [path.id], kind: "wall" }],
      openings: [],
      suppliedWallHypotheses: [binding],
      wallHypotheses: [{ hypothesisId: binding.id, kind: "wall" }],
    };
  return { f, index, path, binding, image, observation };
}
function renumber(evidence) {
  const e = clone(evidence);
  e.extractionProfile = "new-extraction-with-identical-source";
  for (const p of e.paths) {
    p.id += 1000;
    p.clips = p.clips.map((id) => id + 1000);
  }
  for (const p of e.rasterPairPaint)
    p.pathIds = p.pathIds.map((id) => id + 1000);
  return e;
}
test("exact source roles and measured spans survive extraction IDs/profile changes while original image provenance stays intact", () => {
  const s = setup(),
    record = createRecognitionSourceFacts(scope, s.index, s.observation),
    e = renumber(s.f.evidence),
    index = new RecognitionSourceFactIndex(e, 12, 12),
    o = restoreRecognitionSourceFacts(record, scope, index, region);
  assert.ok(o);
  assert.deepEqual(o.sourceImage, s.image);
  assert.equal(o.suppliedPathIds[0], s.path.id + 1000);
  assert.deepEqual(
    o.suppliedWallHypotheses[0].pathIds,
    s.binding.pathIds.map((id) => id + 1000),
  );
  assert.notEqual(o.suppliedWallHypotheses[0].witness, s.binding.witness);
  assert.notEqual(
    o.sourceReuse.currentEvidenceHash,
    o.sourceReuse.priorEvidenceHash,
  );
  assert.deepEqual(o.openings, []);
  assert.ok(
    settledSourceWallSpans(e, [o]).has(o.suppliedWallHypotheses[0].witness),
  );
});
test("changed coordinates, ambiguous duplicates, different scope/scale and corrupt records cannot acquire earlier roles", () => {
  const s = setup(),
    role = { ...s.observation, suppliedWallHypotheses: [], wallHypotheses: [] },
    record = createRecognitionSourceFacts(scope, s.index, role);
  for (const change of [
    (e) => {
      e.paths.find((p) => p.id === s.path.id).commands[0][1] += 1e-11;
    },
    (e) => {
      e.paths.push({
        ...clone(e.paths.find((p) => p.id === s.path.id)),
        id: 90000,
      });
    },
  ]) {
    const e = clone(s.f.evidence);
    change(e);
    assert.equal(
      restoreRecognitionSourceFacts(
        record,
        scope,
        new RecognitionSourceFactIndex(e, 12, 12),
        region,
      ),
      null,
    );
  }
  assert.throws(
    () =>
      restoreRecognitionSourceFacts(record, "e".repeat(64), s.index, region),
    /ownership/,
  );
  assert.throws(
    () =>
      restoreRecognitionSourceFacts(
        record,
        scope,
        new RecognitionSourceFactIndex(s.f.evidence, 13, 12),
        region,
      ),
    /ownership/,
  );
  assert.throws(
    () =>
      restoreRecognitionSourceFacts(
        { ...record, paths: [{ ...record.paths[0], kind: "door" }] },
        scope,
        s.index,
        region,
      ),
    /provenance/,
  );
  assert.throws(
    () =>
      new RecognitionSourceFactIndex(
        { ...s.f.evidence, truncated: true },
        12,
        12,
      ),
    /incomplete/,
  );
});
test("local span facts require freshly measured support and complete binding witnesses, never whole-parent wall roles", () => {
  const s = setup(),
    spanOnly = { ...s.observation, elements: [], suppliedPathIds: [] },
    record = createRecognitionSourceFacts(scope, s.index, spanOnly);
  assert.ok(record);
  assert.equal(record.paths.length, 0);
  const e = clone(s.f.evidence),
    ids = new Set(s.binding.pathIds);
  for (const p of e.rasterPairPaint)
    if (p.pathIds.every((id) => ids.has(id)))
      p.inkFraction = Math.max(0, p.inkFraction - 0.00001);
  assert.equal(
    restoreRecognitionSourceFacts(
      record,
      scope,
      new RecognitionSourceFactIndex(e, 12, 12),
      region,
    ),
    null,
  );
  assert.equal(
    createRecognitionSourceFacts(scope, s.index, {
      ...spanOnly,
      suppliedWallHypotheses: [
        { ...s.binding, witness: s.binding.witness + "changed" },
      ],
    }),
    null,
  );
  assert.equal(
    createRecognitionSourceFacts(scope, s.index, {
      ...spanOnly,
      suppliedWallHypotheses: [
        { ...s.binding, thicknessFt: s.binding.thicknessFt + 0.1 },
      ],
    }),
    null,
  );
  const restored = restoreRecognitionSourceFacts(
    record,
    scope,
    s.index,
    region,
  );
  assert.deepEqual(restored.elements, []);
  assert.deepEqual(restored.suppliedPathIds, []);
});
test("opposing records remain conflicting, while duplicate/unknown span decisions remain in the unresolved workload", () => {
  const s = setup(),
    a = createRecognitionSourceFacts(scope, s.index, s.observation),
    b = createRecognitionSourceFacts(scope, s.index, {
      ...s.observation,
      elements: [{ pathIds: [s.path.id], kind: "annotation" }],
      wallHypotheses: [{ hypothesisId: s.binding.id, kind: "not-wall" }],
    }),
    prior = [a, b].map((r) =>
      restoreRecognitionSourceFacts(r, scope, s.index, region),
    );
  assert.equal(
    interpretArchitecturalElements(s.f.evidence, prior, {
      sx: 12,
      sy: 12,
    }).find((e) => e.pathId === s.path.id).conflict,
    true,
  );
  assert.equal(settledSourceWallSpans(s.f.evidence, prior).size, 0);
  assert.equal(
    settledSourceWallSpans(s.f.evidence, [
      {
        ...s.observation,
        wallHypotheses: [
          ...s.observation.wallHypotheses,
          ...s.observation.wallHypotheses,
        ],
      },
    ]).size,
    0,
  );
  assert.equal(
    settledSourceWallSpans(s.f.evidence, [
      {
        ...s.observation,
        wallHypotheses: [{ hypothesisId: s.binding.id, kind: "unknown" }],
      },
    ]).size,
    0,
  );
});
test("settled targets become nonvoting context and unknown targets still receive new recognition requests", async () => {
  const s = setup(),
    record = createRecognitionSourceFacts(scope, s.index, {
      ...s.observation,
      suppliedWallHypotheses: [],
      wallHypotheses: [],
    }),
    o = restoreRecognitionSourceFacts(record, scope, s.index, region),
    p = {
      id: s.path.id,
      prior: "unknown",
      kind: "stroke",
      bounds: [0, 0, 1, 1],
      commands: [],
    },
    request = { region, catalogue: [p, { ...p, id: 777 }] },
    trimmed = pruneRecognizedSourceRequest(
      request,
      new Set([s.path.id]),
      new Set(),
    );
  assert.deepEqual(
    trimmed.catalogue.map((p) => p.id),
    [777],
  );
  assert.deepEqual(
    trimmed.contextCatalogue.map((p) => p.id),
    [s.path.id],
  );
  assert.equal(
    pruneRecognizedSourceRequest(
      { ...request, catalogue: [p] },
      new Set([s.path.id]),
      new Set(),
    ),
    null,
  );
  let calls = 0;
  const recognize = Object.assign(
    async (request) => {
      calls++;
      assert.ok(!request.catalogue.some((p) => p.id === s.path.id));
      return {
        elements: request.catalogue.map((p) => ({
          pathIds: [p.id],
          kind: "unknown",
        })),
        openings: [],
        wallHypotheses: request.wallHypotheses?.map((h) => ({
          hypothesisId: h.binding.id,
          kind: "unknown",
        })),
      };
    },
    { prior: async () => [o] },
  );
  const run = await runAreaEngine(s.f.input, {
    wholeSheet: true,
    maxRecognitionWindows: 2,
    recognize,
  });
  assert.ok(calls > 0);
  assert.ok(run.observations.some((o) => o.sourceReuse));
  assert.equal(run.recognition, "partial");
  assert.ok(run.recognitionCoverage.unresolvedPaths > 0);
});
test("exact clip geometry is part of a primitive identity even when its numeric reference stays unchanged", () => {
  const s = setup(),
    e = clone(s.f.evidence),
    clip = {
      ...clone(s.path),
      id: 90001,
      kind: "clip",
      clips: [],
      commands: [["M", 0, 0], ["L", 1, 0], ["L", 1, 1], ["L", 0, 1], ["Z"]],
    };
  e.paths.push(clip);
  e.paths.find((p) => p.id === s.path.id).clips = [clip.id];
  const index = new RecognitionSourceFactIndex(e, 12, 12),
    o = {
      ...s.observation,
      sourceImage: { ...s.image, evidenceHash: index.evidenceHash },
      suppliedWallHypotheses: [],
      wallHypotheses: [],
    },
    record = createRecognitionSourceFacts(scope, index, o);
  assert.ok(record);
  clip.commands[1][1] = 0.9;
  assert.equal(
    restoreRecognitionSourceFacts(
      record,
      scope,
      new RecognitionSourceFactIndex(e, 12, 12),
      region,
    ),
    null,
  );
});
