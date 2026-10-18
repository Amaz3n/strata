require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  Module = require("node:module"),
  sharp = require("sharp");
let pdfBytes,
  queries,
  downloads,
  missing = false;
const realLoad = Module._load;
Module._load = function (request, parent, main) {
  if (
    parent?.filename.endsWith("/lib/services/original-sheet-raster.ts") &&
    request === "./mupdf-loader"
  )
    return { loadMupdf: () => import("mupdf") };
  if (
    parent?.filename.endsWith("/lib/services/original-sheet-raster.ts") &&
    request === "@/lib/storage/drawings-pdfs-storage"
  )
    return {
      downloadDrawingPdfObject: async ({ orgId, path }) => {
        assert.equal(orgId, "org-a");
        assert.equal(path, "org-a/private-original.pdf");
        downloads++;
        return pdfBytes;
      },
    };
  return realLoad.call(this, request, parent, main);
};
const {
  openOriginalSheetRaster,
} = require("../lib/services/original-sheet-raster");
Module._load = realLoad;
const supabase = {
  from(table) {
    assert.equal(table, "files");
    const filters = {};
    return {
      select(columns) {
        assert.equal(columns, "storage_path");
        return this;
      },
      eq(k, v) {
        filters[k] = v;
        return this;
      },
      async maybeSingle() {
        queries.push(filters);
        return {
          data: missing ? null : { storage_path: "org-a/private-original.pdf" },
          error: null,
        };
      },
    };
  },
};
const input = {
  supabase,
  orgId: "org-a",
  fileId: "file-a",
  pageIndex: 0,
  imageWidth: 300,
  imageHeight: 150,
  region: { x0: 0.2, y0: 0.2, x1: 0.8, y1: 0.8 },
};
test.beforeEach(async () => {
  const { PDFDocument } = require("pdf-lib"),
    pdf = await PDFDocument.create(),
    page = pdf.addPage([144, 72]);
  const pixels = await sharp(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="300"><rect width="600" height="300" fill="white"/><text x="160" y="150" font-family="Arial" font-size="30" fill="black">BEDROOM</text></svg>',
      ),
    )
      .png()
      .toBuffer(),
    embedded = await pdf.embedPng(pixels);
  page.drawImage(embedded, { x: 0, y: 0, width: 144, height: 72 });
  pdfBytes = Buffer.from(await pdf.save());
  queries = [];
  downloads = 0;
  missing = false;
});
test("source lookup is organization scoped and regional rendering keeps native density and actual frame", async () => {
  const source = await openOriginalSheetRaster(input);
  assert.deepEqual(queries, [{ org_id: "org-a", id: "file-a" }]);
  assert.equal(downloads, 1);
  assert.equal(source.imageWidth, 600);
  assert.equal(source.imageHeight, 300);
  assert.equal(source.sampling.minimumSourceDpi, 300);
  assert.match(source.sourceHash, /^[a-f0-9]{64}$/);
  const crop = await source.renderWindow(input.region, 2050),
    metadata = await sharp(crop.data).metadata();
  assert.ok(metadata.width < source.imageWidth);
  assert.ok(crop.sourceRegion.x0 <= input.region.x0);
  assert.ok(crop.sourceRegion.x1 >= input.region.x1);
  assert.equal(crop.renderScale, 300 / 72);
  source.close();
  source.close();
  await assert.rejects(source.renderWindow(input.region, 2050), /closed/);
});
test("missing originals fail before download and cannot silently use another organization", async () => {
  missing = true;
  await assert.rejects(openOriginalSheetRaster(input), /unavailable/);
  assert.equal(downloads, 0);
  assert.deepEqual(queries, [{ org_id: "org-a", id: "file-a" }]);
  await assert.rejects(
    openOriginalSheetRaster({ ...input, orgId: "" }),
    /identity/,
  );
});
test("stale page indices and mismatched drawing frames fail rather than registering geometry to the wrong source", async () => {
  await assert.rejects(
    openOriginalSheetRaster({ ...input, pageIndex: 1 }),
    /no longer exists/,
  );
  await assert.rejects(
    openOriginalSheetRaster({ ...input, imageHeight: 300 }),
    /frames disagree/,
  );
});

test("shared OCR reads original pixels instead of the lower-resolution display frame", async () => {
  const { loadLocalRasterText } = require("../lib/services/local-raster-text");
  const source = await openOriginalSheetRaster(input);
  try {
    const text = await loadLocalRasterText({
      supabase,
      tilesBasePath: "org-a/sheet",
      imageWidth: 300,
      imageHeight: 150,
      region: input.region,
      original: source,
    });
    assert.equal(text.status, "processed");
    assert.equal(text.source.kind, "original-pdf");
    assert.equal(text.source.hash, source.sourceHash);
    assert.equal(text.source.sampling.minimumSourceDpi, 300);
    assert.ok(
      text.runs.some((r) => r.text === "BEDROOM" && r.ocr.confidence >= 70),
    );
    assert.equal(downloads, 1);
  } finally {
    source.close();
  }
});

test('expanded context is independently sampled and cannot inherit a native-density claim outside the covering scan',async()=>{
 const {PDFDocument}=require('pdf-lib'),pdf=await PDFDocument.create(),page=pdf.addPage([144,72]);
 const pixels=await sharp({create:{width:300,height:300,channels:3,background:'white'}}).png().toBuffer(),embedded=await pdf.embedPng(pixels);
 page.drawImage(embedded,{x:0,y:0,width:72,height:72});pdfBytes=Buffer.from(await pdf.save());
 const region={x0:.1,y0:.2,x1:.4,y1:.8},source=await openOriginalSheetRaster({...input,region});
 assert.equal(source.sampling.kind,'native-raster');assert.equal(source.inspectSampling(region).minimumSourceDpi,300);
 assert.equal(source.inspectSampling({...region,x1:.7}).kind,'unverified');assert.equal(source.sampling.kind,'native-raster');assert.equal(downloads,1);
 source.close();assert.throws(()=>source.inspectSampling(region),/closed/);
});
