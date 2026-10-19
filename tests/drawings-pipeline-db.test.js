"use strict"

/**
 * The drawings pipeline's database contract: worker job leases, immutable
 * render artifacts, split-page intents, page registration, render progress,
 * manual retry and publication. Workers call these functions as
 * `service_role` and identify their claimed job with request headers, exactly
 * as `lib/services/drawings-pipeline.ts` does.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { createDatabase, insert, rpc, seedMember, setRequestHeaders } = require("./support/pglite")

const COMPLETE_MANIFEST = { Image: { Format: "webp", TileSize: 512, Size: { Width: 100, Height: 200 } }, Levels: 9 }
const CONFIDENT = { proposed: { sheet_number: "A1" }, sheet_detection: { confidence: "high" } }

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** An org with one project whose plan set has a revision still processing. */
async function drawingProject(db, { totalPages = 1, status = "processing" } = {}) {
  const { orgId, userId } = await seedMember(db)
  const project = await insert(db, "projects", { org_id: orgId, name: "Lot 12" })
  const source = await insert(db, "files", {
    org_id: orgId,
    project_id: project.id,
    file_name: "plans.pdf",
    storage_path: `${orgId}/projects/${project.id}/plans.pdf`,
    category: "plans",
  })
  const set = await insert(db, "drawing_sets", {
    org_id: orgId,
    project_id: project.id,
    title: "Plans",
    source_file_id: source.id,
  })
  const revision = await addRevision(db, { orgId, project, set, source, totalPages, status })
  return { db, orgId, userId, project, source, set, revision }
}

function addRevision(db, { orgId, project, set, source, totalPages = 1, status = "processing" }) {
  return insert(db, "drawing_revisions", {
    org_id: orgId,
    project_id: project.id,
    drawing_set_id: set.id,
    source_file_id: source.id,
    revision_label: "Rev 1",
    status,
    total_pages: totalPages,
  })
}

/** A sheet and its version for one page of a revision. */
async function addPage(
  db,
  home,
  { pageIndex = 0, sheetNumber = `A${pageIndex + 1}`, revision = home.revision, ...version } = {},
) {
  const sheet = await insert(db, "drawing_sheets", {
    org_id: home.orgId,
    project_id: home.project.id,
    drawing_set_id: home.set.id,
    sheet_number: sheetNumber,
  })
  return insert(db, "drawing_sheet_versions", {
    org_id: home.orgId,
    drawing_sheet_id: sheet.id,
    drawing_revision_id: revision.id,
    page_index: pageIndex,
    ...version,
  })
}

/** Queue a drawing job and claim it, as a worker would. */
async function claimJob(db, orgId, jobType, payload, { retryCount = 0 } = {}) {
  await insert(db, "outbox", { org_id: orgId, job_type: jobType, payload, retry_count: retryCount })
  const [claim] = await rpc(db, "claim_drawing_jobs", { job_types: [jobType], limit_value: 1 })
  return claim
}

/** Act as the worker holding `claim` (or as no worker, when null). */
function actAs(db, claim) {
  return setRequestHeaders(
    db,
    claim ? { "x-drawing-job-id": String(claim.job_id), "x-drawing-claim-token": claim.claim_token } : {},
  )
}

async function expireLease(db, claim) {
  await db.query("update outbox set drawing_lease_expires_at = now() - interval '1 second' where id = $1", [claim.job_id])
}

function reserveArtifact(db, orgId, versionId, fingerprint = "fingerprint") {
  return rpc(db, "reserve_drawing_artifact", {
    p_org_id: orgId,
    p_version_id: versionId,
    p_fingerprint: fingerprint,
    p_recipe: "recipe",
  })
}

/** Record a complete render into the artifact's own paths, then activate it. */
async function renderArtifact(db, orgId, artifact, versionId, manifest = COMPLETE_MANIFEST) {
  await db.query(
    `update drawing_sheet_versions
     set tile_manifest = $1, tiles_base_path = $2, tile_manifest_path = $2 || '/manifest.json',
         tile_levels = 9, image_width = 100, image_height = 200
     where id = $3`,
    [manifest, artifact.storage_prefix, versionId],
  )
  return rpc(db, "activate_drawing_artifact", { p_org_id: orgId, p_artifact_id: artifact.id, p_version_id: versionId })
}

async function one(db, sql, params) {
  return (await db.query(sql, params)).rows[0]
}

