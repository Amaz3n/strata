require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  Module = require("module"),
  sharp = require("sharp");
const { RASTER_ARC_PROFILE } = require("../lib/drawings/raster-arcs");
const { RASTER_TEXT_PROFILE } = require("../lib/drawings/raster-text");
const { RASTER_PLAN_PROFILE } = require("../lib/drawings/raster-plan-evidence");
let cached, mode, renders, closes, opens, uploads, extracts, inspections;
const region = { x0: 0.2, y0: 0.2, x1: 0.4, y1: 0.4 },
  sampling = {
    profile: "pdf-native-density-1",
    kind: "native-raster",
    minimumSourceDpi: 300,
    maximumSourceDpi: 300,
    renderScale: 300 / 72,
    warnings: [],
  };
const input = {
  supabase: {},
  tilesBasePath: "org-a/sheet",
  imageWidth: 2000,
  imageHeight: 2000,
  feetPerImagePx: 0.05,
  region,
  source: { orgId: "org-a", fileId: "file-a", pageIndex: 0 },
};
const real = Module._load;
Module._load = function (request, parent, main) {
  if (parent?.filename.endsWith("/lib/services/architectural-raster.ts")) {
    if (request === "@/lib/drawings/raster-plan-evidence")
      return {
        RASTER_PLAN_PROFILE,
        extractRasterPlanEvidence: (options) => {
          extracts++;
          const clipped = extracts === 1 || mode === "remaining";
          return {
            version: 1,
            extractionProfile: RASTER_PLAN_PROFILE,
            truncated: mode === "truncated" && extracts > 1,
            paths: clipped
              ? [
                  {
                    id: 7,
                    kind: "stroke",
                    commands: Array.from({ length: 8 }, (_, i) => [
                      i ? "L" : "M",
                      options.region.x0 + 0.0001 + i * 0.004,
                      options.region.y0 + 0.04 + i * 0.004,
                    ]),
                    width: 0.0002,
                    opacity: 1,
                    color: [0],
                    colorSpace: "DeviceGray",
                    dashes: [],
                    layer: [],
                    groups: [],
                    clips: [],
                    evenOdd: false,
                    rasterFeature: "circular-arc",
                    rasterArc: {
                      profile: RASTER_ARC_PROFILE,
                      sampleCount: 80,
                      maximumDeviationPixels: 1,
                      sweepRadians: Math.PI / 2,
                      continuousInk: true,
                      clipped: true,
                    },
                  },
                ]
              : [],
            raster: {
              width: options.width,
              height: options.height,
              feetPerPixel: options.feetPerPixel,
              threshold: 120,
              maximumDeviationPixels: 2.5,
              region: options.region,
            },
          };
        },
      };
    if (request === "./original-sheet-raster")
      return {
        openOriginalSheetRaster: async () => {
          opens++;
          return {
            sampling,
            sourceHash: "a".repeat(64),
            imageWidth: 2000,
            imageHeight: 2000,
            inspectSampling: (window) => {
              inspections.push(window);
              if (mode === "inspect-failure")
                throw Error("source sampling failed");
              return mode === "unverified"
                ? {
                    ...sampling,
                    kind: "unverified",
                    minimumSourceDpi: null,
                    maximumSourceDpi: null,
                  }
                : sampling;
            },
            close: () => closes++,
            renderWindow: async (window) => {
              renders.push(window);
              if (renders.length === 2 && mode === "failure")
                throw Error("retry pixels missing");
              const scale =
                renders.length === 2 && mode === "density-loss" ? 1000 : 2000;
              return {
                data: await sharp({
                  create: {
                    width: Math.round((window.x1 - window.x0) * scale),
                    height: Math.round((window.y1 - window.y0) * scale),
                    channels: 3,
                    background: "white",
                  },
                })
                  .png()
                  .toBuffer(),
                sourceRegion: window,
                mediaType: "image/png",
                renderScale: sampling.renderScale,
              };
            },
          };
        },
      };
    if (request === "@/lib/storage/drawings-tiles-storage")
      return {
        downloadTilesObject: async () => {
          if (!cached) throw Error("no cache");
          return Buffer.from(JSON.stringify(cached));
        },
        uploadTilesObject: async (v) => uploads.push(v),
      };
    if (request === "./local-raster-text")
      return {
        loadLocalRasterText: async (options) => {
          assert.deepEqual(options.region, region);
          return {
            profile: RASTER_TEXT_PROFILE,
            status: "processed",
            runs: [],
            windows: 1,
            warnings: [],
            source: { kind: "original-pdf", hash: "a".repeat(64), sampling },
          };
        },
      };
  }
  return real.call(this, request, parent, main);
};
const {
  loadRasterArchitecturalEvidence,
} = require("../lib/services/architectural-raster");
Module._load = real;
test.beforeEach(() => {
  cached = null;
  mode = "complete";
  renders = [];
  closes = 0;
  opens = 0;
  uploads = [];
  extracts = 0;
  inspections = [];
});
test("one context read preserves selection, independently checks density, and caches source-addressable complete evidence", async () => {
  const { evidence } = await loadRasterArchitecturalEvidence(input),
    ctx = evidence.raster.context;
  assert.equal(ctx.status, "expanded");
  assert.equal(ctx.attempts, 1);
  assert.equal(renders.length, 2);
  assert.equal(closes, 1);
  assert.equal(uploads.length, 1);
  assert.deepEqual(ctx.requestedRegion, region);
  assert.deepEqual(inspections, [ctx.effectiveRegion]);
  assert.deepEqual(ctx.edges, ["left"]);
  assert.deepEqual(ctx.triggerPathIds, [7]);
  cached = JSON.parse(uploads[0].bytes);
  const second = await loadRasterArchitecturalEvidence(input);
  assert.deepEqual(second.evidence, evidence);
  assert.equal(opens, 1);
  cached.raster.context.requestedRegion = { ...region, x0: 0.25 };
  await loadRasterArchitecturalEvidence(input);
  assert.equal(opens, 2);
});
test("unverified added context and sampling failures retain the original observations without persisting a success", async () => {
  for (const value of ["unverified", "inspect-failure"]) {
    mode = value;
    const { evidence } = await loadRasterArchitecturalEvidence(input);
    assert.equal(evidence.raster.context.status, "unresolved");
    assert.equal(evidence.raster.context.attempts, 0);
    assert.equal(
      evidence.raster.context.reason,
      value === "unverified" ? "source-unverified" : "read-failed",
    );
    assert.deepEqual(evidence.raster.region, region);
    assert.equal(uploads.length, 0);
    assert.equal(closes, opens);
    extracts = 0;
  }
});
test("failed, incomplete or coarser retry pixels never replace complete initial observations", async () => {
  for (const value of ["failure", "truncated", "density-loss"]) {
    mode = value;
    renders = [];
    extracts = 0;
    const { evidence } = await loadRasterArchitecturalEvidence(input);
    assert.equal(evidence.raster.context.status, "unresolved");
    assert.equal(evidence.raster.context.attempts, 1);
    assert.equal(
      evidence.raster.context.reason,
      value === "failure" ? "read-failed" : "geometry-budget",
    );
    assert.deepEqual(evidence.raster.region, region);
    assert.equal(evidence.paths[0].id, 7);
    assert.equal(evidence.truncated, false);
    assert.equal(uploads.length, 0);
    assert.equal(closes, opens);
  }
});
test("remaining clipping stops after one retry and remains explicit and uncached", async () => {
  mode = "remaining";
  const { evidence } = await loadRasterArchitecturalEvidence(input);
  assert.equal(evidence.raster.context.status, "unresolved");
  assert.equal(evidence.raster.context.reason, "remaining-clipping");
  assert.equal(renders.length, 2);
  assert.equal(uploads.length, 0);
  assert.equal(closes, 1);
});

