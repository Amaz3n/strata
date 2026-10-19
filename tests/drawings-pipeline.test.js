const assert = require("node:assert/strict")
const { beforeEach, describe, test } = require("node:test")
const { PDFDocument, StandardFonts } = require("pdf-lib")

const { createFakeSupabase } = require("./support/fake-supabase")
const { freshRequire, stubModule } = require("./support/modules")
const {
  createTileStorage,
  createVisionProvider,
  failInserts,
  stubMupdfLoader,
  stubTileStorage,
  stubVisionProvider,
} = require("./support/drawings")
const { syntheticPdf } = require("./fixtures/drawing-lifecycle/synthetic.cjs")

const { DRAWING_LANES, DRAWING_LANE_JOBS } = require("../lib/drawings/processing-lanes")

process.env.DRAWINGS_TILES_BASE_URL = "https://tiles.test"

// ---------------------------------------------------------------------------
// Boundaries: the database (including the outbox and the drawing RPCs), tile
// and PDF storage, the vision provider, and the runner trigger. Every test
// enqueues outbox jobs and drives them through runDrawingsPipeline, the way
// the cron worker does.
// ---------------------------------------------------------------------------

const database = { client: null }
stubModule("lib/supabase/server.ts", {
  createServiceSupabaseClient: () => database.client,
  createDrawingWorkerSupabaseClient: () => database.client,
})
const storage = stubTileStorage(createTileStorage())
const pdfs = new Map()
stubModule("lib/storage/drawings-pdfs-storage.ts", {
  downloadDrawingPdfObject: async ({ path }) => pdfs.get(path),
})
const TITLE_BLOCK_A2 = {
  number_evidence: { text: "A2", location: "bottom right", is_title_block: true },
  sheet_number: "A2",
  sheet_title: "FLOOR PLAN",
  // Contradicts the number it read; the number decides the discipline.
  discipline: "S",
  confidence: "high",
  notes: [],
  stated_scale: null,
}
const vision = stubVisionProvider(createVisionProvider(TITLE_BLOCK_A2))
const sheetImages = []
stubModule("lib/services/drawings-sheet-images.ts", {
  async renderSheetWindowImage(options) {
    sheetImages.push(options)
    return { data: Buffer.from("image"), mediaType: "image/webp" }
  },
})
const kicked = []
stubModule("lib/services/drawings-pipeline-trigger.ts", {
  async triggerDrawingsPipeline(lane) {
    kicked.push(lane)
    return { triggered: true }
  },
})
stubMupdfLoader()

const pipeline = freshRequire("lib/services/drawings-pipeline.ts")
const { DRAWING_PIPELINE_JOB_TYPES, runDrawingsPipeline } = pipeline

// ---------------------------------------------------------------------------
// The database: rows plus the RPCs the pipeline calls, behaving as their SQL does.
// ---------------------------------------------------------------------------

const COMPLETE_MANIFEST = { Image: { Format: "webp", TileSize: 512, Size: { Width: 5400, Height: 3600 } }, Levels: 14 }
const PROVISIONAL = { sheet_number: "A5.1", sheet_title: "DETAILS", discipline: "A" }

const runner = { claims: [], artifacts: new Map(), activations: 0, nextArtifact: 0 }

function claimJobs({ job_types, limit_value }, store) {
  runner.claims.push({ jobTypes: job_types, limit: limit_value })
  const now = new Date().toISOString()
  // `status` defaults to pending in the table; the service inserts jobs without it.
  const jobs = store.outbox
    .filter((job) => (job.status ?? "pending") === "pending" && job_types.includes(job.job_type) && job.run_at <= now)
    .slice(0, limit_value)
  for (const job of jobs) job.status = "processing"
  const data = jobs.map((job) => ({
    job_id: job.id,
    org_id: job.org_id,
    job_type: job.job_type,
    payload: structuredClone(job.payload),
    retry_count: job.retry_count ?? 0,
    claim_token: "claim",
  }))
  return { data, error: null }
}

function transitionLease({ p_id, p_action, p_error }, store) {
  const job = store.outbox.find((row) => row.id === p_id)
  if (p_action === "complete") job.status = "completed"
  if (p_action === "release") job.status = "pending"
  if (p_action === "retry") {
    job.retry_count = (job.retry_count ?? 0) + 1
    job.last_error = p_error
    job.status = job.retry_count >= 3 ? "failed" : "pending"
    job.run_at = "9999-01-01T00:00:00.000Z"
  }
  return { data: true, error: null }
}