// ---------------------------------------------------------------------------
// Job leases
// ---------------------------------------------------------------------------

test("an expired lease is recovered and its old token can no longer transition the job", async (t) => {
  const db = await createDatabase(t)
  const { orgId, revision } = await drawingProject(db)
  const stale = await claimJob(db, orgId, "process_drawing_page", { draftRevisionId: revision.id })
  assert.deepEqual(await rpc(db, "claim_drawing_jobs", { job_types: ["process_drawing_page"] }), [])

  await expireLease(db, stale)
  assert.equal(await rpc(db, "recover_drawing_job_leases", { p_job_types: ["process_drawing_page"] }), 1)
  const [fresh] = await rpc(db, "claim_drawing_jobs", { job_types: ["process_drawing_page"] })
  assert.notEqual(fresh.claim_token, stale.claim_token)

  for (const action of ["heartbeat", "complete", "retry", "release"]) {
    const moved = await rpc(db, "transition_drawing_job_lease", {
      p_id: stale.job_id,
      p_token: stale.claim_token,
      p_action: action,
    })
    assert.equal(moved, false, `stale ${action}`)
  }
})

test("worker writes need a live lease on a revision that still exists", async (t) => {
  const db = await createDatabase(t)
  const home = await drawingProject(db)
  const writeSheet = (number) =>
    insert(db, "drawing_sheets", {
      org_id: home.orgId,
      project_id: home.project.id,
      drawing_set_id: home.set.id,
      sheet_number: number,
    })
  const stale = await claimJob(db, home.orgId, "process_drawing_page", { draftRevisionId: home.revision.id })
  await expireLease(db, stale)
  await rpc(db, "recover_drawing_job_leases", { p_job_types: ["process_drawing_page"] })
  const [fresh] = await rpc(db, "claim_drawing_jobs", { job_types: ["process_drawing_page"] })

  await actAs(db, stale)
  await assert.rejects(writeSheet("A1"), /lease lost/)

  await actAs(db, fresh)
  await writeSheet("A1")

  await db.query("delete from drawing_revisions where id = $1", [home.revision.id])
  await assert.rejects(writeSheet("A2"), /no longer exists/)
})

test("a retried job waits out its backoff before it can be claimed and completed", async (t) => {
  const db = await createDatabase(t)
  const { orgId, revision } = await drawingProject(db)
  const claim = await claimJob(db, orgId, "process_drawing_page", { draftRevisionId: revision.id })

  const retried = await rpc(db, "transition_drawing_job_lease", {
    p_id: claim.job_id,
    p_token: claim.claim_token,
    p_action: "retry",
    p_error: "render failed",
  })
  assert.equal(retried, true)
  assert.deepEqual(await rpc(db, "claim_drawing_jobs", { job_types: ["process_drawing_page"] }), [])
  const job = await one(db, "select status, retry_count, last_error from outbox where id = $1", [claim.job_id])
  assert.deepEqual(job, { status: "pending", retry_count: 1, last_error: "render failed" })

  await db.query("update outbox set run_at = now() - interval '1 second' where id = $1", [claim.job_id])
  const [again] = await rpc(db, "claim_drawing_jobs", { job_types: ["process_drawing_page"] })
  const completed = await rpc(db, "transition_drawing_job_lease", {
    p_id: again.job_id,
    p_token: again.claim_token,
    p_action: "complete",
  })
  assert.equal(completed, true)
})

test("the third failed render attempt fails the revision", async (t) => {
  const db = await createDatabase(t)
  const { orgId, revision } = await drawingProject(db)
  const claim = await claimJob(db, orgId, "process_drawing_page", { draftRevisionId: revision.id }, { retryCount: 2 })
  await actAs(db, claim)

  const moved = await rpc(db, "transition_drawing_job_lease", {
    p_id: claim.job_id,
    p_token: claim.claim_token,
    p_action: "retry",
    p_error: "render failed",
  })

  assert.equal(moved, true)
  assert.equal((await one(db, "select status from outbox where id = $1", [claim.job_id])).status, "failed")
  const stored = await one(db, "select processing_stage, error_message from drawing_revisions where id = $1", [revision.id])
  assert.deepEqual(stored, { processing_stage: "failed", error_message: "render failed" })
})

