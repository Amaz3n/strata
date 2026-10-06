require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  Module = require("module"),
  sharp = require("sharp");
const { RASTER_TEXT_PROFILE } = require("../lib/drawings/raster-text");
let reads, closed, uploads, cached, failSecond;
const sampling = {
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
  imageWidth: 5000,
  imageHeight: 200,
  feetPerImagePx: 0.02,
  region: { x0: 0, y0: 0, x1: 1, y1: 1 },
  source: { orgId: "org-a", fileId: "file-a", pageIndex: 0 },
};
const realLoad = Module._load;
Module._load = function (request, parent, main) {
  if (parent?.filename.endsWith("/lib/services/architectural-raster.ts")) {
    if (request === "./original-sheet-raster")
      return {
        openOriginalSheetRaster: async () => ({
          sampling,
          sourceHash: "a".repeat(64),
          imageWidth: 5000,
          imageHeight: 200,
          close: () => closed++,
          inspectSampling: () => sampling,
          renderWindow: async (window, max) => {
            reads.push(window);
            assert.equal(max, 4096);
            if (failSecond && reads.length === 2)
              throw Error("missing source pixels");
            const left = Math.floor(window.x0 * 5000),
              right = Math.ceil(window.x1 * 5000),
              top = Math.floor(window.y0 * 200),
              bottom = Math.ceil(window.y1 * 200);
            return {
              data: await sharp({
                create: {
                  width: right - left,
                  height: bottom - top,
                  channels: 3,
                  background: "white",
                },
              })
                .png()
                .toBuffer(),
              sourceRegion: {
                x0: left / 5000,
                y0: top / 200,
                x1: right / 5000,
                y1: bottom / 200,
              },
              renderScale: 300 / 72,
              mediaType: "image/png",
            };
          },
        }),
      };
    if (request === "@/lib/storage/drawings-tiles-storage")
      return {
        downloadTilesObject: async () => {
          if (!cached) throw Error("no cache");
          return Buffer.from(JSON.stringify(cached));
        },
        uploadTilesObject: async (value) => uploads.push(value),
      };
    if (request === "./local-raster-text")
      return {
        loadLocalRasterText: async () => ({
          profile: RASTER_TEXT_PROFILE,
          status: "processed",
          runs: [],
          windows: 1,
          warnings: [],
          source: { kind: "original-pdf", hash: "a".repeat(64), sampling },
        }),
      };
  }
  return realLoad.call(this, request, parent, main);
};
const {
  loadRasterArchitecturalEvidence,
} = require("../lib/services/architectural-raster");
Module._load = realLoad;
test.beforeEach(() => {
  reads = [];
  closed = 0;
  uploads = [];
  cached = null;
  failSecond = false;
});
test("large source views use real native pixel windows, retain complete coverage and reuse one validated logical-frame derivative", async () => {
  const { evidence } = await loadRasterArchitecturalEvidence(input),
    t = evidence.raster.tiling;
  assert.equal(t.status, "complete");
  assert.equal(t.processedWindows, 3);
  assert.equal(reads.length, 3);
  assert.equal(evidence.raster.renderDpi, 300);
  assert.equal(evidence.raster.width, 5000);
  assert.equal(evidence.truncated, false);
  assert.ok(t.windows.every((w) => w.width <= 4096 && w.renderDpi === 300));
  assert.equal(closed, 1);
  assert.equal(uploads.length, 1);
  cached = JSON.parse(uploads[0].bytes);
  await loadRasterArchitecturalEvidence(input);
  assert.equal(reads.length, 3);
  cached.raster.tiling.windows[1].core = {
    ...cached.raster.tiling.windows[0].core,
  };
  await loadRasterArchitecturalEvidence(input);
  assert.equal(reads.length, 6);
  assert.equal(closed, 2);
});
test("missing source windows remain incomplete without low-resolution substitution or a cached success", async () => {
  failSecond = true;
  const { evidence } = await loadRasterArchitecturalEvidence(input);
  assert.equal(evidence.truncated, true);
  assert.equal(evidence.raster.tiling.status, "partial");
  assert.equal(evidence.raster.tiling.reason, "read-failed");
  assert.equal(evidence.raster.tiling.processedWindows, 1);
  assert.equal(evidence.raster.tiling.plannedWindows, 3);
  assert.equal(reads.length, 2);
  assert.equal(uploads.length, 0);
  assert.equal(closed, 1);
  assert.equal(evidence.raster.renderDpi, 300);
});
test("tiled source provenance survives the shared model schema and invalid coverage remains an error", async () => {
  const { evidence } = await loadRasterArchitecturalEvidence(input),
    {
      reconstructBuilding,
    } = require("../lib/drawings/building-reconstruction"),
    { buildingToFloorplan } = require("../lib/drawings/building-floorplan"),
    { floorplanModelSchema } = require("../lib/validation/floorplan");
  const source = {
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
    },
    arch = {
      version: 1,
      elements: [],
      spaces: [],
      openings: [],
      finishZones: [],
      conflicts: [],
      spacePolicy: "include-fixtures",
      qualification: "unqualified",
    };
  const b = reconstructBuilding(source, arch),
    level = buildingToFloorplan(source, { ...arch, building: b }),
    m = floorplanModelSchema.parse(
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
    m.levels[0].reconstruction.source.rasterTiling,
    evidence.raster.tiling,
  );
  m.levels[0].reconstruction.source.rasterTiling.sampledPixels = 1;
  assert.equal(floorplanModelSchema.safeParse(m).success, false);
  evidence.raster.tiling.sampledPixels = 1;
  assert.ok(
    reconstructBuilding(source, arch).issues.some(
      (i) => i.code === "raster-tiling-invalid",
    ),
  );
});
