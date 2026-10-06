require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  Module = require("node:module"),
  crypto = require("node:crypto"),
  sharp = require("sharp");
let pdfBytes, saved, calls, tileRenders, downloads, closes, captured, listingOverride, listingComplete, cacheReadPaths;
const load = Module._load;
Module._load = function (request, parent, main) {
  if (parent?.filename.endsWith("/lib/services/original-sheet-raster.ts")) {
    if (request === "./mupdf-loader")
      return { loadMupdf: () => import("mupdf") };
    if (request === "@/lib/storage/drawings-pdfs-storage")
      return {
        downloadDrawingPdfObject: async ({ orgId, path }) => {
          assert.equal(orgId, "org-a");
          assert.equal(path, "org-a/original.pdf");
          downloads++;
          return pdfBytes;
        },
      };
  }
  if (parent?.filename.endsWith("/lib/services/architectural-recognition.ts")) {
    if (request === "@/lib/storage/drawings-tiles-storage")
      return {
        downloadTilesObject: async ({ path }) => {
          cacheReadPaths.push(path);
          if (!saved.has(path)) throw Error("missing");
          return saved.get(path);
        },
        uploadTilesObject: async ({ path, bytes }) => saved.set(path, bytes),
        listTilesObjectsBounded: async ({prefix,limit}) => ({objects:listingOverride ?? [...saved].filter(([name])=>name.startsWith(prefix)).slice(0,limit).map(([name,bytes])=>({name,size:bytes.length})),complete:listingComplete}),
      };
    if (request === "@/lib/services/drawings-sheet-images")
      return {
        renderSheetWindowImage: async () => {
          tileRenders++;
          throw Error("Original imagery must not fall back");
        },
      };
    if (request === "@/lib/services/ai/drawings-vision")
      return {
        runDrawingsVisionObject: async (options) => {
          calls++;
          captured = options;
          assert.equal(options.allowFallback, false);
          return { elements: [{ kind: "wall", pathIds: [1] }], openings: [] };
        },
      };
    if (request === "./original-sheet-raster")
      return {
        openOriginalSheetRaster: async (args) => {
          const h = await actual.openOriginalSheetRaster(args),
            close = h.close;
          let closed = false;
          return {
            ...h,
            close() {
              if (!closed) {
                closed = true;
                closes++;
              }
              close();
            },
          };
        },
      };
  }
  return load.call(this, request, parent, main);
};
const actual = require("../lib/services/original-sheet-raster"),
  {
    createArchitecturalRecognizer,
  } = require("../lib/services/architectural-recognition");
