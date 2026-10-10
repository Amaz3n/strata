"use strict"

/**
 * A start release copies the lot's pinned plan PDF into the home and queues
 * its drawings. The worker doing that holds a claimed `start_release` job and
 * a package lease, and identifies itself with request headers; the database
 * fences every file, drawing record and child job it writes to that claimed
 * home, plan and frozen source, and makes the publication one transaction.
 */

const test = require("node:test")
const assert = require("node:assert/strict")

const { asRole, createDatabase, insert, rpc, seedMember, setRequestHeaders } = require("./support/pglite")

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A released plan version whose frozen bundle points at `source`. */
async function releasedPlanVersion(db, orgId, actorId, source, versionNumber = 1) {
  const plan = await insert(db, "house_plans", { org_id: orgId, code: `P${versionNumber}`, name: `Plan ${versionNumber}` })
  return insert(db, "house_plan_versions", {
    org_id: orgId,
    house_plan_id: plan.id,
    version_number: versionNumber,
    status: "released",
    released_at: new Date(),
    released_by: actorId,
    bundle_snapshot: { drawing_source_file_id: source.id },
  })
}

/**
 * A home on a lot pinned to a released plan, mid-release: the start package is
 * `releasing`, a worker has claimed its `start_release` job and holds the
 * package lease, and the worker's headers are active.
 */
async function release(t) {
  const db = await createDatabase(t)
  const { orgId, userId: actorId } = await seedMember(db)
  const community = await insert(db, "communities", { org_id: orgId, name: "Harbor Point" })
  const source = await insert(db, "files", {
    org_id: orgId,
    file_name: "plan.pdf",
    storage_path: `${orgId}/plans/library/plan.pdf`,
    size_bytes: 100,
    category: "plans",
  })
  const version = await releasedPlanVersion(db, orgId, actorId, source)
  const home = await insert(db, "projects", { org_id: orgId, name: "Lot 7" })
  const otherHome = await insert(db, "projects", { org_id: orgId, name: "Lot 8" })
  const lot = await insert(db, "lots", {
    org_id: orgId,
    community_id: community.id,
    project_id: home.id,
    lot_number: "7",
    house_plan_version_id: version.id,
  })
  const pkg = await insert(db, "start_packages", {
    org_id: orgId,
    lot_id: lot.id,
    community_id: community.id,
    project_id: home.id,
    status: "releasing",
  })
  await insert(db, "outbox", {
    org_id: orgId,
    job_type: "start_release",
    payload: { start_package_id: pkg.id, actor_id: actorId },
  })
  const [job] = await rpc(db, "claim_starts_jobs", { p_limit: 1 })
  const acquired = await rpc(db, "transition_starts_package_lease", {
    p_org_id: orgId,
    p_job_id: job.job_id,
    p_token: job.claim_token,
    p_action: "acquire",
  })
  assert.equal(acquired, true)

  const h = { db, orgId, actorId, community, source, version, home, otherHome, lot, pkg, job }

  /** Whether the release worker's headers are on the session. */
  h.asWorker = (active) =>
    setRequestHeaders(
      db,
      active ? { "x-starts-job-id": String(job.job_id), "x-starts-claim-token": job.claim_token } : {},
    )
  /** Run `fn` as the worker's database role. */
  h.service = (fn) => asRole(db, { role: "service_role" }, fn)
  /** Let the worker's job lease run out, as time passing would. */
  h.expireLease = async () => {
    await setRequestHeaders(db, {})
    await db.query("update outbox set start_job_lease_expires_at = now() - interval '1 second' where id = $1", [job.job_id])
  }
  /** A generated plan PDF for the home, defaulting to exactly what the release may write. */
  h.planFile = ({
    project = home,
    planVersion = version.id,
    sourceFile = source.id,
    path = `${orgId}/projects/${project.id}/plans/${version.id}/plan.pdf`,
  } = {}) =>
    h.service((tx) =>
      insert(tx, "files", {
        org_id: orgId,
        project_id: project.id,
        file_name: "plan.pdf",
        storage_path: path,
        source: "generated",
        visibility: "private",
        category: "plans",
        metadata: { source_plan_version_id: planVersion, source_file_id: sourceFile },
      }),
    )
  /** The home's canonical drawing set, sourced from `file`. */
  h.drawingSet = (file, project = home) =>
    h.service((tx) =>
      insert(tx, "drawing_sets", { org_id: orgId, project_id: project.id, title: "Plans", source_file_id: file.id }),
    )
  h.revision = (file, set, project = home) =>
    h.service((tx) =>
      insert(tx, "drawing_revisions", {
        org_id: orgId,
        project_id: project.id,
        drawing_set_id: set.id,
        source_file_id: file.id,
        revision_label: "Plan v1",
        status: "processing",
      }),
    )
  h.count = async (sql, params) => (await db.query(`select count(*)::int as n from ${sql}`, params)).rows[0].n

  await h.asWorker(true)
  return h
}

