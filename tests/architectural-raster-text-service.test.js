require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  Module = require("node:module"),
  sharp = require("sharp");
const { RASTER_TEXT_PROFILE } = require("../lib/drawings/raster-text");
const {
  RASTER_EXTRACTION_PROFILE,
} = require("../lib/drawings/raster-evidence");
const region = { x0: 0, y0: 0, x1: 1, y1: 1 },
  scope = "00000000-0000-4000-8000-000000000001/sheet";
let cached,
  renders,
  ocrCalls,
  uploads,
  status,
  originalOpens,
  originalCloses,
  originalRenders,
  renderFailure;
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
  tilesBasePath: scope,
  imageWidth: 100,
  imageHeight: 100,
  feetPerImagePx: 0.1,
  region,
};
const originalLoad = Module._load;
Module._load = function (request, parent, main) {
  if (parent?.filename.endsWith("/lib/services/architectural-raster.ts")) {
    if (request === "./original-sheet-raster")
      return {
        openOriginalSheetRaster: async (options) => {
          assert.equal(options.orgId, "org-a");
          assert.equal(options.fileId, "file-a");
          assert.equal(options.pageIndex, 0);
          originalOpens++;
          return {
            sampling,
            sourceHash: "a".repeat(64),
            imageWidth: 200,
            imageHeight: 200,
            close: () => originalCloses++,
            renderWindow: async () => {
              originalRenders++;
              if (renderFailure) throw Error("Original render failed");
              return {
                data: await sharp({
                  create: {
                    width: 100,
                    height: 100,
                    channels: 3,
                    background: "white",
                  },
                })
                  .png()
                  .toBuffer(),
                sourceRegion: region,
                mediaType: "image/png",
                renderScale: 100 / 72,
              };
            },
          };
        },
      };
    if (request === "@/lib/storage/drawings-tiles-storage")
      return {
        downloadTilesObject: async ({ path }) => {
          assert.ok(path.startsWith(scope + "/architecture/"));
          if (!cached) throw Error("No derivative");
          return Buffer.from(JSON.stringify(cached));
        },
        uploadTilesObject: async (value) => uploads.push(value),
      };
    if (request === "./drawings-sheet-images")
      return {
        renderSheetWindowImage: async (options) => {
          renders++;
          assert.equal(options.requireComplete, true);
          assert.equal(options.lossless, true);
          return {
            data: await sharp({
              create: {
                width: 100,
                height: 100,
                channels: 3,
                background: "#ffffff",
              },
            })
              .png()
              .toBuffer(),
            mediaType: "image/png",
            sourceRegion: region,
          };
        },
      };
    if (request === "./local-raster-text")
      return {
        loadLocalRasterText: async (options) => {
          ocrCalls++;
          assert.equal(options.tilesBasePath, scope);
          return {
            profile: RASTER_TEXT_PROFILE,
            status,
            runs: [
              {
                text: "BEDROOM",
                x: 0.2,
                y: 0.2,
                w: 0.1,
                h: 0.02,
                ocr: { profile: RASTER_TEXT_PROFILE, confidence: 90 },
              },
            ],
            windows: 1,
            warnings: [],
            source: options.original
              ? {
                  kind: "original-pdf",
                  hash: options.original.sourceHash,
                  sampling: options.original.sampling,
                }
              : { kind: "stored-tiles" },
          };
        },
      };
  }
  return originalLoad.call(this, request, parent, main);
};
const {
  loadRasterArchitecturalEvidence,
} = require("../lib/services/architectural-raster");
Module._load = originalLoad;
test.beforeEach(() => {
  cached = null;
  renders = 0;
  ocrCalls = 0;
  uploads = [];
  status = "processed";
  originalOpens = 0;
  originalCloses = 0;
  originalRenders = 0;
  renderFailure = false;
});