Module._load = load;
const supabase = {
  from(table) {
    assert.equal(table, "files");
    const filters = {};
    return {
      select() {
        return this;
      },
      eq(k, v) {
        filters[k] = v;
        return this;
      },
      async maybeSingle() {
        assert.deepEqual(filters, { org_id: "org-a", id: "file-a" });
        return { data: { storage_path: "org-a/original.pdf" }, error: null };
      },
    };
  },
};
const evidence = {
  version: 1,
  paths: [
    {
      id: 1,
      kind: "stroke",
      layer: [],
      tag: {},
      colorSpace: "DeviceGray",
      color: [0],
      width: 1,
      opacity: 1,
      dashes: [],
      clips: [],
      commands: [
        ["M", 0.3, 0.4],
        ["L", 0.7, 0.4],
      ],
    },
  ],
};
const input = {
  supabase,
  orgId: "org-a",
  sheetVersionId: "sheet-a",
  tilesBasePath: "org-a/sheet-a",
  imageWidth: 300,
  imageHeight: 150,
  evidence,
  source: { fileId: "file-a", pageIndex: 0 },
};
const request = {
  region: { x0: 0.201, y0: 0.21, x1: 0.799, y1: 0.81 },
  catalogue: [
    {
      id: 1,
      prior: "unknown",
      kind: "stroke",
      bounds: [0.25, 0.3, 0.75, 0.3],
      commands: [
        ["M", 0.25, 0.3],
        ["L", 0.75, 0.3],
      ],
    },
  ],
};
async function pdf(dpi = 300, large = false) {
  const { PDFDocument } = require("pdf-lib"),
    d = await PDFDocument.create(),
    p = d.addPage(large ? [1800, 900] : [144, 72]);
  if (!large) {
    const image = await sharp({
        create: {
          width: dpi * 2,
          height: dpi,
          channels: 3,
          background: "white",
        },
      })
        .png()
        .toBuffer(),
      embedded = await d.embedPng(image);
    p.drawImage(embedded, { x: 0, y: 0, width: 144, height: 72 });
  }
  return Buffer.from(await d.save());
}
test.beforeEach(async () => {
  pdfBytes = await pdf();
  saved = new Map();
  calls = 0;
  tileRenders = 0;
  downloads = 0;
  closes = 0;
  captured = null;
  listingOverride = null;
  listingComplete = true;
  cacheReadPaths = [];
});
test("original crops retain native detail, rounded registration and source hashes across fresh cache reuse", async () => {
  const r = createArchitecturalRecognizer(input);
  assert.deepEqual(await r.windowBudget(request.region), {
    x: (4094-1e-6) / 600,
    y: (4094-1e-6) / 300,
  });
  const answer = await r(request),
    source = r.sourceImage(request);
  assert.ok(answer);
  assert.equal(source.kind, "original-pdf");
  assert.equal(source.renderDpi, 300);
  assert.equal(source.nativeDensityPreserved, true);
  assert.equal(source.width, 360);
  assert.equal(source.height, 181);
  assert.ok(
    source.width > input.imageWidth * (request.region.x1 - request.region.x0),
  );
  assert.ok(Math.abs(source.sourceRegion.x0 - 0.2) < 1e-10);
  assert.ok(Math.abs(source.sourceRegion.y0 - 0.21) < 1e-10);
  assert.ok(Math.abs(source.sourceRegion.y1 - 244 / 300) < 1e-10);
  assert.equal(
    source.sourceHash,
    crypto.createHash("sha256").update(pdfBytes).digest("hex"),
  );
  assert.equal(
    source.imageSha256,
    crypto.createHash("sha256").update(captured.images[0].data).digest("hex"),
  );
  assert.equal(
    source.annotatedSha256,
    crypto.createHash("sha256").update(captured.images[1].data).digest("hex"),
  );
  await r.close();
  assert.equal(closes, 1);
  const resumed = createArchitecturalRecognizer(input);
  assert.deepEqual(await resumed.cached(request), answer);
  assert.deepEqual(resumed.sourceImage(request), source);
  assert.equal(downloads, 2, "fresh resume reinspects the original PDF hash");
  assert.equal(calls, 1);
  assert.equal(tileRenders, 0);
  await resumed.close();
  assert.equal(closes, 2);
});
test("a changed original cannot reuse classifications attached to measured raster geometry", async () => {
  const hash = crypto.createHash("sha256").update(pdfBytes).digest("hex"),
    bound = {
      ...input,
      evidence: { ...evidence, raster: { sourceHash: hash } },
    };
  const r = createArchitecturalRecognizer(bound);
  assert.ok(await r(request));
  await r.close();
  pdfBytes = await pdf(200);
  const changed = createArchitecturalRecognizer(bound);
  assert.equal(await changed.cached(request), null);
  assert.equal(await changed(request), null);
  assert.equal(calls, 1);
  assert.equal(tileRenders, 0);
  assert.ok(
    changed
      .warnings()
      .some((w) => w.includes("differs from measured geometry")),
  );
  await changed.close();
});
test("corrupt registration cannot turn a persisted answer into a valid source-image hit", async () => {
  const r = createArchitecturalRecognizer(input);
  await r(request);
  await r.close();
  const [key, bytes] = [...saved.entries()][0],
    record = JSON.parse(bytes);
  saved.set(
    key,
    Buffer.from(
      JSON.stringify({
        ...record,
        sourceImage: {
          ...record.sourceImage,
          sourceRegion: { ...record.sourceImage.sourceRegion, x0: 0.3 },
        },
      }),
    ),
  );
  const retry = createArchitecturalRecognizer(input);
  assert.equal(await retry.cached(request), null);
  assert.ok(await retry(request));
  assert.equal(calls, 2);
  await retry.close();
});
test("low-density and oversized original windows stay incomplete without reduction or tile fallback", async () => {
  for (const bytes of [await pdf(100), await pdf(300, true)]) {
    pdfBytes = bytes;
    const r = createArchitecturalRecognizer(input);
    assert.equal(
      await r({ ...request, region: { x0: 0, y0: 0, x1: 1, y1: 1 } }),
      null,
    );
    assert.ok(r.warnings().some((w) => /200 DPI|native image budget/.test(w)));
    await r.close();
  }
  assert.equal(calls, 0);
  assert.equal(tileRenders, 0);
  assert.equal(saved.size, 0);
  assert.equal(closes, 2);
});
test("shared engine closes original handles and preserves image evidence in replay and model reload", async () => {
  const { runAreaEngine } = require("../lib/drawings/area-engine"),
    { createAreaReplay } = require("../lib/drawings/area-replay"),
    { buildingToFloorplan } = require("../lib/drawings/building-floorplan"),
    { floorplanModelSchema } = require("../lib/validation/floorplan");
  const r = createArchitecturalRecognizer(input),
    engineInput = {
      imageWidth: 300,
      imageHeight: 150,
      feetPerImagePx: 0.1,
      evidence,
      textRuns: [],
      segments: [],
      region: { x0: 0, y0: 0, x1: 1, y1: 1 },
      finishPolicy: "include-fixtures",
    };
  const run = await runAreaEngine(engineInput, {
    wholeSheet: true,
    recognize: r,
    maxRecognitionWindows: 1,
  });
  assert.equal(closes, 1);
  assert.equal(run.observations.length, 1);
  assert.equal(run.observations[0].sourceImage.kind, "original-pdf");
  const replay = JSON.parse(
    JSON.stringify(
      createAreaReplay(
        { ...engineInput, visualObservations: run.observations },
        true,
        {},
        run.recognition,
      ),
    ),
  );
  assert.deepEqual(
    replay.input.visualObservations[0].sourceImage,
    run.observations[0].sourceImage,
  );
  const level = buildingToFloorplan(
      {
        ...engineInput,
        sheetVersionId: "00000000-0000-4000-8000-000000000001",
        sheetNumber: "A1",
        sheetTitle: "Floor",
        name: "Floor",
        order: 0,
      },
      run.detection.architecture,
    ),
    model = floorplanModelSchema.parse(
      JSON.parse(
        JSON.stringify({
          version: 1,
          units: "feet",
          levels: [level],
          correctionCount: 0,
        }),
      ),
    );
  assert.equal(
    model.levels[0].reconstruction.source.recognitionImages[0].image.sourceHash,
    run.observations[0].sourceImage.sourceHash,
  );
});

