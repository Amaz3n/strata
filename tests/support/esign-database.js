"use strict"

/**
 * E-signature services against the REAL schema.
 *
 * Signing is enforced by SQL (acceptance, execution leases, delivery
 * reconciliation, trusted-writer guards), so its service tests run the real
 * services against PGlite with every migration applied (./pglite.js), through
 * a PostgREST-shaped client:
 *
 *   const db = await createDatabase(t)
 *   const client = createDatabaseClient(db)
 *   const signing = await seedSigningDocument(db)
 *   await runWithServiceSupabaseClient(client, () => finalizeDocumentSigning(signing.orgId, signing.requestId))
 *
 * The client speaks only the subset of PostgREST these services use: plain
 * column lists (no embedded resources), equality/range/IN filters, ordering,
 * single/maybeSingle, and `rpc` with named arguments. Table reads and writes
 * run as the superuser (the service role bypasses RLS too); RPCs run as
 * `service_role`, so a function the service role may not execute fails here
 * as it does in production. Errors come back as `{ data: null, error }`.
 *
 * `createObjectStore()` stands in for the R2 files bucket.
 *
 * GENERALISATION: `createDatabaseClient` is not e-sign specific. If a second
 * area needs a real-schema PostgREST client it belongs in ./pglite.js.
 */

const { insert, rpc, seedMember, uuid } = require("./pglite")

const NUMERIC = 1700
const INT8 = 20
/** PostgREST answers numeric and bigint columns as JSON numbers. */
const parsers = { [NUMERIC]: Number, [INT8]: Number }

/** Rows as PostgREST serialises them: timestamps as ISO strings, json as values. */
const asJson = (value) => JSON.parse(JSON.stringify(value ?? null))

/** jsonb arguments are sent as JSON text; scalars and arrays pass through. */
function sqlValue(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date)
    ? JSON.stringify(value)
    : value
}

function failure(error) {
  return { data: null, error: { message: error.message, code: error.code } }
}

function createQuery(db, table) {
  const filters = []
  const orderings = []
  let columns = "*"
  let action = "select"
  let payload = null
  let returning = false
  let cardinality = null
  let limit = null

  const query = {
    select(list = "*") {
      columns = list
      returning = true
      return query
    },
    insert(values) {
      action = "insert"
      payload = values
      return query
    },
    update(values) {
      action = "update"
      payload = values
      return query
    },
    eq: (column, value) => filter(column, "=", value),
    neq: (column, value) => filter(column, "<>", value),
    lt: (column, value) => filter(column, "<", value),
    lte: (column, value) => filter(column, "<=", value),
    gt: (column, value) => filter(column, ">", value),
    gte: (column, value) => filter(column, ">=", value),
    in: (column, values) => filter(column, "in", values),
    is: (column, value) => filter(column, "is", value),
    order(column, options = {}) {
      orderings.push(`${column} ${options.ascending === false ? "desc" : "asc"}`)
      return query
    },
    limit(count) {
      limit = count
      return query
    },
    single() {
      cardinality = "single"
      return query
    },
    maybeSingle() {
      cardinality = "maybe"
      return query
    },
    then(resolve, reject) {
      return run().then(resolve, reject)
    },
  }

  function filter(column, operator, value) {
    filters.push({ column, operator, value })
    return query
  }

  async function run() {
    const args = []
    const bind = (value) => {
      args.push(sqlValue(value))
      return `$${args.length}`
    }
    const where = filters.map(({ column, operator, value }) => {
      if (operator === "in") return value.length ? `${column} in (${value.map(bind).join(", ")})` : "false"
      if (operator === "is") return `${column} is ${value === null ? "null" : bind(value)}`
      return `${column} ${operator} ${bind(value)}`
    })
    const whereSql = where.length ? ` where ${where.join(" and ")}` : ""
    let sql
    if (action === "insert") {
      const rows = Array.isArray(payload) ? payload : [payload]
      const keys = Object.keys(rows[0])
      const values = rows.map((row) => `(${keys.map((key) => bind(row[key])).join(", ")})`)
      sql = `insert into public.${table} (${keys.join(", ")}) values ${values.join(", ")} returning ${columns}`
    } else if (action === "update") {
      const assignments = Object.entries(payload).map(([key, value]) => `${key} = ${bind(value)}`)
      sql = `update public.${table} set ${assignments.join(", ")}${whereSql} returning ${columns}`
    } else {
      const order = orderings.length ? ` order by ${orderings.join(", ")}` : ""
      sql = `select ${columns} from public.${table}${whereSql}${order}${limit === null ? "" : ` limit ${limit}`}`
    }
    let rows
    try {
      rows = asJson((await db.query(sql, args, { parsers })).rows)
    } catch (error) {
      return failure(error)
    }
    if (!returning && action !== "select") return { data: null, error: null }
    if (cardinality === "single" && rows.length !== 1) {
      return { data: null, error: { message: "JSON object requested, multiple (or no) rows returned" } }
    }
    if (cardinality === "maybe" && rows.length > 1) {
      return { data: null, error: { message: "JSON object requested, multiple rows returned" } }
    }
    return { data: cardinality ? rows[0] ?? null : rows, error: null }
  }

  return query
}