test("both scan contours and text use one original source handle, preserve density separately from render sampling, and reuse valid derivatives", async () => {
  const sourceInput = {
    ...input,
    source: { orgId: "org-a", fileId: "file-a", pageIndex: 0 },
  };
  const result = await loadRasterArchitecturalEvidence(sourceInput);
  assert.equal(renders, 0);
  assert.equal(originalOpens, 1);
  assert.equal(originalRenders, 1);
  assert.equal(originalCloses, 1);
  assert.equal(result.evidence.raster.sourceSampling.minimumSourceDpi, 300);
  assert.equal(result.evidence.raster.renderDpi, 100);
  assert.equal(result.evidence.raster.sourceHash, "a".repeat(64));
  assert.ok(
    result.evidence.rasterText.warnings.some((w) => /reduced to 100/.test(w)),
  );
  cached = JSON.parse(uploads[0].bytes);
  await loadRasterArchitecturalEvidence(sourceInput);
  assert.equal(originalOpens, 1);
  cached.rasterText.source.hash = "b".repeat(64);
  await loadRasterArchitecturalEvidence(sourceInput);
  assert.equal(originalOpens, 2);
  assert.equal(originalCloses, 2);
});
test("original source handles close on rendering failure and failed derivatives are not persisted", async () => {
  renderFailure = true;
  await assert.rejects(
    loadRasterArchitecturalEvidence({
      ...input,
      source: { orgId: "org-a", fileId: "file-a", pageIndex: 0 },
    }),
    /render failed/,
  );
  assert.equal(originalCloses, 1);
  assert.equal(uploads.length, 0);
  assert.equal(renders, 0);
});

test("old contour caches are refreshed with shared OCR evidence, and complete derivatives can be reused", async () => {
  cached = {
    version: 1,
    extractionProfile: RASTER_EXTRACTION_PROFILE,
    raster: {
      width: 100,
      height: 100,
      feetPerPixel: 0.1,
      threshold: 140,
      maximumDeviationPixels: 0.8,
      region,
    },
    paths: [],
    truncated: false,
  };
  const result = await loadRasterArchitecturalEvidence(input);
  assert.equal(renders, 1);
  assert.equal(ocrCalls, 1);
  assert.equal(uploads.length, 1);
  assert.equal(result.evidence.rasterText.runs[0].text, "BEDROOM");
  assert.deepEqual(
    JSON.parse(result.bytes).rasterText,
    result.evidence.rasterText,
  );
  assert.ok(uploads[0].path.startsWith(scope + "/architecture/"));
  cached = JSON.parse(uploads[0].bytes);
  await loadRasterArchitecturalEvidence(input);
  assert.equal(renders, 1);
  assert.equal(ocrCalls, 1);
  assert.equal(uploads.length, 1);
});

test("partial OCR and corrupt cached text remain retryable instead of being permanent successes", async () => {
  status = "partial";
  const first = await loadRasterArchitecturalEvidence(input);
  assert.equal(first.evidence.rasterText.status, "partial");
  assert.equal(uploads.length, 0);
  await loadRasterArchitecturalEvidence(input);
  assert.equal(renders, 2);
  assert.equal(ocrCalls, 2);
  cached = {
    ...first.evidence,
    rasterText: {
      ...first.evidence.rasterText,
      status: "processed",
      runs: [{ text: "FAKE", x: Infinity, y: 0, w: 0.1, h: 0.1 }],
    },
  };
  status = "processed";
  const refreshed = await loadRasterArchitecturalEvidence(input);
  assert.equal(refreshed.evidence.rasterText.runs[0].text, "BEDROOM");
  assert.equal(renders, 3);
  assert.equal(uploads.length, 1);
});

test("a cached derivative with omitted geometry is refreshed despite successful OCR", async () => {
  const first = await loadRasterArchitecturalEvidence(input);
  cached = { ...first.evidence, truncated: true };
  await loadRasterArchitecturalEvidence(input);
  assert.equal(renders, 2);
  assert.equal(ocrCalls, 2);
  assert.equal(uploads.length, 2);
});