test("a source above the density limit is not silently reduced or sent to the provider", async () => {
  pdfBytes = await pdf(700);
  const r = createArchitecturalRecognizer(input);
  assert.equal(await r(request), null);
  assert.ok(r.warnings().some((w) => /600 DPI recognition limit/.test(w)));
  assert.equal(calls, 0);
  assert.equal(tileRenders, 0);
  assert.equal(saved.size, 0);
  await r.close();
  assert.equal(closes, 1);
});

test("engine failure still disposes an opened original source", async () => {
  const { runAreaEngine } = require("../lib/drawings/area-engine");
  const r = createArchitecturalRecognizer(input);
  await r.cached(request);
  const broken = {};
  Object.defineProperty(broken, "textRuns", {
    enumerable: true,
    get() {
      throw Error("broken engine input");
    },
  });
  await assert.rejects(
    runAreaEngine(broken, { wholeSheet: true, recognize: r }),
    /broken engine input/,
  );
  assert.equal(closes, 1);
  assert.equal(await r(request), null);
  assert.equal(calls, 0);
  assert.equal(downloads, 1);
});

test("density metadata cannot claim a capped or anisotropic image preserved every native sample", () => {
  const {
    preservesNativeRecognitionDensity,
  } = require("../lib/drawings/recognition-image-source");
  const sample = {
    kind: "native-raster",
    minimumSourceDpi: 700,
    maximumSourceDpi: 700,
  };
  assert.equal(preservesNativeRecognitionDensity(sample, 600), false);
  assert.equal(
    preservesNativeRecognitionDensity(
      { ...sample, minimumSourceDpi: 300, maximumSourceDpi: 600 },
      300,
    ),
    false,
  );
  assert.equal(
    preservesNativeRecognitionDensity(
      { ...sample, minimumSourceDpi: 300, maximumSourceDpi: 300 },
      300,
    ),
    true,
  );
});