function updateRenderProgress({ p_org_id, p_revision_id }, store) {
  const revision = store.drawing_revisions.find((row) => row.id === p_revision_id && row.org_id === p_org_id)
  if (!revision) return { data: null, error: null }
  revision.processed_pages = store.drawing_sheet_versions.filter(
    (version) =>
      version.org_id === p_org_id &&
      version.drawing_revision_id === revision.id &&
      version.tile_manifest?.Image?.Size &&
      !("Partial" in version.tile_manifest),
  ).length
  if (revision.processed_pages >= revision.total_pages && revision.status === "processing") {
    Object.assign(revision, { status: "draft", processing_stage: "ready" })
  }
  return { data: { ready: revision.status === "draft" }, error: null }
}

function reserveArtifact({ p_fingerprint }) {
  if (!runner.artifacts.has(p_fingerprint)) {
    runner.nextArtifact += 1
    runner.artifacts.set(p_fingerprint, {
      id: `artifact-${runner.nextArtifact}`,
      state: "building",
      storage_prefix: `org/artifacts/${runner.nextArtifact}`,
    })
  }
  return { data: structuredClone(runner.artifacts.get(p_fingerprint)), error: null }
}

function activateArtifact({ p_artifact_id, p_version_id }, store) {
  runner.activations += 1
  const artifact = [...runner.artifacts.values()].find((entry) => entry.id === p_artifact_id)
  artifact.state = "active"
  artifact.render_output = structuredClone(store.drawing_sheet_versions.find((row) => row.id === p_version_id))
  return { data: true, error: null }
}

function compareExchangeMetadata({ p_org_id, p_version_id, p_expected, p_next }, store) {
  const row = store.drawing_sheet_versions.find((version) => version.id === p_version_id && version.org_id === p_org_id)
  if (!row || JSON.stringify(row.extracted_metadata) !== JSON.stringify(p_expected)) return { data: false, error: null }
  row.extracted_metadata = structuredClone(p_next)
  return { data: true, error: null }
}

/** Registration creates the page's sheet and draft version; emitting queues its render job once. */
function registerSplitBatch({ p_org_id, p_revision_id, p_pages }, store) {
  const data = p_pages.map((page) => {
    const sheetId = `sheet-${page.pageIndex}`
    const versionId = `version-${page.pageIndex}`
    if (!store.drawing_sheet_versions.some((row) => row.id === versionId)) {
      store.drawing_sheets.push({ id: sheetId, org_id: p_org_id, project_id: page.projectId, ...page.metadata.proposed })
      store.drawing_sheet_versions.push({
        id: versionId,
        org_id: p_org_id,
        drawing_revision_id: p_revision_id,
        drawing_sheet_id: sheetId,
        page_index: page.pageIndex,
        source_hash: page.sourceHash,
        tile_manifest: null,
        tiles_base_path: null,
        artifact_id: null,
        page_text: page.pageText,
        extracted_metadata: { ...structuredClone(page.metadata), is_new_sheet: true },
      })
    }
    const emitted = store.drawing_split_pages.some((row) => row.revision_id === p_revision_id && row.page_index === page.pageIndex)
    return {
      id: `intent-${page.pageIndex}`,
      pageIndex: page.pageIndex,
      state: emitted ? "emitted" : "reserved",
      storage_prefix: `org/split/${page.pageIndex}`,
      sheetId,
      versionId,
    }
  })
  return { data, error: null }
}

function emitSplitPage({ p_org_id, p_payload }, store) {
  store.drawing_split_pages.push({
    org_id: p_org_id,
    revision_id: p_payload.draftRevisionId,
    source_hash: p_payload.sourceHash,
    page_index: p_payload.pageIndex,
    state: "emitted",
  })
  enqueue("process_drawing_page", p_payload, store)
  return { data: true, error: null }
}