test("a third expired verification lease stops waiting on vision", async (t) => {
  const db = await createDatabase(t)
  const home = await drawingProject(db)
  const version = await addPage(db, home, { extracted_metadata: { sheet_detection: { vision_pending: true } } })
  const claim = await claimJob(
    db,
    home.orgId,
    "enrich_drawing_metadata",
    { draftRevisionId: home.revision.id, sheetVersionId: version.id },
    { retryCount: 2 },
  )

  await expireLease(db, claim)
  await rpc(db, "recover_drawing_job_leases", { p_job_types: ["enrich_drawing_metadata"] })

  const { extracted_metadata } = await one(db, "select extracted_metadata from drawing_sheet_versions where id = $1", [
    version.id,
  ])
  assert.equal(extracted_metadata.sheet_detection.vision_pending, false)
  assert.equal(extracted_metadata.sheet_detection.confidence, "low")
})

// ---------------------------------------------------------------------------
// Late AI enrichment
// ---------------------------------------------------------------------------

test("late enrichment cannot overwrite a reviewed identity or a published revision", async (t) => {
  const db = await createDatabase(t)
  const home = await drawingProject(db)
  const version = await addPage(db, home, {
    extracted_metadata: { identity_reviewed: true, proposed: { sheet_number: "A1" } },
  })
  const ai = await claimJob(db, home.orgId, "enrich_drawing_metadata", {
    draftRevisionId: home.revision.id,
    sheetVersionId: version.id,
  })
  const metadata = async () =>
    (await one(db, "select extracted_metadata from drawing_sheet_versions where id = $1", [version.id])).extracted_metadata

  await actAs(db, ai)
  await db.query("update drawing_sheet_versions set extracted_metadata = $1 where id = $2", [
    { proposed: { sheet_number: "BAD" } },
    version.id,
  ])
  await db.query("update drawing_sheets set sheet_number = 'BAD' where id = $1", [version.drawing_sheet_id])
  assert.equal((await metadata()).identity_reviewed, true)
  const sheet = await one(db, "select sheet_number from drawing_sheets where id = $1", [version.drawing_sheet_id])
  assert.equal(sheet.sheet_number, "A1")

  await actAs(db, null)
  await db.query("update drawing_revisions set status = 'published' where id = $1", [home.revision.id])
  await db.query("update drawing_sheet_versions set extracted_metadata = '{}' where id = $1", [version.id])
  await actAs(db, ai)
  await db.query("update drawing_sheet_versions set extracted_metadata = $1 where id = $2", [
    { proposed: { sheet_number: "BAD" } },
    version.id,
  ])
  assert.deepEqual(await metadata(), {})
})

// ---------------------------------------------------------------------------
// Render artifacts
// ---------------------------------------------------------------------------

test("a live artifact writer is renewed; an expired one gets a fresh generation", async (t) => {
  const db = await createDatabase(t)
  const home = await drawingProject(db)
  const version = await addPage(db, home)

  const first = await reserveArtifact(db, home.orgId, version.id)
  assert.equal((await reserveArtifact(db, home.orgId, version.id)).id, first.id)

  await db.query("update drawing_artifacts set writer_until = now() - interval '1 second' where id = $1", [first.id])
  const fresh = await reserveArtifact(db, home.orgId, version.id)
  assert.notEqual(fresh.storage_prefix, first.storage_prefix)
  await assert.rejects(renderArtifact(db, home.orgId, first, version.id), /writer expired/)
})

test("an artifact activates only with a complete tile manifest at its own paths", async (t) => {
  const db = await createDatabase(t)
  const home = await drawingProject(db)
  const version = await addPage(db, home)
  const artifact = await reserveArtifact(db, home.orgId, version.id)

  const incomplete = [
    {},
    { Image: {} },
    { ...COMPLETE_MANIFEST, Partial: true },
    { ...COMPLETE_MANIFEST, Partial: false },
  ]
  for (const manifest of incomplete) {
    await assert.rejects(renderArtifact(db, home.orgId, artifact, version.id, manifest), /incomplete/)
  }
  assert.equal(await renderArtifact(db, home.orgId, artifact, version.id), true)
})

test("an active artifact outlives its producer and is adopted by the next version", async (t) => {
  const db = await createDatabase(t)
  const home = await drawingProject(db)
  const producer = await addPage(db, home)
  const artifact = await reserveArtifact(db, home.orgId, producer.id)
  await renderArtifact(db, home.orgId, artifact, producer.id)

  await db.query("delete from drawing_sheet_versions where id = $1", [producer.id])
  const next = await addPage(db, home, { sheetNumber: "A2" })
  const adopted = await reserveArtifact(db, home.orgId, next.id)

  assert.equal(adopted.id, artifact.id)
  assert.deepEqual(adopted.render_output.tile_manifest, COMPLETE_MANIFEST)
})