// ---------------------------------------------------------------------------
// Generated files and drawing records
// ---------------------------------------------------------------------------

test("the release worker writes the home's plan PDF, canonical set and revision", async (t) => {
  const h = await release(t)

  const file = await h.planFile()
  const set = await h.drawingSet(file)
  const revision = await h.revision(file, set)

  assert.equal(revision.source_file_id, file.id)
  assert.equal(revision.drawing_set_id, set.id)
})

test("a plan PDF for the wrong home, plan, source or destination is refused", async (t) => {
  const h = await release(t)
  const foreignPlan = await releasedPlanVersion(h.db, h.orgId, h.actorId, h.source, 2)
  const base = `${h.orgId}/projects/${h.home.id}/plans/${h.version.id}`

  await assert.rejects(h.planFile({ project: h.otherHome }), /home mismatch/)
  await assert.rejects(h.planFile({ planVersion: foreignPlan.id }), /plan mismatch/)
  await assert.rejects(h.planFile({ sourceFile: h.otherHome.id }), /source snapshot mismatch/)
  await assert.rejects(h.planFile({ path: `${base}/../wrong.pdf` }), /destination mismatch/)
  const otherPrefix = `${h.otherHome.id}/projects/${h.home.id}/plans/${h.version.id}/plan.pdf`
  await assert.rejects(h.planFile({ path: otherPrefix }), /destination mismatch/)
  await assert.rejects(h.planFile({ path: `${h.orgId}/projects/${h.home.id}/plans/${foreignPlan.id}/plan.pdf` }), /destination mismatch/)
})

test("drawing records cannot point across homes or hide a crossed ancestry", async (t) => {
  const h = await release(t)
  const ownFile = await h.planFile()
  const ownSet = await h.drawingSet(ownFile)
  await h.asWorker(false)
  const foreignFile = await insert(h.db, "files", {
    org_id: h.orgId,
    project_id: h.otherHome.id,
    file_name: "other.pdf",
    storage_path: `${h.orgId}/projects/${h.otherHome.id}/other.pdf`,
  })
  const foreignSet = await h.drawingSet(foreignFile, h.otherHome)
  // A revision of this home that was (wrongly) built from another home's records.
  const crossedRevision = await h.revision(foreignFile, foreignSet)
  await h.asWorker(true)

  await assert.rejects(h.drawingSet(foreignFile), /project file mismatch/)
  await assert.rejects(h.revision(ownFile, foreignSet), /set mismatch/)
  await assert.rejects(
    h.service((tx) =>
      tx.query("update drawing_revisions set source_file_id = $1, drawing_set_id = $2 where id = $3", [
        ownFile.id,
        ownSet.id,
        crossedRevision.id,
      ]),
    ),
    /project file mismatch/,
  )
  await assert.rejects(
    h.service((tx) => tx.query("update files set project_id = $1 where id = $2", [h.home.id, foreignFile.id])),
    /home mismatch/,
  )
})

test("a worker that loses its lease mid-transaction leaves nothing behind", async (t) => {
  const h = await release(t)

  await assert.rejects(
    h.db.transaction(async (tx) => {
      await tx.exec("set local role service_role")
      const file = await insert(tx, "files", {
        org_id: h.orgId,
        project_id: h.home.id,
        file_name: "plan.pdf",
        storage_path: `${h.orgId}/projects/${h.home.id}/plans/${h.version.id}/plan.pdf`,
        source: "generated",
        visibility: "private",
        category: "plans",
        metadata: { source_plan_version_id: h.version.id, source_file_id: h.source.id },
      })
      await tx.exec("reset role")
      await tx.query("select set_config('request.headers', '{}', true)")
      await tx.query("update outbox set start_job_lease_expires_at = now() - interval '1 second' where id = $1", [
        h.job.job_id,
      ])
      await tx.query("select set_config('request.headers', $1, true)", [
        JSON.stringify({ "x-starts-job-id": String(h.job.job_id), "x-starts-claim-token": h.job.claim_token }),
      ])
      await insert(tx, "drawing_sets", { org_id: h.orgId, project_id: h.home.id, title: "Plans", source_file_id: file.id })
    }),
    /worker lease lost/,
  )

  assert.equal(await h.count("files where project_id = $1", [h.home.id]), 0)
})