const ok = () => ({ data: null, error: null })
const RPCS = {
  recover_drawing_job_leases: ok,
  claim_drawing_jobs: claimJobs,
  transition_drawing_job_lease: transitionLease,
  mark_drawing_first_viewable: ok,
  update_drawing_render_progress: updateRenderProgress,
  reserve_drawing_artifact: reserveArtifact,
  renew_drawing_artifact_writer: () => ({ data: true, error: null }),
  activate_drawing_artifact: activateArtifact,
  compare_exchange_drawing_metadata: compareExchangeMetadata,
  register_drawing_split_batch: registerSplitBatch,
  emit_drawing_split_page: emitSplitPage,
}

/** One page of a draft upload, already rendered, still waiting on title-block verification. */
function seed() {
  database.client = createFakeSupabase(
    {
      drawing_revisions: [{ id: "revision", org_id: "org", status: "processing", processed_pages: 1, total_pages: 1 }],
      drawing_sheet_versions: [
        {
          id: "version",
          org_id: "org",
          drawing_revision_id: "revision",
          drawing_sheet_id: "sheet",
          page_index: 0,
          source_hash: "hash",
          tile_manifest: COMPLETE_MANIFEST,
          tiles_base_path: "org/hash/page-0",
          image_width: 5400,
          image_height: 3600,
          artifact_id: null,
          page_text: null,
          extracted_metadata: { is_new_sheet: true, proposed: PROVISIONAL, sheet_detection: { vision_pending: true } },
        },
      ],
      drawing_sheets: [{ id: "sheet", org_id: "org", project_id: "project", ...PROVISIONAL }],
      drawing_deleted_pages: [],
      drawing_split_pages: [],
      files: [{ id: "file", org_id: "org", storage_path: "org/source.pdf" }],
      outbox: [],
    },
    RPCS,
  )
}

let jobIds = 0
function enqueue(jobType, payload, store = database.client.store) {
  jobIds += 1
  const job = { id: jobIds, org_id: "org", job_type: jobType, payload, status: "pending", retry_count: 0, run_at: new Date(0).toISOString() }
  store.outbox.push(job)
  return job
}

const run = (options = {}) => runDrawingsPipeline({ deadlineMs: Date.now() + 60_000, ...options })

const DETECTED_FROM_TEXT = {
  sheetNumber: "A5.1",
  sheetTitle: "DETAILS",
  discipline: "A",
  method: "label",
  confidence: "high",
  sourceLine: "SEE SHEET A5.1",
}
const enrichPayload = (overrides = {}) => ({
  orgId: "org",
  sheetVersionId: "version",
  sheetId: "sheet",
  draftRevisionId: "revision",
  setTitle: "House",
  pageNumber: 1,
  pageText: "A2\nSEE SHEET A5.1",
  detected: DETECTED_FROM_TEXT,
  ...overrides,
})
const pagePayload = (overrides = {}) => ({
  ...enrichPayload(),
  projectId: "project",
  drawingSetId: "set",
  sourceFileId: "file",
  sourceHash: "hash",
  pageIndex: 0,
  pageCount: 1,
  ...overrides,
})

const db = () => database.client.store
const version = (id = "version") => db().drawing_sheet_versions.find((row) => row.id === id)
const metadata = () => version().extracted_metadata
const revision = () => db().drawing_revisions[0]
const jobsOf = (jobType) => db().outbox.filter((job) => job.job_type === jobType)

beforeEach(() => {
  seed()
  storage.objects.clear()
  storage.deletes.length = 0
  pdfs.clear()
  vision.calls.length = 0
  vision.answer = TITLE_BLOCK_A2
  vision.configured = true
  sheetImages.length = 0
  kicked.length = 0
  Object.assign(runner, { claims: [], artifacts: new Map(), activations: 0, nextArtifact: 0 })
})

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

test("every drawing job type is claimed by exactly one lane", async () => {
  for (const lane of DRAWING_LANES) await run({ lane })

  const claimed = runner.claims.flatMap((claim) => claim.jobTypes)
  assert.equal(new Set(claimed).size, claimed.length, "no job type is claimed by two lanes")
  assert.deepEqual([...claimed].sort(), [...DRAWING_PIPELINE_JOB_TYPES].sort())
  assert.deepEqual(DRAWING_LANE_JOBS.metadata, ["enrich_drawing_metadata"])
  const limitOf = (lane) => runner.claims[DRAWING_LANES.indexOf(lane)].limit
  assert.ok(limitOf("metadata") > limitOf("render"), "network-bound labeling fans out wider than rendering")
})

// ---------------------------------------------------------------------------
// Job leases
// ---------------------------------------------------------------------------