test("a referenced artifact is not retired, and a retired one cannot be referenced again", async (t) => {
  const db = await createDatabase(t)
  const home = await drawingProject(db)
  const version = await addPage(db, home)
  const artifact = await reserveArtifact(db, home.orgId, version.id)
  await renderArtifact(db, home.orgId, artifact, version.id)
  const retire = () => rpc(db, "retire_drawing_artifact", { p_org_id: home.orgId, p_artifact_id: artifact.id })

  assert.equal((await retire()).retired, false)
  await db.query("delete from drawing_sheet_versions where id = $1", [version.id])
  assert.equal((await retire()).retired, true)

  const later = await addPage(db, home, { sheetNumber: "A2" })
  await assert.rejects(
    db.query("update drawing_sheet_versions set artifact_id = $1 where id = $2", [artifact.id, later.id]),
    /unavailable/,
  )
})

test("an artifact cannot be referenced by another org's drawing", async (t) => {
  const db = await createDatabase(t)
  const home = await drawingProject(db)
  const version = await addPage(db, home)
  const artifact = await reserveArtifact(db, home.orgId, version.id)
  await renderArtifact(db, home.orgId, artifact, version.id)

  const stranger = await drawingProject(db)
  const theirs = await addPage(db, stranger)
  await assert.rejects(
    db.query("update drawing_sheet_versions set artifact_id = $1 where id = $2", [artifact.id, theirs.id]),
    /unavailable/,
  )
})

test("an artifact writer whose job lease expired cannot renew", async (t) => {
  const db = await createDatabase(t)
  const home = await drawingProject(db)
  const version = await addPage(db, home)
  const claim = await claimJob(db, home.orgId, "process_drawing_page", { draftRevisionId: home.revision.id })
  await actAs(db, claim)
  const building = await reserveArtifact(db, home.orgId, version.id)

  await actAs(db, null)
  await expireLease(db, claim)
  await actAs(db, claim)

  await assert.rejects(
    rpc(db, "renew_drawing_artifact_writer", {
      p_org_id: home.orgId,
      p_artifact_id: building.id,
      p_version_id: version.id,
    }),
    /lease lost/,
  )
})

// ---------------------------------------------------------------------------
// Split-page intents
// ---------------------------------------------------------------------------

async function reserveSplit(db, home, version) {
  return rpc(db, "reserve_drawing_split_page", {
    p_org_id: home.orgId,
    p_revision_id: home.revision.id,
    p_source_hash: "source",
    p_page_index: 0,
    p_version_id: version.id,
  })
}

function emitSplit(db, home, intent, payload) {
  return rpc(db, "emit_drawing_split_page", { p_org_id: home.orgId, p_intent_id: intent.id, p_payload: payload })
}

function pagePayload(home, version, intent) {
  return {
    orgId: home.orgId,
    draftRevisionId: home.revision.id,
    versionId: version.id,
    pageIndex: 0,
    pagePdfPath: `${intent.storage_prefix}/page.pdf`,
  }
}

test("a split page is reserved once and emits exactly one page job", async (t) => {
  const db = await createDatabase(t)
  const home = await drawingProject(db)
  const version = await addPage(db, home)
  const intent = await reserveSplit(db, home, version)
  assert.equal((await reserveSplit(db, home, version)).id, intent.id)
  const payload = pagePayload(home, version, intent)

  await assert.rejects(emitSplit(db, home, intent, { ...payload, pagePdfPath: "elsewhere" }), /mismatch/)
  const job = await emitSplit(db, home, intent, payload)

  assert.equal(await emitSplit(db, home, intent, payload), job)
  const jobs = await one(db, "select count(*)::int as n from outbox where job_type = 'process_drawing_page'")
  assert.equal(jobs.n, 1)
})

