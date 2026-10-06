require("../scripts/register-ts-node-test")
const assert = require("node:assert/strict")
const test = require("node:test")
const fs = require("node:fs")
const path = require("node:path")
const Module = require("node:module")
const ts = require("typescript")
const { PDFDocument, StandardFonts } = require("pdf-lib")

// Exercise the actual job handlers with an in-memory query client and mocked AI.
// Production internals are exposed only in this isolated compiled test module.
function loadPipeline(vision = async () => ({
  sheet_number: "A2", sheet_title: "FLOOR PLAN", discipline: "S", confidence: "high", notes: [], stated_scale: null,
}), overrides = {}) {
  const images = [], prompts = []
  const filename = path.resolve(__dirname, "../lib/services/drawings-pipeline.ts")
  const mod = new Module(filename, module)
  mod.filename = filename
  mod.paths = module.paths
  mod.require = (id) => {
    if (id in overrides) return overrides[id]
    if (id === "@/lib/services/ai/drawings-vision") return {
      drawingsVisionConfigured: async () => true,
      runDrawingsVisionObject: async args => { prompts.push(args); return vision(args) },
    }
    if (id === "@/lib/services/drawings-sheet-images") return {
      renderSheetWindowImage: async args => { images.push(args); return { data: Buffer.from("image"), mediaType: "image/webp" } },
    }
    if (id.startsWith("@/lib/drawings/")) return require(id)
    if (id.startsWith("@/") || id === "server-only") return {}
    return require(id)
  }
  const source = fs.readFileSync(filename, "utf8") + `\nexport {
    detectPageSheetMetadata, handleEnrichDrawingMetadata, handleProcessDrawingPage,
    enqueueDrawingMetadata, finishMetadataProgress, finishPageProgress, drawingRenderRecipe
  };`
  mod._compile(ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  } }).outputText, filename)
  return { ...mod.exports, images, prompts }
}

function fixture() {
  const proposed = { sheet_number: "A5.1", sheet_title: "DETAILS", discipline: "A" }
  const db = {
    drawing_revisions: [{ id: "revision", org_id: "org", status: "processing", processed_pages: 1, total_pages: 1 }],
    drawing_sheet_versions: [{ id: "version", org_id: "org", drawing_revision_id: "revision", drawing_sheet_id: "sheet",
      page_index: 0, source_hash: "hash", tile_manifest: {Image:{Format:"webp",TileSize:512,Size:{Width:5400,Height:3600}},Levels:14}, tiles_base_path: "org/hash/page-0",
      image_width: 5400, image_height: 3600,
      extracted_metadata: { is_new_sheet: true, proposed, sheet_detection: { vision_pending: true } } }],
    drawing_deleted_pages: [],
    drawing_sheets: [{ id: "sheet", org_id: "org", ...proposed }], outbox: [],
  }
  const field = (row, key) => key.split(/->>?/).reduce((value, part) => value?.[part], row)
  let insertError = null
  const supabase = { rpc: async (name,args) => {
    if(name === "mark_drawing_first_viewable") return {data:null}
    if(name === "update_drawing_render_progress") {
      const revision=db.drawing_revisions.find(r=>r.id===args.p_revision_id && r.org_id===args.p_org_id)
      if(!revision)return {data:null}
      const rendered=db.drawing_sheet_versions.filter(v=>v.org_id===args.p_org_id && v.drawing_revision_id===revision.id && v.tile_manifest?.Image?.Size && !("Partial" in v.tile_manifest)).length
      revision.processed_pages=rendered
      if(rendered>=revision.total_pages && revision.status==='processing')Object.assign(revision,{status:'draft',processing_stage:'ready'})
      return {data:{ready:revision.status==='draft'}}
    }
    if (name === "reserve_drawing_artifact") {
      const donor=db.drawing_sheet_versions.find(v=>v.id!==args.p_version_id && v.tile_manifest)
      return {data:{id:"artifact",state:donor?"active":"building",storage_prefix:"org/artifacts/test",render_output:donor}}
    }
    if (["activate_drawing_artifact","renew_drawing_artifact_writer"].includes(name)) return {data:true}
    throw Error(`Unexpected RPC ${name}`)
  }, from(table) {
    const filters = []
    let operation, one = false, count = false, limit = Infinity
    const q = {
      select: (_cols, options) => { count = !!options?.count; return q },
      eq: (k, v) => { filters.push(r => k.includes("->>") ? String(field(r, k)) === v : field(r, k) === v); return q },
      neq: (k, v) => { filters.push(r => field(r, k) !== v); return q },
      lt: (k, v) => { filters.push(r => field(r, k) < v); return q },
      is: (k, v) => { filters.push(r => (field(r, k) ?? null) === v); return q },
      not: (k, _op, v) => { filters.push(r => (field(r, k) ?? null) !== v); return q },
      contains: (k, v) => { filters.push(r => Object.entries(v).every(([key, value]) => r[k]?.[key] === value)); return q },
      limit: n => { limit = n; return q }, order: () => q,
      maybeSingle: () => { one = true; return q }, single: () => { one = true; return q },
      update: value => { operation = { kind: "update", value }; return q },
      insert: value => { operation = { kind: "insert", value }; return q },
      then: (resolve, reject) => Promise.resolve().then(() => {
        let rows = db[table].filter(r => filters.every(f => f(r))).slice(0, limit)
        if (operation?.kind === "insert") {
          if (insertError) return { data: null, error: { message: insertError } }
          const row = { id: `${table}-${db[table].length}`, ...structuredClone(operation.value) }
          db[table].push(row); rows = [row]
        }
        if (operation?.kind === "update") rows.forEach(r => Object.assign(r, structuredClone(operation.value)))
        return { data: structuredClone(one ? rows[0] ?? null : rows), count: count ? rows.length : null, error: null }
      }).then(resolve, reject),
    }
    return q
  } }
  const payload = { orgId: "org", sheetVersionId: "version", sheetId: "sheet", draftRevisionId: "revision",
    setTitle: "House", pageNumber: 1, pageText: "A2\nSEE SHEET A5.1",
    detected: { sheetNumber: "A5.1", sheetTitle: "DETAILS", discipline: "A", method: "label", confidence: "high", sourceLine: "SEE SHEET A5.1" } }
  const job = { org_id: "org", payload, retry_count: 0 }
  return { db, supabase, job, failInsert: message => { insertError = message } }
}