test("members keep ordinary file access, but a browser cannot present worker headers", async (t) => {
  const h = await release(t)
  const member = { role: "authenticated", userId: h.actorId }
  const upload = () =>
    asRole(h.db, member, (tx) =>
      insert(tx, "files", {
        org_id: h.orgId,
        project_id: h.otherHome.id,
        file_name: "photo.pdf",
        storage_path: `${h.orgId}/projects/${h.otherHome.id}/photo.pdf`,
      }),
    )

  await h.asWorker(false)
  await upload()

  await h.asWorker(true)
  await assert.rejects(upload(), /Browser cannot use starts worker headers/)
})

test("the canonical set may leave an old uploaded PDF but only for the claimed plan's copy", async (t) => {
  const h = await release(t)
  await h.asWorker(false)
  const uploaded = await insert(h.db, "files", {
    org_id: h.orgId,
    project_id: h.home.id,
    file_name: "uploaded.pdf",
    storage_path: `${h.orgId}/projects/${h.home.id}/uploaded.pdf`,
  })
  const set = await h.drawingSet(uploaded)
  const foreignPlan = await releasedPlanVersion(h.db, h.orgId, h.actorId, h.source, 2)
  const wrongPlanCopy = await h.planFile({ planVersion: foreignPlan.id })
  await h.asWorker(true)
  const repoint = (file) =>
    h.service((tx) => tx.query("update drawing_sets set source_file_id = $1 where id = $2", [file.id, set.id]))

  await assert.rejects(repoint(wrongPlanCopy), /generated source mismatch/)
  const copy = await h.planFile()
  await repoint(copy)
  const stored = await h.db.query("select source_file_id from drawing_sets where id = $1", [set.id])
  assert.equal(stored.rows[0].source_file_id, copy.id)

  await h.expireLease()
  await h.asWorker(true)
  await assert.rejects(h.service((tx) => tx.query("delete from files where id = $1", [copy.id])), /worker lease lost/)
  await assert.rejects(
    h.service((tx) => tx.query("update files set visibility = 'public' where id = $1", [copy.id])),
    /worker lease lost/,
  )
})

test("plan copies follow the lot's pinned plan, not one remembered by the package", async (t) => {
  const h = await release(t)
  const repinned = await releasedPlanVersion(h.db, h.orgId, h.actorId, h.source, 2)
  const pin = async (versionId) => {
    await h.asWorker(false)
    await h.db.query("update lots set house_plan_version_id = $1 where id = $2", [versionId, h.lot.id])
    await h.asWorker(true)
  }

  await pin(repinned.id)
  await assert.rejects(h.planFile(), /plan mismatch/)

  await pin(null)
  await assert.rejects(h.planFile(), /pinned plan scope/)
})

// ---------------------------------------------------------------------------
// Publication: reserve a copy destination, then publish file, set, revision
// and processing job in one transaction.
// ---------------------------------------------------------------------------

const SOURCE_EVIDENCE = { size_bytes: 100, source_etag: "source" }

async function publication(t) {
  const h = await release(t)
  h.reserve = (evidence = SOURCE_EVIDENCE) =>
    rpc(h.db, "reserve_plan_drawing_copy", {
      p_org_id: h.orgId,
      p_project_id: h.home.id,
      p_plan_version_id: h.version.id,
      p_actor_id: h.actorId,
      p_source_evidence: evidence,
    })
  const reserved = await h.reserve()
  h.copy = {
    attempt_id: reserved.attempt_id,
    storage_path: reserved.storage_path,
    size_bytes: 100,
    source_etag: "source",
    etag: "copy",
  }
  h.publish = (copy = h.copy, actorId = h.actorId, caller = { role: "service_role" }) =>
    rpc(
      h.db,
      "publish_plan_drawing_copy",
      {
        p_org_id: h.orgId,
        p_project_id: h.home.id,
        p_plan_version_id: h.version.id,
        p_actor_id: actorId,
        p_copy: copy,
      },
      caller,
    )
  h.ledger = async () =>
    (await h.db.query("select metadata from projects where id = $1", [h.home.id])).rows[0].metadata
  h.homeFiles = () => h.count("files where project_id = $1", [h.home.id])
  return h
}