test("source-context provenance survives building projection and schema reload, while malformed context remains an error", async () => {
  const { evidence } = await loadRasterArchitecturalEvidence(input);
  const {
      reconstructBuilding,
    } = require("../lib/drawings/building-reconstruction"),
    { buildingToFloorplan } = require("../lib/drawings/building-floorplan"),
    { floorplanModelSchema } = require("../lib/validation/floorplan");
  const sourceInput = {
    ...input,
    evidence,
    textRuns: [],
    segments: [],
    sheetVersionId: "00000000-0000-4000-8000-000000000001",
    sheetNumber: null,
    sheetTitle: null,
    name: "Test floor",
    order: 0,
    scaleConfirmed: false,
  };
  const arch = {
    version: 1,
    elements: [],
    spaces: [],
    openings: [],
    finishZones: [],
    conflicts: [],
    spacePolicy: "include-fixtures",
    qualification: "unqualified",
  };
  const building = reconstructBuilding(sourceInput, arch),
    level = buildingToFloorplan(sourceInput, { ...arch, building });
  const model = floorplanModelSchema.parse(
    JSON.parse(
      JSON.stringify({
        version: 1,
        units: "feet",
        levels: [level],
        correctionCount: 0,
      }),
    ),
  );
  assert.deepEqual(
    model.levels[0].reconstruction.source.rasterContext,
    evidence.raster.context,
  );
  assert.ok(
    model.levels[0].reconstruction.issues.some(
      (i) => i.code === "raster-context",
    ),
  );
  model.levels[0].reconstruction.source.rasterContext.attempts = 2;
  assert.equal(floorplanModelSchema.safeParse(model).success, false);
  const invalid = structuredClone(evidence);
  invalid.raster.context.effectiveRegion.x0 = 0.3;
  const bad = reconstructBuilding({ ...sourceInput, evidence: invalid }, arch);
  assert.equal(bad.status, "incomplete");
  assert.ok(bad.issues.some((i) => i.code === "raster-context-invalid"));
  assert.equal(bad.source.rasterContext, undefined);
});