test('original pixel capacity admits a full long path into a registered supplemental crop',async()=>{
 // Provider output is stubbed: this checks source framing, not meaning/accuracy.
 const {runAreaEngine}=require('../lib/drawings/area-engine'),r=createArchitecturalRecognizer(input);
 const run=await runAreaEngine({imageWidth:300,imageHeight:150,feetPerImagePx:2/3,evidence,textRuns:[],segments:[],region:{x0:0,y0:0,x1:1,y1:1},finishPolicy:'include-fixtures'},{wholeSheet:true,recognize:r,maxRecognitionWindows:1});
 assert.equal(run.observations.length,1);
 assert.deepEqual(run.observations[0].suppliedPathIds,[1]);
 const image=run.observations[0].sourceImage;
 assert.ok(image.requestedRegion.x0<=.3&&image.requestedRegion.x1>=.7);
 assert.ok(image.requestedRegion.x1-image.requestedRegion.x0>=.4-1e-10);
 assert.equal(image.renderDpi,300);assert.equal(image.nativeDensityPreserved,true);
 assert.equal(run.recognitionCoverage.unseenPaths,0);assert.equal(calls,1);assert.equal(downloads,1);assert.equal(closes,1);assert.equal(tileRenders,0);
});

test('advertised source capacity renders at off-grid positions without rounding rejection or density loss',async()=>{
 const h=await actual.openOriginalSheetRaster({supabase,orgId:'org-a',fileId:'file-a',pageIndex:0,imageWidth:600,imageHeight:300,region:{x0:0,y0:0,x1:1,y1:1}})
 try{
  const capacity=h.recognitionWindowBudget({x0:0,y0:0,x1:1,y1:1},32)
  for(const x0 of [.18,.26560186393319307,.3409259259259259,.675]){
   const crop=await h.renderSourceWindow({x0,y0:.27257102457077476,x1:x0+capacity.x,y1:.27257102457077476+capacity.y},32),m=await sharp(crop.data).metadata()
   assert.ok(m.width<=32&&m.height<=32);assert.equal(crop.renderDpi,300);assert.equal(crop.sampling.kind,'native-raster')
  }
 }finally{h.close()}
 assert.equal(downloads,1)
})

