"use strict"

/**
 * The Documents database contract (docs/reference/document-transfers.md):
 * atomic upload and version commits, version deletion with durable blob
 * cleanup, folder renames, preview/search artifact patches, expired transfer
 * fencing, share-link visits, and the move/archive/restore mutations with
 * their Undo receipts. The server calls every function as `service_role`
 * (lib/services/files.ts, file-versions.ts, document-mutations.ts).
 *
 * One migrated database serves the suite; every test works in its own org.
 */

const test = require("node:test")
const assert = require("node:assert/strict")
const { randomUUID } = require("node:crypto")

const { asRole, createDatabase, insert, rpc, seedMember } = require("./support/pglite")

let db
test.before(async () => {
  db = await createDatabase()
})
test.after(() => db.close())

const one = async (sql, params) => (await db.query(sql, params)).rows[0]

/** An org with one project and the server's document calls bound to it. */
async function library() {
  const { orgId, userId } = await seedMember(db)
  const project = await insert(db, "projects", { org_id: orgId, name: "Lot 12" })
  const lib = {
    orgId,
    userId,
    project,
    path: (name) => `${orgId}/${project.id}/documents/uploads/${name}`,
    upload: (name, file = {}) =>
      rpc(db, "commit_document_upload", {
        p_org_id: orgId,
        p_actor_id: userId,
        p_file: {
          project_id: project.id,
          file_name: "Drawing.pdf",
          storage_path: lib.path(name),
          mime_type: "application/pdf",
          size_bytes: 5,
          folder_path: "/A_B",
          ...file,
        },
      }),
    commitVersion: (fileId, storagePath) =>
      rpc(db, "commit_document_version", {
        p_org_id: orgId,
        p_file_id: fileId,
        p_actor_id: userId,
        p_version: { storage_path: storagePath, file_name: "revision.pdf", size_bytes: 8 },
      }),
    count: async (table, where = "true", params = []) =>
      Number((await one(`select count(*) as n from ${table} where org_id = $1 and ${where}`, [orgId, ...params])).n),
  }
  return lib
}

/** Raise `message` from every insert into `table` while `work` runs. */
async function failingInserts(table, message, work) {
  await db.exec(`
    create function test_fail_insert() returns trigger language plpgsql as $$ begin raise exception '${message}'; end $$;
    create trigger test_fail_insert before insert on ${table} for each row execute function test_fail_insert();
  `)
  try {
    await work()
  } finally {
    await db.exec(`drop trigger test_fail_insert on ${table}; drop function test_fail_insert()`)
  }
}

// ---------------------------------------------------------------------------
// Access
// ---------------------------------------------------------------------------

test("document functions and their receipts are reachable only by the server", async () => {
  const functions = [
    "public.commit_document_upload(uuid,uuid,jsonb)",
    "public.commit_document_version(uuid,uuid,uuid,jsonb,boolean)",
    "public.patch_document_artifact(uuid,uuid,text,text,jsonb,text)",
    "public.mutate_documents(uuid,uuid,uuid[],jsonb,text,text,boolean)",
    "public.undo_document_mutation(uuid,uuid,uuid)",
    "public.claim_file_share_visit(text,uuid)",
  ]
  const tables = ["public.document_upload_commits", "public.document_mutation_receipts", "public.document_upload_transfers"]
  for (const role of ["anon", "authenticated", "service_role"]) {
    const server = role === "service_role"
    for (const fn of functions) {
      assert.equal((await one("select has_function_privilege($1, $2, 'execute') as ok", [role, fn])).ok, server, `${role} ${fn}`)
    }
    for (const table of tables) {
      assert.equal((await one("select has_table_privilege($1, $2, 'select') as ok", [role, table])).ok, server, `${role} ${table}`)
    }
  }
})

// ---------------------------------------------------------------------------
// Uploads and versions
// ---------------------------------------------------------------------------

test("committing the same stored object twice yields one file, one version and one event", async () => {
  const lib = await library()

  const first = await lib.upload("first.pdf")
  const again = await lib.upload("first.pdf")

  assert.equal(again.id, first.id)
  assert.equal(await lib.count("files"), 1)
  assert.equal(await lib.count("doc_versions"), 1)
  assert.equal(await lib.count("events", "entity_id = $2", [first.id]), 1)
})