describe("job leases", () => {
  test("claimed jobs the deadline leaves unstarted are released, not stranded", async () => {
    for (const pageIndex of [0, 1, 2]) enqueue("process_drawing_page", pagePayload({ pageIndex }))
    const realNow = Date.now
    const start = realNow()
    let clock = start
    const claim = RPCS.claim_drawing_jobs
    // The claim itself takes the runner past its shutdown margin.
    RPCS.claim_drawing_jobs = (args, store) => {
      clock = start + 80_000
      return claim(args, store)
    }
    Date.now = () => clock
    let summary
    try {
      summary = await runDrawingsPipeline({ deadlineMs: start + 100_000 })
    } finally {
      Date.now = realNow
      RPCS.claim_drawing_jobs = claim
    }

    assert.deepEqual(jobsOf("process_drawing_page").map((job) => job.status), ["pending", "pending", "pending"])
    assert.equal(summary.processed, 0)
    assert.equal(summary.remaining, 3)
  })

  test("a lease transition that errors throws, and a lost lease reads as not owned", async () => {
    const job = { job_id: 1, claim_token: "token" }
    const offline = createFakeSupabase({}, { transition_drawing_job_lease: () => ({ data: null, error: { message: "offline" } }) })
    const lost = createFakeSupabase({}, { transition_drawing_job_lease: () => ({ data: false, error: null }) })

    await assert.rejects(pipeline.transitionDrawingJobLease(offline, job, "heartbeat"), /offline/)
    assert.equal(await pipeline.transitionDrawingJobLease(lost, job, "complete"), false)
  })

  test("a failed claim or queue read is an error, never an empty queue", async () => {
    const claim = RPCS.claim_drawing_jobs
    RPCS.claim_drawing_jobs = () => ({ data: null, error: { message: "queue offline" } })
    try {
      await assert.rejects(run(), /queue offline/)
    } finally {
      RPCS.claim_drawing_jobs = claim
    }

    enqueue("process_drawing_page", pagePayload())
    assert.equal(await pipeline.hasPendingDrawingJobs(), true)
    const from = database.client.from
    database.client.from = (table) => {
      const query = from(table)
      query.run = () => ({ data: null, count: null, error: { message: "read offline" } })
      return query
    }
    await assert.rejects(pipeline.hasPendingDrawingJobs(), /read offline/)
  })
})

// ---------------------------------------------------------------------------
// Splitting an upload into pages
// ---------------------------------------------------------------------------