/** Make the next `process_drawing_set` insert fail, as a queue outage would. */
async function failDrawingQueue(db) {
  await db.exec(`
    create function test_reject_drawing_queue() returns trigger language plpgsql as $$
    begin
      if new.job_type = 'process_drawing_set' then raise exception 'queue unavailable'; end if;
      return new;
    end $$;
    create trigger test_reject_drawing_queue before insert on outbox
      for each row execute function test_reject_drawing_queue();
  `)
}

test("publication creates the file, set, revision and job together and replays a lost response", async (t) => {
  const h = await publication(t)

  const first = await h.publish()
  const replay = await h.publish()

  assert.equal(first.replayed, false)
  assert.equal(replay.replayed, true)
  assert.equal(replay.file_id, first.file_id)
  assert.equal(replay.job_id, first.job_id)
  assert.equal(await h.count("drawing_sets where project_id = $1", [h.home.id]), 1)
  assert.equal(await h.count("drawing_revisions where project_id = $1", [h.home.id]), 1)
  assert.equal(await h.count("outbox where job_type = 'process_drawing_set'"), 1)
  await assert.rejects(h.publish({ ...h.copy, etag: "different" }), /different evidence/)
})

test("a queue failure rolls back every publication record", async (t) => {
  const h = await publication(t)
  await failDrawingQueue(h.db)

  await assert.rejects(h.publish(), /queue unavailable/)

  assert.equal(await h.count("drawing_sets where project_id = $1", [h.home.id]), 0)
  assert.equal(await h.count("drawing_revisions where project_id = $1", [h.home.id]), 0)
  assert.equal(await h.homeFiles(), 0)
})

test("publication refuses another actor, unreserved evidence and a pending review", async (t) => {
  const h = await publication(t)

  await assert.rejects(h.publish(h.copy, h.otherHome.id), /actor mismatch/)
  await assert.rejects(h.publish({ ...h.copy, size_bytes: 101 }), /not reserved/)
  await assert.rejects(h.publish({ ...h.copy, storage_path: "wrong" }), /not reserved/)

  await h.asWorker(false)
  await insert(h.db, "drawing_revisions", {
    org_id: h.orgId,
    project_id: h.home.id,
    revision_label: "Manual",
    status: "draft",
  })
  await h.asWorker(true)
  await assert.rejects(h.publish(), /pending review/)

  assert.equal(await h.homeFiles(), 0)
})

test("losing the lease after the job is queued rolls back the whole publication", async (t) => {
  const h = await publication(t)
  // The lease runs out between the queue insert and the final ownership check.
  await h.db.exec(`
    create function test_expire_release_lease() returns trigger language plpgsql as $$
    declare headers text := current_setting('request.headers', true);
    begin
      if new.job_type = 'process_drawing_set' then
        perform set_config('request.headers', '{}', true);
        update outbox set start_job_lease_expires_at = clock_timestamp() - interval '1 second'
          where job_type = 'start_release';
        perform set_config('request.headers', headers, true);
      end if;
      return new;
    end $$;
    create trigger test_expire_release_lease after insert on outbox
      for each row execute function test_expire_release_lease();
  `)

  await assert.rejects(h.publish(), /worker lease lost/)

  assert.equal(await h.homeFiles(), 0)
  assert.equal(await h.count("drawing_revisions where project_id = $1", [h.home.id]), 0)
  assert.equal(await h.count("outbox where job_type = 'process_drawing_set'"), 0)
})

test("a failed processor is not replaced by replaying publication", async (t) => {
  const h = await publication(t)
  const first = await h.publish()
  await h.asWorker(false)
  await h.db.query("update outbox set status = 'failed' where id = $1", [first.job_id])
  await h.asWorker(true)

  await assert.rejects(h.publish(), /processing failed/)

  assert.equal(await h.count("drawing_revisions where project_id = $1", [h.home.id]), 1)
})