test("a failed initial version leaves no file behind", async () => {
  const lib = await library()

  await failingInserts("doc_versions", "injected", () => assert.rejects(lib.upload("failed.pdf"), /injected/))

  assert.equal(await lib.count("files"), 0)
})

test("a retried version commit returns the original without demoting the newer current version", async () => {
  const lib = await library()
  const file = await lib.upload("v1.pdf")

  const second = await lib.commitVersion(file.id, lib.path("v2.pdf"))
  const third = await lib.commitVersion(file.id, lib.path("v3.pdf"))
  const retry = await lib.commitVersion(file.id, lib.path("v2.pdf"))

  assert.equal(retry.id, second.id)
  assert.equal(retry.is_current, false)
  assert.equal((await one("select current_version_id from files where id = $1", [file.id])).current_version_id, third.id)
  await assert.rejects(rpc(db, "delete_document_version", { p_org_id: lib.orgId, p_version_id: third.id }), /current version/)
})

test("deleting a version queues its blob and retires its storage identity for good", async () => {
  const lib = await library()
  const file = await lib.upload("v1.pdf")
  const old = await lib.commitVersion(file.id, lib.path("v2.pdf"))
  await lib.commitVersion(file.id, lib.path("v3.pdf"))

  await rpc(db, "delete_document_version", { p_org_id: lib.orgId, p_version_id: old.id })

  assert.equal(await lib.count("outbox", "job_type = 'delete_file_blob' and payload->>'storagePath' = $2", [old.storage_path]), 1)
  await assert.rejects(
    rpc(db, "promote_document_version", { p_org_id: lib.orgId, p_file_id: file.id, p_version_id: old.id }),
    /not found/,
  )
  await assert.rejects(lib.commitVersion(file.id, old.storage_path), /deleted/)
  // The upload receipt still names its original file; it never mints another.
  assert.equal((await lib.upload("v2.pdf")).id, file.id)
})

test("a reserved version object cannot be rebound to another file", async () => {
  const lib = await library()
  const file = await lib.upload("v1.pdf")
  const version = await lib.commitVersion(file.id, lib.path("v2.pdf"))
  const other = await lib.upload("other.pdf")

  await assert.rejects(lib.commitVersion(other.id, version.storage_path), /another file/)
})

test("renaming a folder moves its subtree literally, leaving wildcard-lookalike siblings", async () => {
  const lib = await library()
  const inside = await lib.upload("inside.pdf", { folder_path: "/A_B/child" })
  const lookalike = await lib.upload("lookalike.pdf", { folder_path: "/AxB/child" })

  await rpc(db, "rename_project_file_folder_paths", {
    p_org_id: lib.orgId,
    p_project_id: lib.project.id,
    p_old_path: "/A_B",
    p_new_path: "/Renamed",
    p_actor_id: lib.userId,
  })

  const folder = async (file) => (await one("select folder_path from files where id = $1", [file.id])).folder_path
  assert.equal(await folder(inside), "/Renamed/child")
  assert.equal(await folder(lookalike), "/AxB/child")
})

test("preview and search artifacts merge independently and ignore a superseded source", async () => {
  const lib = await library()
  const file = await lib.upload("current.pdf")
  const patch = (kind, storagePath, value) =>
    rpc(db, "patch_document_artifact", {
      p_org_id: lib.orgId,
      p_file_id: file.id,
      p_storage_path: storagePath,
      p_kind: kind,
      p_value: value,
    })

  await patch("preview", file.storage_path, { status: "ready" })
  await patch("search", file.storage_path, { extracted_text: "current" })
  assert.equal(await patch("preview", lib.path("stale.pdf"), { status: "failed" }), false)

  const { metadata } = await one("select metadata from files where id = $1", [file.id])
  assert.equal(metadata.preview.status, "ready")
  assert.equal(metadata.search.extracted_text, "current")
})