test("real PDF text extraction keeps title-block coordinates despite a later SEE SHEET reference", async () => {
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([1200, 800])
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  page.drawText("SHEET NUMBER: A2", { x: 960, y: 40, size: 18, font })
  page.drawText("TITLE: FLOOR PLAN", { x: 960, y: 65, size: 12, font })
  page.drawText("SEE SHEET A5.1", { x: 350, y: 400, size: 12, font })
  const mupdf = await import("mupdf")
  const doc = mupdf.Document.openDocument(await pdf.save(), "application/pdf")
  const loaded = doc.loadPage(0)
  try {
    const pipeline = loadPipeline()
    const result = pipeline.detectPageSheetMetadata(loaded, pipeline.extractPageTextLines(loaded).join("\n"), "House", 1)
    assert.equal(result.sheetNumber, "A2")
    assert.equal(result.sheetTitle, "FLOOR PLAN")
    assert.ok(result.sourceBounds.x > .75)
  } finally { loaded.destroy(); doc.destroy() }
})

test("rendered pages open review while enrichment corrects provisional identity", async () => {
  const { db, supabase, job } = fixture()
  const pipeline = loadPipeline()
  await pipeline.finishMetadataProgress(supabase, "revision", "org")
  assert.equal(db.drawing_revisions[0].status, "draft")
  await pipeline.handleEnrichDrawingMetadata(supabase, job)
  const meta = db.drawing_sheet_versions[0].extracted_metadata
  assert.equal(meta.proposed.sheet_number, "A2")
  assert.equal(meta.proposed.sheet_title, "FLOOR PLAN")
  assert.equal(meta.proposed.discipline, "A")
  assert.equal(meta.sheet_detection.vision_pending, false)
  assert.equal(db.drawing_sheets[0].sheet_number, "A2")
  assert.equal(db.drawing_revisions[0].status, "draft")
  assert.equal(pipeline.images.length, 5)
  assert.doesNotMatch(pipeline.prompts[0].prompt, /SEE SHEET A5.1|Current text-based guess/)
})

test("a provider failure retries, then releases review with an explicit error", async () => {
  const { db, supabase, job } = fixture()
  const pipeline = loadPipeline(async () => null)
  await assert.rejects(pipeline.handleEnrichDrawingMetadata(supabase, job), /no result/)
  assert.equal(db.drawing_sheet_versions[0].extracted_metadata.sheet_detection.vision_pending, true)
  assert.equal(db.drawing_revisions[0].status, "processing")
  await assert.rejects(pipeline.handleEnrichDrawingMetadata(supabase, { ...job, retry_count: 2 }), /no result/)
  const detection = db.drawing_sheet_versions[0].extracted_metadata.sheet_detection
  assert.equal(detection.vision_pending, false)
  assert.match(detection.vision_error, /no result/)
  assert.equal(db.drawing_revisions[0].status, "draft")
})

test("published revisions and user-edited sheet rows are preserved", async () => {
  const { db, supabase, job } = fixture()
  const pipeline = loadPipeline()
  db.drawing_sheets[0].sheet_title = "User corrected title"
  await pipeline.handleEnrichDrawingMetadata(supabase, job)
  assert.equal(db.drawing_sheets[0].sheet_title, "User corrected title")
  db.drawing_revisions[0].status = "published"
  const before = structuredClone(db)
  await pipeline.handleEnrichDrawingMetadata(supabase, job)
  assert.deepEqual(db, before)
  assert.equal(pipeline.prompts.length, 1)
})