test("browsers cannot reserve or publish a plan drawing copy", async (t) => {
  const h = await publication(t)
  await h.asWorker(false)
  const member = { role: "authenticated", userId: h.actorId }

  await assert.rejects(h.publish(h.copy, h.actorId, member), /permission denied for function publish_plan_drawing_copy/)
  await assert.rejects(
    rpc(
      h.db,
      "reserve_plan_drawing_copy",
      {
        p_org_id: h.orgId,
        p_project_id: h.home.id,
        p_plan_version_id: h.version.id,
        p_actor_id: h.actorId,
        p_source_evidence: SOURCE_EVIDENCE,
      },
      member,
    ),
    /permission denied for function reserve_plan_drawing_copy/,
  )
})

test("a reservation is durable and the ledger advances only for new work", async (t) => {
  const h = await publication(t)

  const reserved = await h.reserve()
  assert.equal(reserved.attempt_id, h.copy.attempt_id)
  assert.equal(reserved.storage_path, h.copy.storage_path)
  let ledger = (await h.ledger()).plan_instantiation
  assert.equal(ledger.seq, 1)
  assert.equal(ledger.drawing_copy_attempt.status, "reserved")

  await h.publish()
  const recovered = await h.reserve()
  assert.equal(recovered.status, "published")
  assert.equal(recovered.attempt_id, reserved.attempt_id)
  ledger = (await h.ledger()).plan_instantiation
  assert.equal(ledger.seq, 2)
  assert.equal(ledger.drawing_copy_attempt.receipt.file_id, recovered.receipt.file_id)

  await h.publish()
  assert.equal((await h.ledger()).plan_instantiation.seq, 2)
})

test("a stale whole-metadata instantiation write misses once a reservation advanced the sequence", async (t) => {
  const h = await publication(t)
  await h.asWorker(false)

  const stale = await h.db.query(
    "update projects set metadata = '{}' where id = $1 and metadata->'plan_instantiation'->>'seq' is null returning id",
    [h.home.id],
  )

  assert.equal(stale.rows.length, 0)
})

test("changed source evidence or a malformed reservation cannot open another destination", async (t) => {
  const h = await publication(t)

  await assert.rejects(h.reserve({ size_bytes: 100, source_etag: "replacement" }), /differs/)
  await assert.rejects(h.reserve({ size_bytes: 101, source_etag: "source" }), /differs from file record/)

  await h.asWorker(false)
  await h.db.query(
    `update projects
     set metadata = jsonb_set(metadata, '{plan_instantiation,drawing_copy_attempt}',
       (metadata->'plan_instantiation'->'drawing_copy_attempt') - 'status')
     where id = $1`,
    [h.home.id],
  )
  await h.asWorker(true)
  await assert.rejects(h.reserve(), /differs/)
  await assert.rejects(h.publish(), /not reserved/)

  assert.equal(await h.homeFiles(), 0)
})

test("a rolled-back publication keeps the reservation and unrelated project metadata", async (t) => {
  const h = await publication(t)
  await h.asWorker(false)
  await h.db.query(`update projects set metadata = metadata || '{"unrelated": "kept"}' where id = $1`, [h.home.id])
  await failDrawingQueue(h.db)
  await h.asWorker(true)

  await assert.rejects(h.publish(), /queue unavailable/)
  let metadata = await h.ledger()
  assert.equal(metadata.unrelated, "kept")
  assert.equal(metadata.plan_instantiation.seq, 1)
  assert.equal(metadata.plan_instantiation.drawing_copy_attempt.status, "reserved")

  await h.db.exec("drop trigger test_reject_drawing_queue on outbox")
  await h.publish()
  metadata = await h.ledger()
  assert.equal(metadata.unrelated, "kept")
  assert.equal(metadata.plan_instantiation.seq, 2)
})

test("a corrupted published receipt is refused instead of publishing again", async (t) => {
  const h = await publication(t)
  await h.publish()
  await h.asWorker(false)
  await h.db.query(
    `update projects
     set metadata = jsonb_set(metadata, '{plan_instantiation,drawing_copy_attempt,receipt}', '{}')
     where id = $1`,
    [h.home.id],
  )
  await h.asWorker(true)

  await assert.rejects(h.reserve(), /receipt requires repair/)
  await assert.rejects(h.publish(), /manifest is incomplete/)
  assert.equal(await h.count("drawing_revisions where project_id = $1", [h.home.id]), 1)
})