test("an expired, uncommitted transfer is fenced off; a committed one is kept", async () => {
  const lib = await library()
  await lib.upload("committed.pdf")
  const transfer = (name) =>
    insert(db, "document_upload_transfers", {
      id: randomUUID(),
      org_id: lib.orgId,
      project_id: lib.project.id,
      created_by: lib.userId,
      identity: `sha256-chain-v1:1:${"a".repeat(64)}`,
      file_name: name,
      content_type: "application/pdf",
      file_size: 5,
      storage_path: lib.path(name),
      mode: "single",
      expires_at: new Date(Date.now() - 60_000).toISOString(),
    })
  const orphan = await transfer("abandoned.pdf")
  const committed = await transfer("committed.pdf")
  const expire = (row) => rpc(db, "expire_document_transfer", { p_org_id: lib.orgId, p_transfer_id: row.id })

  assert.equal(await expire(committed), false)
  assert.equal(await expire(orphan), true)

  await assert.rejects(lib.upload("abandoned.pdf"), /deleted/)
  assert.ok((await one("select cancelled_at from document_upload_transfers where id = $1", [orphan.id])).cancelled_at)
  assert.equal(await lib.count("outbox", "dedupe_key = $2", [`cleanup_document_transfer:final:${orphan.id}`]), 1)
})

test("a share link admits its last allowed visit once, and revocation ends that visit", async () => {
  const lib = await library()
  const file = await lib.upload("shared.pdf")
  const token = `token-${randomUUID()}`
  await insert(db, "file_share_links", { org_id: lib.orgId, file_id: file.id, token, max_uses: 1 })
  const claim = (visitId = null) => rpc(db, "claim_file_share_visit", { p_token: token, p_visit_id: visitId })

  const visit = await claim()
  assert.ok(visit.visit_id)
  assert.equal(await claim(), null, "no second visit")
  assert.equal((await claim(visit.visit_id)).visit_id, visit.visit_id, "the admitted visit can still download")

  await db.query("update file_share_links set revoked_at = now() where token = $1", [token])
  assert.equal(await claim(visit.visit_id), null)
})

// ---------------------------------------------------------------------------
// Move, archive, restore and Undo
// ---------------------------------------------------------------------------

/** Two files in /Original, shared with clients only, and the mutation calls. */
async function shelf() {
  const lib = await library()
  const file = (name) =>
    insert(db, "files", {
      org_id: lib.orgId,
      project_id: lib.project.id,
      file_name: name,
      storage_path: lib.path(name),
      folder_path: "/Original",
      share_with_clients: true,
      share_with_subs: false,
      visibility: "private",
    })
  const first = await file("a.pdf")
  const second = await file("b.pdf")
  const ids = [first.id, second.id]
  const scopes = (fileIds) => Object.fromEntries(fileIds.map((fileId) => [fileId, lib.project.id]))
  return {
    ...lib,
    first,
    second,
    mutate: (kind = "move", fileIds = ids, folder = "/Target", scope = scopes(fileIds), actor = { role: "service_role" }) =>
      rpc(
        db,
        "mutate_documents",
        {
          p_org_id: lib.orgId,
          p_actor_id: lib.userId,
          p_file_ids: fileIds,
          p_scopes: scope,
          p_kind: kind,
          p_folder_path: folder,
          p_apply_folder_defaults: true,
        },
        actor,
      ),
    undo: (receiptId, actorId = lib.userId) =>
      rpc(db, "undo_document_mutation", { p_org_id: lib.orgId, p_actor_id: actorId, p_receipt_id: receiptId }),
    row: (file) => one("select * from files where id = $1", [file.id]),
  }
}

test("a move adopts the target folder's sharing; undo restores the exact prior state once", async () => {
  const s = await shelf()
  await insert(db, "project_file_folder_permissions", {
    org_id: s.orgId,
    project_id: s.project.id,
    path: "/Target",
    share_with_clients: false,
    share_with_subs: true,
  })

  const moved = await s.mutate()

  assert.ok(moved.receiptId)
  assert.deepEqual(moved.projectIds, [s.project.id])
  let row = await s.row(s.first)
  assert.deepEqual([row.folder_path, row.share_with_clients, row.share_with_subs, row.visibility], ["/Target", false, true, "private"])
  assert.equal(await s.count("project_file_folders", "path = '/Target'"), 1)

  const restored = await s.undo(moved.receiptId)
  row = await s.row(s.first)
  assert.deepEqual([row.folder_path, row.share_with_clients, row.share_with_subs], ["/Original", true, false])
  assert.deepEqual(await s.undo(moved.receiptId), restored, "undo is idempotent")
  assert.equal(await s.count("audit_log", "entity_id = any($2::uuid[])", [[s.first.id, s.second.id]]), 4)
})