test("an emitted split page is kept until its revision is deleted, then swept for cleanup", async (t) => {
  const db = await createDatabase(t)
  const home = await drawingProject(db)
  const version = await addPage(db, home)
  const intent = await reserveSplit(db, home, version)
  await emitSplit(db, home, intent, pagePayload(home, version, intent))
  const retire = () => rpc(db, "retire_drawing_split_page", { p_org_id: home.orgId, p_intent_id: intent.id })
  const candidates = () => rpc(db, "drawing_storage_cleanup_candidates", { p_org_id: home.orgId })

  assert.equal((await retire()).retired, false)
  await db.query("delete from drawing_revisions where id = $1", [home.revision.id])
  const retired = await retire()
  assert.equal(retired.retired, true)
  assert.equal(retired.storage_prefix, intent.storage_prefix)

  await rpc(db, "complete_drawing_split_deletion", {
    p_org_id: home.orgId,
    p_intent_id: intent.id,
    p_generation: intent.id,
  })
  assert.deepEqual(await candidates(), [])
  await db.query("update drawing_split_pages set last_cleanup_at = now() - interval '2 hours' where id = $1", [intent.id])
  assert.deepEqual(
    (await candidates()).map((candidate) => candidate.id),
    [intent.id],
  )
})

// ---------------------------------------------------------------------------
// Split registration and render progress
// ---------------------------------------------------------------------------

function splitPage(home, pageIndex, sheetNumber = "A1") {
  return {
    projectId: home.project.id,
    drawingSetId: home.set.id,
    sourceFileId: home.source.id,
    sourceHash: "source",
    pageIndex,
    pageText: "full text",
    tentativeSheetNumber: sheetNumber,
    metadata: {
      source_hash: "source",
      page_index: pageIndex,
      proposed: { sheet_number: sheetNumber, sheet_title: "PLAN", discipline: "A" },
      sheet_detection: { vision_pending: true },
    },
  }
}

function registerBatch(db, home, pages) {
  return rpc(db, "register_drawing_split_batch", {
    p_org_id: home.orgId,
    p_revision_id: home.revision.id,
    p_pages: pages,
  })
}

test(
  "a split batch keeps colliding sheet numbers apart and carries calibration forward",
  async (t) => {
    const db = await createDatabase(t)
    const home = await drawingProject(db, { totalPages: 2 })
    const published = await addRevision(db, { ...home, status: "published" })
    const earlier = await addPage(db, home, {
      revision: published,
      sheetNumber: "A1",
      extracted_metadata: { calibration: { feet_per_image_px: 0.25 } },
    })

    const registered = await registerBatch(db, home, [splitPage(home, 0), splitPage(home, 1)])

    assert.equal(registered.length, 2)
    assert.notEqual(registered[0].sheetId, registered[1].sheetId)
    const numbers = (await db.query("select sheet_number from drawing_sheets order by sheet_number")).rows
    assert.deepEqual(
      numbers.map((row) => row.sheet_number),
      ["A1", "A1-P2"],
    )
    const { extracted_metadata } = await one(db, "select extracted_metadata from drawing_sheet_versions where id = $1", [
      registered[0].versionId,
    ])
    assert.equal(extracted_metadata.is_new_sheet, false)
    assert.equal(extracted_metadata.calibration.feet_per_image_px, 0.25)
    assert.equal(extracted_metadata.calibration.carried_from_version_id, earlier.id)
  },
)

test("replaying a split batch returns the pages it already registered", async (t) => {
  const db = await createDatabase(t)
  const home = await drawingProject(db, { totalPages: 2 })
  const pages = [splitPage(home, 0), splitPage(home, 1, "A2")]

  const first = await registerBatch(db, home, pages)
  const replay = await registerBatch(db, home, pages)

  assert.deepEqual(
    replay.map((page) => page.versionId),
    first.map((page) => page.versionId),
  )
  const versions = await one(db, "select count(*)::int as n from drawing_sheet_versions")
  assert.equal(versions.n, 2)
})

test("a split batch refuses more than eight pages or a page from another source", async (t) => {
  const db = await createDatabase(t)
  const home = await drawingProject(db, { totalPages: 9 })

  await assert.rejects(registerBatch(db, home, Array(9).fill(splitPage(home, 2))), /batch size/)
  await assert.rejects(registerBatch(db, home, [{ ...splitPage(home, 2), projectId: home.orgId }]), /source mismatch/)
})