describe("splitting", () => {
  async function pdfWithPages(count, draw) {
    const document = await PDFDocument.create()
    const font = await document.embedFont(StandardFonts.Helvetica)
    for (let index = 0; index < count; index++) draw(document.addPage([600, 400]), index, font)
    return Buffer.from(await document.save())
  }

  function queueSplit(pageCount) {
    db().drawing_sheet_versions.length = 0
    db().drawing_sheets.length = 0
    Object.assign(revision(), { processed_pages: 0, total_pages: pageCount })
    enqueue("split_drawing_chunk", {
      orgId: "org",
      projectId: "project",
      drawingSetId: "set",
      draftRevisionId: "revision",
      sourceFileId: "file",
      sourceHash: "hash",
      pageCount,
      setTitle: "House",
      chunkIndex: 0,
      chunkStart: 0,
      chunkEnd: pageCount,
    })
  }

  test("the sheet number comes from the title block, not a SEE SHEET reference", async () => {
    pdfs.set(
      "org/source.pdf",
      await pdfWithPages(1, (page, _index, font) => {
        page.drawText("SHEET NUMBER: A2", { x: 480, y: 20, size: 9, font })
        page.drawText("TITLE: FLOOR PLAN", { x: 480, y: 33, size: 6, font })
        page.drawText("SEE SHEET A5.1", { x: 175, y: 200, size: 6, font })
      }),
    )
    queueSplit(1)

    await run({ lane: "split" })

    const registered = version("version-0").extracted_metadata
    assert.equal(registered.proposed.sheet_number, "A2")
    assert.equal(registered.proposed.sheet_title, "FLOOR PLAN")
    assert.ok(registered.sheet_detection.source_bounds.x > 0.75, "the number was read in the right-hand title block")
  })

  test("labeling is queued beside rendering, and a resumed split queues nothing twice", async () => {
    pdfs.set("org/source.pdf", await pdfWithPages(6, (page, index) => page.drawText(`SHEET NUMBER A${index + 1}`, { x: 450, y: 30, size: 10 })))
    queueSplit(6)

    await run({ lane: "split" })

    assert.ok(kicked.includes("metadata"), "a metadata runner is started")
    const labels = jobsOf("enrich_drawing_metadata")
    assert.equal(labels.length, 6)
    assert.ok(labels.every((job) => job.payload.pagePdfPath === `org/split/${job.payload.pageNumber - 1}/page.pdf`))
    assert.ok(labels.every((job) => storage.objects.has(job.payload.pagePdfPath)), "each label job can read its own page")
    assert.equal(jobsOf("process_drawing_page").length, 6)

    queueSplit(6)
    await run({ lane: "split" })

    assert.equal(jobsOf("enrich_drawing_metadata").length, 6)
    assert.equal(jobsOf("process_drawing_page").length, 6)
  })

  test("a replacement set re-renders only the page that changed", async () => {
    const pageCount = 6
    pdfs.set("org/source.pdf", await syntheticPdf(pageCount))
    vision.configured = false
    queueSplit(pageCount)
    await run({ lane: "split" })
    // The previous upload's renders, registered under each unchanged page's content fingerprint.
    for (const job of jobsOf("process_drawing_page")) {
      const prefix = `org/artifacts/previous-${job.payload.pageIndex}`
      runner.artifacts.set(job.payload.pageFingerprint, {
        id: `previous-${job.payload.pageIndex}`,
        state: "active",
        storage_prefix: prefix,
        render_output: {
          tile_manifest: { Image: { Format: "webp", TileSize: 512, Size: { Width: 1250, Height: 834 } }, Levels: 12 },
          tile_base_url: `https://tiles.test/${prefix}`,
          tiles_base_path: prefix,
          tile_manifest_path: `${prefix}/manifest.json`,
          tile_levels: 12,
          image_width: 1250,
          image_height: 834,
          thumbnail_url: `https://tiles.test/${prefix}/thumbnail.webp`,
          page_text: `A${job.payload.pageIndex + 1}`,
          extracted_metadata: {},
        },
      })
    }
    db().outbox.length = 0
    db().drawing_split_pages.length = 0
    storage.reads.length = 0
    pdfs.set("org/source.pdf", await syntheticPdf(pageCount, { changedPage: 3 }))
    queueSplit(pageCount)
    await run({ lane: "split" })

    await run({ lane: "render" })

    const prefixes = db().drawing_sheet_versions.sort((a, b) => a.page_index - b.page_index).map((row) => row.tiles_base_path)
    assert.deepEqual(prefixes, [
      "org/artifacts/previous-0",
      "org/artifacts/previous-1",
      prefixes[2],
      "org/artifacts/previous-3",
      "org/artifacts/previous-4",
      "org/artifacts/previous-5",
    ])
    assert.ok(!prefixes[2].includes("previous"), "the changed page has a render of its own")
    assert.equal(runner.activations, 1)
    assert.equal(storage.reads.filter((path) => path.endsWith("page.pdf")).length, 1, "only the changed page PDF is opened")
    assert.equal(revision().status, "draft")
  })
})

// ---------------------------------------------------------------------------
// Rendering a page
// ---------------------------------------------------------------------------