test("one unknown or foreign file refuses the whole selection", async () => {
  const s = await shelf()
  const stranger = await shelf()

  for (const bad of [randomUUID(), stranger.first.id]) {
    await assert.rejects(s.mutate("move", [s.first.id, bad]), /unavailable/)
  }

  assert.equal((await s.row(s.first)).folder_path, "/Original")
  assert.equal(await s.count("document_mutation_receipts"), 0)
  assert.equal(await s.count("audit_log", "entity_id = $2", [s.first.id]), 0)
})

test("a project scope that no longer matches the service's check fails closed", async () => {
  const s = await shelf()
  const other = await insert(db, "projects", { org_id: s.orgId, name: "Lot 13" })

  await assert.rejects(
    s.mutate("move", [s.first.id, s.second.id], "/Target", { [s.first.id]: s.project.id, [s.second.id]: other.id }),
    /scope changed/,
  )
  await assert.rejects(s.mutate("move", [s.first.id], "/Target", {}), /scope changed/)
  assert.equal((await s.row(s.first)).folder_path, "/Original")
})

test("a no-op or duplicated selection writes nothing extra", async () => {
  const s = await shelf()
  const nothing = { receiptId: null, projectIds: [], files: [] }

  assert.deepEqual(await s.mutate("move", [s.first.id, s.first.id], "/Original"), nothing)
  assert.deepEqual(await s.mutate("move", []), nothing)
  assert.equal(await s.count("document_mutation_receipts"), 0)
  assert.equal((await s.mutate("move", [s.first.id, s.first.id])).files.length, 1)
})

test("undo refuses to overwrite newer work on any file, and changes none of them", async () => {
  const s = await shelf()
  const moved = await s.mutate()
  await db.query("update files set file_name = 'newer.pdf' where id = $1", [s.second.id])

  await assert.rejects(s.undo(moved.receiptId), /newer work/)

  assert.equal((await s.row(s.first)).folder_path, "/Target")
  assert.equal((await s.row(s.second)).file_name, "newer.pdf")
  assert.equal((await one("select undone_at from document_mutation_receipts where id = $1", [moved.receiptId])).undone_at, null)
})

test("a receipt can be undone only by its actor, and only inside its window", async () => {
  const s = await shelf()
  const moved = await s.mutate()

  await assert.rejects(s.undo(moved.receiptId, randomUUID()), /unavailable/)
  await db.query("update document_mutation_receipts set expires_at = now() - interval '1 second' where id = $1", [moved.receiptId])
  await assert.rejects(s.undo(moved.receiptId), /expired/)
  assert.equal((await s.row(s.first)).folder_path, "/Target")
})

test("archive and restore keep sharing, and undo returns the exact archived state", async () => {
  const s = await shelf()
  const archived = await s.mutate("archive")
  const { archived_at: archivedAt, share_with_clients: shared } = await s.row(s.first)
  assert.ok(archivedAt)
  assert.equal(shared, true)
  assert.equal((await s.mutate("archive")).receiptId, null, "archiving again changes nothing")

  const restored = await s.mutate("restore")
  assert.equal((await s.row(s.first)).archived_at, null)
  await s.undo(restored.receiptId)

  assert.deepEqual((await s.row(s.first)).archived_at, archivedAt)
  await assert.rejects(s.undo(archived.receiptId), /newer work/)
})

test("a client role cannot run a mutation even with valid arguments", async () => {
  const s = await shelf()
  for (const role of ["anon", "authenticated"]) {
    await assert.rejects(
      s.mutate("move", [s.first.id], "/Target", undefined, { role, userId: s.userId }),
      /permission denied/,
    )
    await assert.rejects(
      asRole(db, { role, userId: s.userId }, (tx) => tx.query("select * from document_mutation_receipts")),
      /permission denied/,
    )
  }
})

test("an audit failure rolls back every file, event and receipt of the mutation", async () => {
  const s = await shelf()

  await failingInserts("audit_log", "Audit unavailable", () => assert.rejects(s.mutate(), /Audit unavailable/))

  assert.equal((await s.row(s.first)).folder_path, "/Original")
  assert.equal((await s.row(s.second)).folder_path, "/Original")
  assert.equal(await s.count("document_mutation_receipts"), 0)
  assert.equal(await s.count("events", "entity_id = any($2::uuid[])", [[s.first.id, s.second.id]]), 0)
})