test('append-only source facts retain original image provenance across a fresh extraction and source handle',async()=>{
 const bounded={...input,feetPerImagePx:.02},r=createArchitecturalRecognizer(bounded);await r(request);const image=r.sourceImage(request);await r.close();
 assert.equal([...saved.keys()].filter(k=>k.includes('/source-facts-')).length,1);
 const e=JSON.parse(JSON.stringify(evidence));e.extractionProfile='new-source-extraction';e.paths[0].id=91;
 const resumed=createArchitecturalRecognizer({...bounded,evidence:e}),prior=await resumed.prior(request.region);assert.equal(prior.length,1);assert.deepEqual(prior[0].suppliedPathIds,[91]);assert.deepEqual(prior[0].sourceImage,image);assert.notEqual(prior[0].sourceReuse.currentEvidenceHash,prior[0].sourceReuse.priorEvidenceHash);assert.equal(calls,1);await resumed.close();assert.equal(downloads,2);assert.equal(closes,2);assert.equal(tileRenders,0);
});
test('different sheet, calibration or original PDF identity cannot read the previous source fact namespace',async()=>{
 const bounded={...input,feetPerImagePx:.02},r=createArchitecturalRecognizer(bounded);await r(request);await r.close();
 for(const change of [{sheetVersionId:'sheet-b'},{feetPerImagePx:.03},{imageWidth:600,imageHeight:300}]){const other=createArchitecturalRecognizer({...bounded,...change});assert.deepEqual(await other.prior(request.region),[]);await other.close();}
 pdfBytes=await pdf(301);const replaced=createArchitecturalRecognizer(bounded);assert.deepEqual(await replaced.prior(request.region),[]);await replaced.close();assert.equal(calls,1);
});
test('corrupt or incompletely readable fact history cannot hide opposing past decisions',async()=>{
 const bounded={...input,feetPerImagePx:.02},r=createArchitecturalRecognizer(bounded);await r(request);await r.close();const [key,bytes]=[...saved].find(([k])=>k.includes('/source-facts-')),record=JSON.parse(bytes);
 saved.set(key,Buffer.from(JSON.stringify({...record,paths:[{...record.paths[0],kind:'door'}]})));
 const corrupt=createArchitecturalRecognizer(bounded);assert.deepEqual(await corrupt.prior(request.region),[]);assert.ok(corrupt.warnings().some(w=>w.includes('provenance')));await corrupt.close();
 saved.set(key,bytes);listingOverride=[{name:key,size:bytes.length},{name:key.replace(/fact-[a-f0-9]+/,'fact-'+ 'e'.repeat(64)),size:100}];const incomplete=createArchitecturalRecognizer(bounded);assert.deepEqual(await incomplete.prior(request.region),[]);await incomplete.close();assert.equal(calls,1);
});
test('bounded history overflow and misleading byte metadata abstain from source reuse',async()=>{
 const bounded={...input,feetPerImagePx:.02},r=createArchitecturalRecognizer(bounded);await r(request);await r.close();const [key,bytes]=[...saved].find(([k])=>k.includes('/source-facts-'));
 listingOverride=Array.from({length:129},()=>({name:key,size:bytes.length}));const overflow=createArchitecturalRecognizer(bounded);assert.deepEqual(await overflow.prior(request.region),[]);assert.ok(overflow.warnings().some(w=>w.includes('budget')));await overflow.close();
 listingOverride=[{name:key,size:1}];saved.set(key,Buffer.alloc(256*1024+1));const huge=createArchitecturalRecognizer(bounded);assert.deepEqual(await huge.prior(request.region),[]);assert.ok(huge.warnings().some(w=>w.includes('budget')));await huge.close();assert.equal(calls,1);
});

test('a short truncated listing never certifies complete vote history or a missing exact request',async()=>{
 const bounded={...input,feetPerImagePx:.02},r=createArchitecturalRecognizer(bounded);const answer=await r(request);await r.close();listingComplete=false;listingOverride=[];
 const resumed=createArchitecturalRecognizer(bounded);assert.deepEqual(await resumed.prior(request.region),[]);assert.ok(resumed.warnings().some(w=>w.includes('complete-read')));assert.deepEqual(await resumed.cached(request),answer);assert.ok(cacheReadPaths.some(p=>p.includes('/classification-')));await resumed.close();assert.equal(calls,1);
});
test('complete empty request listings avoid repeated remote misses without consuming provider calls',async()=>{
 const r=createArchitecturalRecognizer(input);for(let i=0;i<4;i++)assert.equal(await r.cached({...request,catalogue:[{...request.catalogue[0],id:i+1}]}),null);assert.equal(cacheReadPaths.length,0);assert.equal(calls,0);await r.close();
});