describe("rendering", () => {
  test("a fresh page renders tiles, cleans up its page PDF and queues verification before review opens", async () => {
    const document = await PDFDocument.create()
    const page = document.addPage([600, 400])
    page.drawText("SHEET NUMBER: A2", { x: 430, y: 25, size: 12 })
    page.drawText("SEE SHEET A5.1", { x: 150, y: 200, size: 10 })
    storage.objects.set("temp.pdf", Buffer.from(await document.save()))
    Object.assign(version(), { tile_manifest: null })
    revision().processed_pages = 0
    enqueue("process_drawing_page", pagePayload({ pagePdfPath: "temp.pdf" }))

    await run({ lane: "render" })

    assert.equal(version().tile_manifest.Image.Format, "webp")
    assert.ok([...storage.objects.keys()].some((path) => path.endsWith("manifest.json")))
    assert.equal(storage.objects.has("temp.pdf"), false)
    assert.equal(jobsOf("enrich_drawing_metadata").length, 1)
    assert.equal(revision().status, "draft")

    await run({ lane: "metadata" })

    assert.equal(metadata().proposed.sheet_number, "A2")
    assert.equal(revision().status, "draft")
  })

  test("a page retried after its tiles finished queues verification once and counts once", async () => {
    revision().processed_pages = 0
    enqueue("process_drawing_page", pagePayload())
    await run({ lane: "render" })

    enqueue("process_drawing_page", pagePayload())
    await run({ lane: "render" })

    assert.equal(jobsOf("enrich_drawing_metadata").length, 1)
    assert.equal(revision().processed_pages, 1)
    assert.equal(revision().status, "draft")
  })

  test.todo("two render jobs for one page claimed in the same batch queue verification once") // owner: drawings — enqueueDrawingMetadata checks then inserts with no unique outbox key, so concurrent jobs both insert (lib/services/drawings-pipeline.ts:1787)

  test("identical content adopts the existing render and is still verified", async () => {
    const donor = { ...structuredClone(version()), id: "donor", drawing_revision_id: "old-revision", tiles_base_path: "org/hash/old" }
    runner.artifacts.set("hash:0", { id: "existing", state: "active", storage_prefix: "org/hash/old", render_output: donor })
    Object.assign(version(), { tile_manifest: null })
    revision().processed_pages = 0
    enqueue("process_drawing_page", pagePayload())

    await run({ lane: "render" })

    assert.deepEqual(version().tile_manifest, donor.tile_manifest)
    assert.equal(version().tiles_base_path, "org/hash/old")
    assert.equal(runner.activations, 0, "nothing was rendered")
    assert.equal(jobsOf("enrich_drawing_metadata").length, 1)
    assert.equal(revision().status, "draft")
  })

  test("an adopted render keeps labels that were verified while the render job ran", async () => {
    vision.configured = false
    Object.assign(version(), { tile_manifest: null })
    metadata().proposed = { ...PROVISIONAL, sheet_number: "A2" }
    metadata().sheet_detection.vision_pending = false
    const donor = { ...structuredClone(version()), id: "donor", tile_manifest: COMPLETE_MANIFEST, extracted_metadata: { vector_stats: { segments: 100 } } }
    runner.artifacts.set("hash:0", { id: "existing", state: "active", storage_prefix: "org/hash/old", render_output: donor })
    enqueue("process_drawing_page", pagePayload())

    await run({ lane: "render" })

    assert.equal(metadata().proposed.sheet_number, "A2")
    assert.equal(metadata().sheet_detection.vision_pending, false)
    assert.equal(metadata().vector_stats.segments, 100)
  })

  test("vision switched off between split and render cannot strand the upload", async () => {
    vision.configured = false
    enqueue("process_drawing_page", pagePayload())

    await run({ lane: "render" })

    assert.equal(revision().status, "draft")
    assert.equal(jobsOf("enrich_drawing_metadata").length, 0)
    assert.equal(metadata().sheet_detection.vision_pending, false)
    assert.match(metadata().sheet_detection.vision_error, /unavailable/)
  })

  test("a verification job that cannot be queued fails the page job instead of being lost", async () => {
    failInserts(database.client, "outbox", "database unavailable")
    const page = enqueue("process_drawing_page", pagePayload())

    const summary = await run({ lane: "render" })

    assert.equal(summary.failed, 1)
    assert.match(page.last_error, /database unavailable/)
  })
})

// ---------------------------------------------------------------------------
// Verifying the title block
// ---------------------------------------------------------------------------