test("verification never changes an explicitly targeted revision's sheet number", async () => {
  const { db, supabase, job } = fixture()
  db.drawing_sheet_versions[0].extracted_metadata.identity_locked = true
  await loadPipeline().handleEnrichDrawingMetadata(supabase, job)
  assert.equal(db.drawing_sheet_versions[0].extracted_metadata.proposed.sheet_number, "A5.1")
})

test("enqueue is idempotent and does not swallow database errors", async () => {
  const f = fixture(), pipeline = loadPipeline()
  f.failInsert("database unavailable")
  await assert.rejects(pipeline.enqueueDrawingMetadata(f.supabase, f.job.payload), /database unavailable/)
  f.failInsert(null)
  await pipeline.enqueueDrawingMetadata(f.supabase, f.job.payload)
  await pipeline.enqueueDrawingMetadata(f.supabase, f.job.payload)
  assert.equal(f.db.outbox.length, 1)
})

test("retry after completed tiles still queues verification and counts the page only once", async () => {
  const { db, supabase, job } = fixture()
  db.drawing_revisions[0].processed_pages = 0
  const pipeline = loadPipeline()
  const pageJob = { ...job, payload: { ...job.payload, projectId: "project", drawingSetId: "set", sourceFileId: "file",
    sourceHash: "hash", pageIndex: 0, pageCount: 1 } }
  await pipeline.handleProcessDrawingPage(supabase, pageJob)
  await pipeline.handleProcessDrawingPage(supabase, pageJob)
  assert.equal(db.outbox.length, 1)
  assert.equal(db.drawing_revisions[0].processed_pages, 1)
  assert.equal(db.drawing_revisions[0].status, "draft")
})

test("re-uploading identical content reuses tiles and still verifies metadata", async () => {
  const { db, supabase, job } = fixture()
  const donor = { ...structuredClone(db.drawing_sheet_versions[0]), id: "donor", drawing_revision_id: "old-revision" }
  db.drawing_sheet_versions.push(donor)
  db.drawing_sheet_versions[0].tile_manifest = null
  db.drawing_revisions[0].processed_pages = 0
  const pipeline = loadPipeline()
  await pipeline.handleProcessDrawingPage(supabase, { ...job, payload: { ...job.payload,
    projectId: "project", drawingSetId: "set", sourceFileId: "file", sourceHash: "hash", pageIndex: 0, pageCount: 1 } })
  assert.deepEqual(db.drawing_sheet_versions[0].tile_manifest, donor.tile_manifest)
  assert.equal(db.outbox.length, 1)
  assert.equal(db.drawing_revisions[0].status, "draft")
  await pipeline.handleEnrichDrawingMetadata(supabase, job)
  assert.equal(db.drawing_revisions[0].status, "draft")
})

test("fresh PDF renders and queues verification before becoming ready for review", async () => {
  const { db, supabase, job } = fixture()
  const pdf = await PDFDocument.create()
  const page = pdf.addPage([600, 400])
  page.drawText("SHEET NUMBER: A2", { x: 430, y: 25, size: 12 })
  page.drawText("SEE SHEET A5.1", { x: 150, y: 200, size: 10 })
  const objects = new Map([["temp.pdf", Buffer.from(await pdf.save())]])
  const mupdf = await import("mupdf")
  const pipeline = loadPipeline(undefined, {
    "@/lib/services/mupdf-loader": { loadMupdf: async () => mupdf },
    "@/lib/storage/drawings-tiles-storage": {
      downloadTilesObject: async ({ path }) => objects.get(path),
      uploadTilesObject: async ({ path, bytes }) => objects.set(path, bytes),
      deleteTilesObjects: async ({ paths }) => paths.forEach(path => objects.delete(path)),
    },
    "@/lib/storage/drawings-urls": { buildDrawingsTilesBaseUrl: path => `https://tiles.example/${path}` },
  })
  db.drawing_sheet_versions[0].tile_manifest = null
  db.drawing_revisions[0].processed_pages = 0
  await pipeline.handleProcessDrawingPage(supabase, { ...job, payload: { ...job.payload,
    projectId: "project", drawingSetId: "set", sourceFileId: "file", sourceHash: "hash", pageIndex: 0, pageCount: 1,
    pagePdfPath: "temp.pdf" } })
  assert.equal(db.drawing_sheet_versions[0].tile_manifest.Image.Format, "webp")
  assert.ok([...objects.keys()].some(key => key.endsWith("manifest.json")))
  assert.equal(objects.has("temp.pdf"), false)
  assert.equal(db.outbox.length, 1)
  assert.equal(db.drawing_revisions[0].status, "draft")
  await pipeline.handleEnrichDrawingMetadata(supabase, job)
  assert.equal(db.drawing_sheet_versions[0].extracted_metadata.proposed.sheet_number, "A2")
  assert.equal(db.drawing_revisions[0].status, "draft")
})