test("a deleted page counts toward readiness and a malformed manifest does not", async (t) => {
  const db = await createDatabase(t)
  const home = await drawingProject(db, { totalPages: 3 })
  const first = await addPage(db, home, { pageIndex: 0, tile_manifest: COMPLETE_MANIFEST })
  await addPage(db, home, { pageIndex: 2, tile_manifest: COMPLETE_MANIFEST })
  await insert(db, "drawing_deleted_pages", {
    org_id: home.orgId,
    revision_id: home.revision.id,
    page_index: 1,
    sheet_id: first.drawing_sheet_id,
  })
  const progress = () => rpc(db, "update_drawing_render_progress", { p_org_id: home.orgId, p_revision_id: home.revision.id })

  const ready = await progress()
  assert.equal(ready.ready, true)
  assert.equal(ready.rendered_pages, 2)
  assert.equal(ready.deleted_pages, 1)
  assert.equal((await one(db, "select status from drawing_revisions where id = $1", [home.revision.id])).status, "draft")

  await db.query("update drawing_sheet_versions set tile_manifest = '{}' where id = $1", [first.id])
  const malformed = await progress()
  assert.equal(malformed.rendered_pages, 1)
  assert.equal(malformed.ready, false)
})

test("a revision is marked first viewable once", async (t) => {
  const db = await createDatabase(t)
  const home = await drawingProject(db)
  const mark = () => rpc(db, "mark_drawing_first_viewable", { p_org_id: home.orgId, p_revision_id: home.revision.id })

  assert.ok(await mark())
  assert.equal(await mark(), null)
})

// ---------------------------------------------------------------------------
// Manual retry
// ---------------------------------------------------------------------------

test("manual retry requeues a failed page job once and fences its previous owner", async (t) => {
  const db = await createDatabase(t)
  const home = await drawingProject(db)
  const version = await addPage(db, home)
  const intent = await reserveSplit(db, home, version)
  const jobId = await emitSplit(db, home, intent, pagePayload(home, version, intent))
  const [owner] = await rpc(db, "claim_drawing_jobs", { job_types: ["process_drawing_page"] })
  await db.query("update outbox set status = 'failed', retry_count = 3 where id = $1", [jobId])

  await rpc(db, "retry_drawing_revision_pipeline", { p_org_id: home.orgId, p_revision_id: home.revision.id })

  const job = await one(db, "select status, retry_count, drawing_claim_token from outbox where id = $1", [jobId])
  assert.deepEqual(job, { status: "pending", retry_count: 0, drawing_claim_token: null })
  const completed = await rpc(db, "transition_drawing_job_lease", {
    p_id: jobId,
    p_token: owner.claim_token,
    p_action: "complete",
  })
  assert.equal(completed, false)
  const pageJobs = await one(db, "select count(*)::int as n from outbox where job_type = 'process_drawing_page'")
  assert.equal(pageJobs.n, 1)
  assert.equal((await reserveSplit(db, home, version)).state, "emitted")
})

test("retrying a single-sheet replacement keeps its target and leaves rendered pages alone", async (t) => {
  const db = await createDatabase(t)
  const home = await drawingProject(db)
  const version = await addPage(db, home, { tile_manifest: COMPLETE_MANIFEST })
  await insert(db, "outbox", {
    org_id: home.orgId,
    job_type: "process_drawing_set",
    status: "failed",
    payload: { draftRevisionId: home.revision.id, targetSheetId: version.drawing_sheet_id },
  })
  const rendered = await insert(db, "outbox", {
    org_id: home.orgId,
    job_type: "process_drawing_page",
    status: "completed",
    payload: { draftRevisionId: home.revision.id, versionId: version.id, pageIndex: 0 },
  })

  await rpc(db, "retry_drawing_revision_pipeline", { p_org_id: home.orgId, p_revision_id: home.revision.id })

  const coordinator = await one(
    db,
    "select payload from outbox where job_type = 'process_drawing_set' and status = 'pending'",
  )
  assert.equal(coordinator.payload.targetSheetId, version.drawing_sheet_id)
  assert.equal((await one(db, "select status from outbox where id = $1", [rendered.id])).status, "completed")
})

// ---------------------------------------------------------------------------
// Publication
// ---------------------------------------------------------------------------

/**
 * A two-page draft whose second page's detection proposes A1, the number the
 * first page already holds. The second page carries a calibration.
 */