describe("title-block verification", () => {
  test("rendered pages open for review, then verification corrects the provisional identity", async () => {
    enqueue("enrich_drawing_metadata", enrichPayload())

    await run({ lane: "metadata" })

    const meta = metadata()
    assert.deepEqual(meta.proposed, { sheet_number: "A2", sheet_title: "FLOOR PLAN", discipline: "A" })
    assert.equal(meta.sheet_detection.vision_pending, false)
    assert.equal(meta.sheet_detection.needs_review, false)
    assert.equal(meta.sheet_detection.verification_tier, "standard")
    assert.equal(meta.sheet_detection.number_evidence.text, "A2")
    assert.equal(db().drawing_sheets[0].sheet_number, "A2")
    assert.equal(revision().status, "draft")
    assert.equal(sheetImages.length, 5, "every title-block window is read from the tiles")
    assert.doesNotMatch(vision.calls[0].prompt, /SEE SHEET A5\.1|Current text-based guess/, "the text guess never reaches the model")
  })

  test("a reading not backed by title-block evidence gets a standard reread and stays flagged", async () => {
    vision.answer = { ...TITLE_BLOCK_A2, discipline: "A", number_evidence: { text: "A5.1", location: "detail bubble", is_title_block: false } }
    enqueue("enrich_drawing_metadata", enrichPayload())

    await run({ lane: "metadata" })

    assert.deepEqual(vision.calls.map((call) => call.tier), ["fast", "standard"])
    assert.equal(metadata().sheet_detection.needs_review, true)
    assert.equal(metadata().sheet_detection.confidence, "low")
    assert.equal(metadata().sheet_detection.vision_pending, false)
    assert.equal(metadata().proposed.sheet_number, "A5.1")
    assert.equal(revision().status, "draft")
  })

  test("an unavailable provider releases review at once with the sheet flagged", async () => {
    vision.answer = null
    enqueue("enrich_drawing_metadata", enrichPayload())

    await run({ lane: "metadata" })

    const detection = metadata().sheet_detection
    assert.equal(detection.vision_pending, false)
    assert.equal(detection.needs_review, true)
    assert.equal(detection.confidence, "low")
    assert.match(detection.vision_notes[0], /unavailable/)
    assert.equal(revision().status, "draft")
  })

  test("a failing provider is retried, then review is released with the error recorded", async () => {
    vision.answer = new Error("provider offline")
    const job = enqueue("enrich_drawing_metadata", enrichPayload())

    await run({ lane: "metadata" })
    assert.equal(job.status, "pending")
    assert.match(job.last_error, /provider offline/)
    assert.equal(metadata().sheet_detection.vision_pending, true, "still waiting while retries remain")

    for (let attempt = 2; attempt <= 3; attempt++) {
      job.run_at = new Date(0).toISOString()
      await run({ lane: "metadata" })
    }

    assert.equal(job.status, "failed")
    const detection = metadata().sheet_detection
    assert.equal(detection.vision_pending, false)
    assert.equal(detection.needs_review, true)
    assert.match(detection.vision_error, /provider offline/)
  })

  test("a sheet row the user edited keeps their edit, and a published revision is never touched", async () => {
    db().drawing_sheets[0].sheet_title = "User corrected title"
    enqueue("enrich_drawing_metadata", enrichPayload())
    await run({ lane: "metadata" })
    assert.equal(db().drawing_sheets[0].sheet_title, "User corrected title")

    revision().status = "published"
    const before = structuredClone({ ...db(), outbox: [] })
    enqueue("enrich_drawing_metadata", enrichPayload())
    await run({ lane: "metadata" })

    assert.deepEqual({ ...db(), outbox: [] }, before)
    assert.equal(vision.calls.length, 2, "the published revision was not sent to the provider")
  })

  test("verification never changes the number of an explicitly targeted sheet", async () => {
    metadata().identity_locked = true
    enqueue("enrich_drawing_metadata", enrichPayload())

    await run({ lane: "metadata" })

    assert.equal(metadata().proposed.sheet_number, "A5.1")
  })

  test("labels and a readable preview come from the page PDF before any tiles exist", async () => {
    const document = await PDFDocument.create()
    document.addPage([1200, 800]).drawText("SHEET NUMBER A2", { x: 950, y: 40, size: 20 })
    storage.objects.set("org/split/0/page.pdf", Buffer.from(await document.save()))
    Object.assign(version(), { tile_manifest: null, tiles_base_path: null, image_width: null, image_height: null })
    enqueue("enrich_drawing_metadata", enrichPayload({ pagePdfPath: "org/split/0/page.pdf" }))

    await run({ lane: "metadata" })

    assert.equal(metadata().proposed.sheet_number, "A2")
    assert.equal(version().thumbnail_url, "https://tiles.test/org/split/0/preview-label.jpg")
    assert.equal(version().tile_manifest, null)
    assert.ok(storage.objects.has("org/split/0/page.pdf"), "the render job still needs the page PDF")
    assert.equal(sheetImages.length, 0, "no tiles are reconstructed for labeling")
    assert.equal(vision.calls[0].images.length, 5)
  })
})