test("publication is refused once the lot moves to another home or community", async (t) => {
  const h = await publication(t)
  const elsewhere = await insert(h.db, "communities", { org_id: h.orgId, name: "Elsewhere" })
  const moveLot = async (columns) => {
    await h.asWorker(false)
    await h.db.query("update lots set project_id = $1, community_id = $2 where id = $3", [
      columns.project,
      columns.community,
      h.lot.id,
    ])
    await h.asWorker(true)
  }

  await moveLot({ project: h.otherHome.id, community: h.community.id })
  await assert.rejects(h.publish(), /home ancestry differs from package/)

  await moveLot({ project: h.home.id, community: elsewhere.id })
  await assert.rejects(h.publish(), /lot ancestry differs from package/)
})

// ---------------------------------------------------------------------------
// Child jobs the release fans out
// ---------------------------------------------------------------------------

/** A publication whose home has a trade company assigned on its schedule. */
async function fanout(t) {
  const h = await publication(t)
  await h.asWorker(false)
  h.vendor = await insert(h.db, "companies", { org_id: h.orgId, name: "Framing Co" })
  const item = await insert(h.db, "schedule_items", { org_id: h.orgId, project_id: h.home.id, name: "Framing" })
  await insert(h.db, "schedule_assignments", {
    org_id: h.orgId,
    project_id: h.home.id,
    schedule_item_id: item.id,
    company_id: h.vendor.id,
  })
  await h.asWorker(true)
  h.enqueue = (jobType, payload) =>
    h.service((tx) => insert(tx, "outbox", { org_id: h.orgId, job_type: jobType, payload }))
  h.notice = (payload = {}) =>
    h.enqueue("start_release_trade_notice", {
      start_package_id: h.pkg.id,
      actor_id: h.actorId,
      company_id: h.vendor.id,
      ...payload,
    })
  return h
}

test("a release fans out its drawing job and a notice to an assigned vendor", async (t) => {
  const h = await fanout(t)

  await h.publish()
  await h.notice()

  assert.equal(await h.count("outbox where job_type in ('process_drawing_set', 'start_release_trade_notice')"), 2)
})

test("release notices stay within the claimed package, actor and assigned vendors", async (t) => {
  const h = await fanout(t)
  await h.asWorker(false)
  const unassigned = await insert(h.db, "companies", { org_id: h.orgId, name: "Roofing Co" })
  await h.asWorker(true)

  await assert.rejects(h.notice({ start_package_id: h.home.id }), /notice scope mismatch/)
  await assert.rejects(h.notice({ actor_id: h.home.id }), /notice scope mismatch/)
  await assert.rejects(h.notice({ company_id: h.home.id }), /vendor mismatch/)
  await assert.rejects(h.notice({ company_id: unassigned.id }), /not assigned to this home/)
  await assert.rejects(h.enqueue("issue_invoice", {}), /job family/)

  await h.asWorker(false)
  await h.db.query("delete from schedule_assignments where company_id = $1", [h.vendor.id])
  await h.asWorker(true)
  await assert.rejects(h.notice(), /not assigned to this home/)
})

test("a fanned-out drawing job must match the published file, set and revision", async (t) => {
  const h = await fanout(t)
  const receipt = await h.publish()
  const { payload } = (await h.db.query("select payload from outbox where id = $1", [receipt.job_id])).rows[0]

  const forged = [
    ["projectId", h.otherHome.id, /scope mismatch/],
    ["storagePath", "wrong", /file mismatch/],
    ["drawingSetId", h.otherHome.id, /set mismatch/],
    ["draftRevisionId", h.otherHome.id, /revision mismatch/],
  ]
  for (const [key, value, refusal] of forged) {
    await assert.rejects(h.enqueue("process_drawing_set", { ...payload, [key]: value }), refusal, key)
  }
  await assert.rejects(
    h.service((tx) => tx.query("delete from outbox where id = $1", [receipt.job_id])),
    /cannot mutate other jobs/,
  )
  await assert.rejects(
    h.service((tx) => tx.query("update outbox set payload = '{}' where id = $1", [receipt.job_id])),
    /cannot mutate other jobs/,
  )
})