/** A Supabase client whose every call lands in `db`. */
function createDatabaseClient(db) {
  return {
    from: (table) => createQuery(db, table),
    async rpc(name, args = {}) {
      const values = Object.fromEntries(Object.entries(args).map(([key, value]) => [key, sqlValue(value)]))
      try {
        return { data: asJson(await rpc(db, name, values)), error: null }
      } catch (error) {
        return failure(error)
      }
    },
  }
}

/** An in-memory files bucket. Objects are write-once, as the services require. */
function createObjectStore() {
  const store = { objects: new Map(), uploads: 0, failNextUpload: false }
  store.module = {
    getFilesStorageProvider: () => "r2",
    buildOrgScopedPath: (...parts) => parts.join("/"),
    async downloadFilesObject({ path }) {
      if (!store.objects.has(path)) throw new Error(`Missing object ${path}`)
      return store.objects.get(path)
    },
    async uploadFilesObject({ path, bytes }) {
      if (store.failNextUpload) {
        store.failNextUpload = false
        throw new Error("object-store failure")
      }
      if (store.objects.has(path)) throw new Error(`Object ${path} already exists`)
      store.uploads += 1
      store.objects.set(path, new Uint8Array(bytes))
    },
  }
  return store
}

/**
 * One draft signing document on a project: its source file, an envelope with
 * one signer (`signer_role`), one required field for that signer, and the
 * signer's request and recipient rows. Pass `tokenHash` for the invitation.
 */
async function seedSigningDocument(db, options = {}) {
  const { orgId, userId } = await seedMember(db)
  const signerRole = options.signerRole ?? "owner"
  const email = options.email ?? "owner@example.test"
  const project = await insert(db, "projects", { org_id: orgId, name: "Fixture project" })
  const file = await insert(db, "files", {
    org_id: orgId,
    project_id: project.id,
    file_name: "source.pdf",
    storage_path: `${orgId}/source.pdf`,
    mime_type: "application/pdf",
  })
  const document = await insert(db, "documents", {
    org_id: orgId,
    project_id: project.id,
    title: options.title ?? "Fixture agreement",
    document_type: "contract",
    source_file_id: file.id,
    metadata: JSON.stringify(options.metadata ?? {}),
  })
  const envelope = await insert(db, "envelopes", { org_id: orgId, project_id: project.id, document_id: document.id })
  const field = await insert(db, "document_fields", {
    org_id: orgId,
    document_id: document.id,
    page_index: 0,
    field_type: "name",
    signer_role: signerRole,
    x: 0.1,
    y: 0.1,
    w: 0.5,
    h: 0.1,
  })
  const recipient = await insert(db, "envelope_recipients", {
    org_id: orgId,
    envelope_id: envelope.id,
    email,
    name: "Owner",
    signer_role: signerRole,
  })
  const request = await insert(db, "document_signing_requests", {
    id: options.requestId ?? uuid(),
    org_id: orgId,
    document_id: document.id,
    revision: 1,
    token_hash: options.tokenHash ?? "fixture-invitation",
    envelope_id: options.legacyGroup ? null : envelope.id,
    group_id: envelope.id,
    envelope_recipient_id: recipient.id,
    signer_role: signerRole,
    sent_to_email: email,
  })
  return {
    orgId,
    userId,
    projectId: project.id,
    sourceFileId: file.id,
    sourcePath: file.storage_path,
    documentId: document.id,
    envelopeId: envelope.id,
    fieldId: field.id,
    requestId: request.id,
  }
}

module.exports = { createDatabaseClient, createObjectStore, seedSigningDocument }