test("disabling vision between split and render cannot strand the upload", async () => {
  const { db, supabase, job } = fixture()
  const pipeline = loadPipeline(undefined, {
    "@/lib/services/ai/drawings-vision": { drawingsVisionConfigured: async () => false },
  })
  await pipeline.handleProcessDrawingPage(supabase, { ...job, payload: { ...job.payload,
    projectId: "project", drawingSetId: "set", sourceFileId: "file", sourceHash: "hash", pageIndex: 0, pageCount: 1 } })
  assert.equal(db.drawing_revisions[0].status, "draft")
  assert.equal(db.outbox.length, 0)
})
test('supported 300-page replacement executes 299 artifact adoptions and exactly one native render',async()=>{
 const {syntheticPdf}=require('./fixtures/drawing-lifecycle/synthetic.cjs')
 const {fingerprintDrawingPage}=require('../lib/drawings/page-artifact-key')
 const {db,supabase,job}=fixture(),mupdf=await import('mupdf'),objects=new Map(),registry=new Map()
 let downloads=0,activations=0,reused=0,rendered=0
 const originalRpc=supabase.rpc
 supabase.rpc=async(name,args)=>{
  if(name==='reserve_drawing_artifact')return {data:registry.get(args.p_fingerprint)??{id:'new-artifact',state:'building',storage_prefix:'org/artifacts/new'}}
  if(name==='activate_drawing_artifact')activations++
  return originalRpc(name,args)
 }
 const pipeline=loadPipeline(undefined,{
  '@/lib/services/mupdf-loader':{loadMupdf:async()=>mupdf},
  '@/lib/services/ai/drawings-vision':{drawingsVisionConfigured:async()=>false},
  '@/lib/storage/drawings-tiles-storage':{downloadTilesObject:async({path})=>{downloads++;return objects.get(path)},uploadTilesObject:async({path,bytes})=>objects.set(path,bytes),deleteTilesObjects:async({paths})=>paths.forEach(p=>objects.delete(p))},
  '@/lib/storage/drawings-urls':{buildDrawingsTilesBaseUrl:path=>`https://tiles.example/${path}`},
 })
 const recipe=await pipeline.drawingRenderRecipe(),before=mupdf.Document.openDocument(await syntheticPdf(300),'application/pdf'),after=mupdf.Document.openDocument(await syntheticPdf(300,{changedPage:151}),'application/pdf')
 try{
  for(let i=0;i<300;i++){
   const key=fingerprintDrawingPage(mupdf,before,i,recipe);assert.equal(key.supported,true)
   const donor={id:`donor-${i}`,tile_manifest:{Image:{Format:'webp',TileSize:512,Size:{Width:1250,Height:834}},Levels:12},tile_base_url:`https://tiles.example/org/artifacts/old-${i}`,tiles_base_path:`org/artifacts/old-${i}`,tile_manifest_path:`org/artifacts/old-${i}/manifest.json`,tile_levels:12,image_width:1250,image_height:834,thumbnail_url:`https://tiles.example/org/artifacts/old-${i}/thumbnail.webp`,page_text:`A${i+1}`,extracted_metadata:{}}
   registry.set(key.fingerprint,{id:`old-${i}`,state:'active',storage_prefix:donor.tiles_base_path,render_output:donor})
  }
  for(let i=0;i<300;i++){
   const key=fingerprintDrawingPage(mupdf,after,i,recipe);assert.equal(key.supported,true);const temp=`temp-${i}.pdf`;objects.set(temp,key.standalonePdf)
   Object.assign(db.drawing_sheet_versions[0],{page_index:i,tile_manifest:null,artifact_id:null});db.drawing_revisions[0].total_pages=300
   const pageJob={...job,payload:{...job.payload,projectId:'project',drawingSetId:'set',sourceFileId:'file',sourceHash:'new-source',pageIndex:i,pageCount:300,pageFingerprint:key.fingerprint,pagePdfPath:temp}}
   await pipeline.handleProcessDrawingPage(supabase,pageJob)
   reused+=pageJob.lifecycleCounts?.pagesReused??0;rendered+=pageJob.lifecycleCounts?.pagesRendered??0
   assert.equal(db.drawing_sheet_versions[0].tiles_base_path,i===150?'org/artifacts/new':`org/artifacts/old-${i}`)
  }
 }finally{before.destroy();after.destroy()}
 assert.equal(reused,299);assert.equal(rendered,1);assert.equal(downloads,1);assert.equal(activations,1)
})