test("the release job heartbeats while releasing and completes once released, but never swaps its payload", async (t) => {
  const h = await fanout(t)
  const transition = (action) =>
    rpc(h.db, "transition_starts_job_lease", {
      p_org_id: h.orgId,
      p_id: h.job.job_id,
      p_token: h.job.claim_token,
      p_action: action,
    })

  assert.equal(await transition("heartbeat"), true)
  await assert.rejects(
    h.service((tx) => tx.query("update outbox set payload = '{}' where id = $1", [h.job.job_id])),
    /identity or payload/,
  )

  await h.asWorker(false)
  await h.db.query("update start_packages set status = 'released' where id = $1", [h.pkg.id])
  await h.asWorker(true)
  assert.equal(await transition("complete"), true)
  await assert.rejects(h.notice(), /worker lease lost/)
})

test("browsers cannot queue drawing jobs; server writers without worker headers can", async (t) => {
  const h = await fanout(t)
  await h.asWorker(false)
  const drawingJob = (caller) =>
    asRole(h.db, caller, (tx) =>
      insert(tx, "outbox", { org_id: h.orgId, job_type: "process_drawing_set", payload: {} }),
    )

  await assert.rejects(drawingJob({ role: "authenticated", userId: h.actorId }), /authorized server writers/)
  await drawingJob({ role: "service_role" })
})

// ---------------------------------------------------------------------------
// Cleanup: a reservation whose copy was never published is abandoned, its
// object deleted, and its manifest cleared — never one a file references.
// ---------------------------------------------------------------------------

test("an abandoned drawing copy is claimed only once it is old, unclaimed and unreferenced", async (t) => {
  const h = await publication(t)
  const claim = () => rpc(h.db, "claim_abandoned_plan_drawing_copies", { p_limit: 25 })
  await h.asWorker(false)

  assert.deepEqual(await claim(), [], "a fresh reservation may still be copying")
  await h.db.query(
    "update projects set metadata = jsonb_set(metadata, '{plan_instantiation,drawing_copy_attempt,reserved_at}', to_jsonb(now() - interval '2 days')) where id = $1",
    [h.home.id],
  )
  assert.deepEqual(await claim(), [], "a live release of the home may resume it")

  await h.expireLease()
  const file = await insert(h.db, "files", { org_id: h.orgId, project_id: h.home.id, file_name: "plan.pdf", storage_path: h.copy.storage_path })
  assert.deepEqual(await claim(), [], "a file naming the path is a published copy")
  await h.db.query("update files set storage_path = $1 where id = $2", [`${h.orgId}/elsewhere.pdf`, file.id])

  const claimed = await claim()
  assert.deepEqual(claimed.map((row) => row.storage_path), [h.copy.storage_path])
  assert.equal((await h.ledger()).plan_instantiation.drawing_copy_attempt.status, "abandoned")
  await assert.rejects(h.publish(), /not reserved with this evidence/)
  assert.equal((await claim()).length, 1, "a sweep lost before clearing claims it again")
})

test("clearing an abandoned copy frees the home for a new reservation, unless a file references it", async (t) => {
  const h = await publication(t)
  await h.asWorker(false)
  await h.expireLease()
  await h.db.query(
    "update projects set metadata = jsonb_set(metadata, '{plan_instantiation,drawing_copy_attempt,reserved_at}', to_jsonb(now() - interval '2 days')) where id = $1",
    [h.home.id],
  )
  const [copy] = await rpc(h.db, "claim_abandoned_plan_drawing_copies", { p_limit: 25 })
  const clear = () => rpc(h.db, "clear_abandoned_plan_drawing_copy", { p_org_id: h.orgId, p_project_id: h.home.id, p_attempt_id: copy.attempt_id })

  const file = await insert(h.db, "files", { org_id: h.orgId, project_id: h.home.id, file_name: "plan.pdf", storage_path: copy.storage_path })
  await assert.rejects(clear(), /referenced by a file/)
  await h.db.query("update files set storage_path = $1 where id = $2", [`${h.orgId}/elsewhere.pdf`, file.id])

  assert.equal(await clear(), true)
  assert.equal((await h.ledger()).plan_instantiation.drawing_copy_attempt, undefined)
  assert.equal(await clear(), false, "clearing twice is a no-op")
  const next = await h.reserve()
  assert.notEqual(next.attempt_id, copy.attempt_id)
})