async function collidingDraft(db) {
  const home = await drawingProject(db, { totalPages: 2, status: "draft" })
  const cover = await addPage(db, home, {
    pageIndex: 0,
    sheetNumber: "A1",
    tile_manifest: COMPLETE_MANIFEST,
    extracted_metadata: { ...CONFIDENT, proposed: { sheet_number: "A1", sheet_title: "Cover" } },
  })
  const details = await addPage(db, home, {
    pageIndex: 1,
    sheetNumber: "A7",
    tile_manifest: COMPLETE_MANIFEST,
    extracted_metadata: {
      ...CONFIDENT,
      proposed: { sheet_number: "A1", sheet_title: "Details" },
      calibration: { scale: 12 },
    },
  })
  const publish = ({ edits = {}, decisions = {} } = {}) =>
    rpc(db, "publish_drawing_revision", {
      p_org_id: home.orgId,
      p_revision_id: home.revision.id,
      p_user_id: home.userId,
      p_sheet_edits: edits,
      p_decisions: decisions,
    })
  const sheet = async (version) =>
    one(db, "select sheet_number, sheet_title, current_revision_id from drawing_sheets where id = $1", [
      version.drawing_sheet_id,
    ])
  const revisionStatus = async () =>
    (await one(db, "select status from drawing_revisions where id = $1", [home.revision.id])).status
  return { ...home, cover, details, publish, sheet, revisionStatus }
}

test("publishing keeps both pages when detection proposes a number already in use", async (t) => {
  const db = await createDatabase(t)
  const draft = await collidingDraft(db)

  await draft.publish()

  assert.deepEqual(await draft.sheet(draft.cover), {
    sheet_number: "A1",
    sheet_title: "Cover",
    current_revision_id: draft.revision.id,
  })
  assert.deepEqual(await draft.sheet(draft.details), {
    sheet_number: "A7",
    sheet_title: "Details",
    current_revision_id: draft.revision.id,
  })
  const { extracted_metadata } = await one(db, "select extracted_metadata from drawing_sheet_versions where id = $1", [
    draft.details.id,
  ])
  assert.equal(extracted_metadata.proposed.sheet_number, "A7")
  assert.deepEqual(extracted_metadata.calibration, { scale: 12 })
  assert.equal(await draft.revisionStatus(), "published")
})

test("an edited sheet number that collides refuses the whole publication", async (t) => {
  const db = await createDatabase(t)
  const draft = await collidingDraft(db)

  await assert.rejects(
    draft.publish({ edits: { [draft.details.drawing_sheet_id]: { sheet_number: "A1" } } }),
    /Sheet number "A1" is already in use/,
  )
  assert.equal(await draft.revisionStatus(), "draft")
  assert.equal((await draft.sheet(draft.cover)).current_revision_id, null)
  assert.equal((await draft.sheet(draft.details)).current_revision_id, null)

  await draft.publish({ edits: { [draft.details.drawing_sheet_id]: { sheet_number: "A8" } } })
  assert.equal((await draft.sheet(draft.details)).sheet_number, "A8")
})

test("publishing renames a sheet to a detected number that is free", async (t) => {
  const db = await createDatabase(t)
  const draft = await collidingDraft(db)
  await db.query("update drawing_sheet_versions set extracted_metadata = $1 where id = $2", [
    { ...CONFIDENT, proposed: { sheet_number: "A8" } },
    draft.details.id,
  ])

  await draft.publish()

  assert.equal((await draft.sheet(draft.details)).sheet_number, "A8")
})

test("a declined new sheet is removed with its page", async (t) => {
  const db = await createDatabase(t)
  const draft = await collidingDraft(db)

  await draft.publish({ decisions: { [draft.details.drawing_sheet_id]: false } })

  const versions = await db.query("select id from drawing_sheet_versions where drawing_revision_id = $1", [
    draft.revision.id,
  ])
  assert.deepEqual(
    versions.rows.map((row) => row.id),
    [draft.cover.id],
  )
  assert.equal(await draft.sheet(draft.details), undefined)
})

test("an unrelated unique violation is not mistaken for a sheet number collision", async (t) => {
  const db = await createDatabase(t)
  const draft = await collidingDraft(db)
  await db.exec("create unique index test_unique_sheet_title on drawing_sheets (sheet_title)")
  await db.query("update drawing_sheet_versions set extracted_metadata = $1 where id = $2", [
    { ...CONFIDENT, proposed: { sheet_number: "A8", sheet_title: "Cover" } },
    draft.details.id,
  ])

  await assert.rejects(draft.publish(), /test_unique_sheet_title/)
  assert.equal(await draft.revisionStatus(), "draft")
})
