"use strict"

/**
 * Service-tier harness: call a real exported service as a real actor, against
 * the in-memory fake database.
 *
 *   const { createServiceHarness, replies, id, ORG, ACTOR } = require("./support/service")
 *   const { listTakeoffConditions } = freshRequire("lib/services/takeoff.ts")
 *
 *   const service = createServiceHarness({
 *     tables: { projects: [{ id: PROJECT, org_id: ORG }], takeoff_conditions: [...] },
 *     permissions: ["takeoff.read", "project.read"],
 *   })
 *   const rows = await service.run(() => listTakeoffConditions({ project_id: PROJECT }))
 *   assert.deepEqual(service.writes(), [])
 *
 *   service.tamper("takeoff_conditions", replies.error())   // the next read fails
 *   await assert.rejects(service.run(() => listTakeoffConditions({ project_id: PROJECT })))
 *
 * What is real: the service, `requireOrgContext()` (via
 * `runWithServiceOrgContext`), and the whole RBAC path — `requirePermission()`
 * and `requireAuthorization()` read the actor's `memberships` row and its role
 * permissions out of the fake, exactly as they read them from Postgres. The
 * only RBAC shortcut is the permission catalog: every key is treated as known,
 * because whether a key exists is the RBAC suite's concern, not the service's.
 * `projects` / `divisions` narrow the actor the way an assigned-only membership
 * does; `service.grant()` changes access mid-test (revocation).
 *
 * What is captured: `recordAudit()` and `recordEvent()` are replaced by
 * recorders (`service.audits`, `service.events`) — their own fan-out has its own
 * suites. Every query the service runs is recorded in `service.queries`;
 * `writes()` and `reads()` filter it to prove that something did NOT happen.
 *
 * Where the fake behaves like Postgres on the service's behalf: an UPDATE
 * stamps a later `updated_at` (the standard trigger), `update/delete(...)
 * .select().maybeSingle()` returns one row, `{ count: "exact" }` on a mutation
 * counts it, `.eq(jsonColumn, JSON.stringify(value))` compares by value,
 * `.eq("relation.column", x)` filters on an embedded row, and `maxRows` caps
 * each response the way PostgREST's max-rows does.
 *
 * Seeded tables are copied as JSON, so Infinity, NaN and undefined do not
 * survive seeding. A test about such a value answers it with `tamper`.
 *
 * Require this module BEFORE `freshRequire`-ing the service under test, so the
 * service picks up the audit/event recorders.
 */

const { isDeepStrictEqual } = require("node:util")

const { createFakeSupabase, readPath } = require("./fake-supabase")
const { stubModule } = require("./modules")

/** A deterministic UUID: `id(7)` → `00000000-0000-4000-8000-000000000007`. */
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`

/** The org and actor every harness runs as unless told otherwise. */
const ORG = id(900001)
const ACTOR = id(900002)

let current = null

stubModule("@/lib/services/audit", {
  recordAudit: async (entry) => {
    current?.audits.push(entry)
  },
})
stubModule("@/lib/services/events", {
  recordEvent: async (entry) => {
    current?.events.push(entry)
  },
})

const { runWithServiceOrgContext } = require("@/lib/services/context")
const { runWithServiceSupabaseClient } = require("@/lib/supabase/service-client-context")

/** Tables the harness itself reads or writes to stand the actor up. */
const ACCESS_TABLES = new Set([
  "permissions",
  "memberships",
  "membership_divisions",
  "membership_permission_overrides",
  "project_members",
  "platform_memberships",
  "authorization_audit_log",
])

/**
 * The actor's RBAC rows, shaped the way PostgREST returns the embedded
 * `role:roles!inner(permissions:role_permissions(permission_key))` join.
 *
 * `projects` limits the actor to those projects (an assigned-only membership
 * plus a project membership each); `divisions` limits them to those divisions.
 */
function accessRows({ orgId, userId, permissions, projects, divisions }) {
  const membershipId = id(900003)
  const role = { permissions: permissions.map((key) => ({ permission_key: key })) }
  return {
    memberships: [
      {
        id: membershipId,
        org_id: orgId,
        user_id: userId,
        status: "active",
        project_scope: projects ? "assigned" : "all",
        division_scope: divisions ? "assigned" : "all",
        role,
      },
    ],
    project_members: (projects ?? []).map((projectId) => ({
      project_id: projectId,
      org_id: orgId,
      user_id: userId,
      status: "active",
      role,
    })),
    membership_divisions: (divisions ?? []).map((divisionId) => ({
      membership_id: membershipId,
      division_id: divisionId,
    })),
  }
}

/** The JSON a filter value spells, or undefined when it is a plain scalar. */
function parseJson(value) {
  if (typeof value !== "string" || !/^[[{]/.test(value)) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/** PostgREST embedded-resource filters: `.eq("drawing_sheets.project_id", x)`. */
function embeddedFilter(query, method) {
  const original = query[method].bind(query)
  query[method] = (column, value) => {
    if (!column.includes(".")) return original(column, value)
    const [relation, field] = column.split(".")
    const values = method === "in" ? value.map(String) : [String(value)]
    return query.addFilter((row) => {
      const related = Array.isArray(row[relation]) ? row[relation] : [row[relation]]
      return related.some((entry) => entry && values.includes(String(entry[field])))
    })
  }
}

/**
 * `update(...).select().maybeSingle()` answers with one row (or null), and a
 * counted mutation reports how many rows it touched — the fake answers with the
 * full array and no count, so the harness finishes the job PostgREST would.
 */
function collapseMutationResult(query, result) {
  const rows = Array.isArray(result.data) ? result.data : null
  const next = { ...result }
  if (query.countMode) next.count = rows ? rows.length : null
  if (rows && query.cardinality) {
    if (rows.length > 1 || (query.cardinality === "single" && rows.length !== 1)) {
      return { ...next, data: null, error: { message: "JSON object requested, multiple (or no) rows returned" } }
    }
    next.data = rows[0] ?? null
  }
  return next
}

/**
 * @param {object} [options]
 * @param {Record<string, object[]>} [options.tables] Rows the fake database starts with.
 * @param {string[]} [options.permissions] Keys the actor's role grants.
 * @param {string[]} [options.projects] Restrict the actor to these projects.
 * @param {string[]} [options.divisions] Restrict the actor to these divisions.
 * @param {Record<string, Function>} [options.rpc] Handlers for `supabase.rpc(name)`.
 * @param {number} [options.maxRows] PostgREST's per-response row cap, to prove a
 *   reader pages to the end instead of trusting one short response.
 * @param {string} [options.orgId]
 * @param {string} [options.userId]
 */
function createServiceHarness(options = {}) {
  const orgId = options.orgId ?? ORG
  const userId = options.userId ?? ACTOR
  const fake = createFakeSupabase(options.tables ?? {}, options.rpc ?? {}, { uuidIds: true })
  const tampering = new Map()

  const service = {
    orgId,
    userId,
    db: fake.store,
    audits: [],
    events: [],
    /** Every query the service ran: `{ table, action, payload }`. */
    queries: [],
    client: null,

    /** Run `work` as the actor, inside the org, against the fake database. */
    run(work) {
      current = service
      const context = { supabase: service.client, orgId, userId, productTier: "residential" }
      return runWithServiceSupabaseClient(service.client, () => runWithServiceOrgContext(context, work))
    },

    /** Replace the actor's RBAC grant (for a test that changes access mid-flight). */
    grant(permissions, scope = {}) {
      Object.assign(fake.store, accessRows({ orgId, userId, permissions, ...scope }))
    },

    /**
     * Rewrite what the database answers for `table`: `change(result, query)`
     * returns the result the service sees (see `replies` for the common ones).
     * This is how a test stands in for a failed read, a reply that does not
     * match the request, or a row that changed between a read and a write.
     *
     * `on` limits it to one action ("select" | "insert" | "update" | "delete");
     * `times` limits it to the first N matching queries. `query.where` holds
     * the query's `.eq()` filters for a change aimed at one particular read.
     */
    tamper(table, change, { on, times = Infinity } = {}) {
      const entry = { change, on, remaining: times }
      tampering.set(table, [...(tampering.get(table) ?? []), entry])
    },

    /** Mutations the service attempted on business tables. */
    writes(table) {
      return service.queries.filter(
        (query) =>
          query.action !== "select" &&
          !ACCESS_TABLES.has(query.table) &&
          (table === undefined || query.table === table),
      )
    },

    /** Reads the service made of a business table. */
    reads(table) {
      return service.queries.filter((query) => query.action === "select" && query.table === table)
    },
  }

  let clock = 0
  /** The `updated_at` trigger: every UPDATE stamps a strictly later revision. */
  const nextRevision = () => {
    clock += 1
    return new Date(Date.UTC(2026, 9, 5, 0, 0, clock)).toISOString().replace("Z", "+00:00")
  }

  service.client = {
    from(table) {
      const query = fake.from(table)
      for (const method of ["eq", "neq", "in"]) embeddedFilter(query, method)
      // `query.where` is the query's equality filters, so a tamper can aim at
      // one read of a table: `query.where.sheet_version_id === TARGET`.
      query.where = {}
      const eq = query.eq.bind(query)
      query.eq = (column, value) => {
        query.where[column] = value
        const json = parseJson(value)
        if (json === undefined) return eq(column, value)
        // jsonb equality: `.eq("metadata", JSON.stringify(seen))` matches by value.
        return query.addFilter((row) => {
          const actual = readPath(row, column)
          return actual !== null && typeof actual === "object" ? isDeepStrictEqual(actual, json) : String(actual) === value
        })
      }
      // `update(values, { count: "exact" })` / `delete({ count })` report the
      // number of rows they touched, as PostgREST does.
      const update = query.update.bind(query)
      query.update = (payload, settings = {}) => {
        if (settings.count) query.countMode = settings.count
        return update(payload)
      }
      const remove = query.delete.bind(query)
      query.delete = (settings = {}) => {
        if (settings.count) query.countMode = settings.count
        return remove()
      }
      if (table === "permissions") {
        // The whole catalog exists; see the header.
        const eq = query.eq.bind(query)
        query.eq = (column, value) => {
          if (column === "key" && !fake.store.permissions.some((row) => row.key === value)) {
            fake.store.permissions.push({ key: value })
          }
          return eq(column, value)
        }
      }
      const run = query.run.bind(query)
      query.run = () => {
        service.queries.push({ table, action: query.action, payload: query.payload })
        const stamped = (fake.store[table] ?? []).some((row) => "updated_at" in row)
        if (query.action === "update" && stamped) {
          query.payload = { ...query.payload, updated_at: nextRevision() }
        }
        let result = run()
        if (query.action === "update" || query.action === "delete") {
          result = collapseMutationResult(query, result)
        }
        if (options.maxRows && query.action === "select" && Array.isArray(result.data)) {
          result = { ...result, data: result.data.slice(0, options.maxRows) }
        }
        for (const entry of tampering.get(table) ?? []) {
          if (entry.remaining <= 0 || (entry.on && entry.on !== query.action)) continue
          entry.remaining -= 1
          result = entry.change(result, query)
        }
        return result
      }
      return query
    },
    rpc(name, args) {
      service.queries.push({ table: `rpc:${name}`, action: "rpc", payload: args })
      return fake.rpc(name, args)
    },
  }

  fake.store.permissions = []
  service.grant(options.permissions ?? [], { projects: options.projects, divisions: options.divisions })
  return service
}

/** The usual ways a database answer goes wrong, as `tamper` changes. */
const replies = {
  /** The query failed. */
  error: (message = "Unavailable") => (result) => ({ ...result, data: null, error: { message } }),
  /** No error, but no body either. */
  missing: () => (result) => ({ ...result, data: null }),
  /** A body other than the stored one: a foreign row, a duplicate, a stalled page. */
  rows: (data) => (result) => ({ ...result, data: structuredClone(data) }),
  /** The stored answer with `patch` merged into every returned row. */
  patch: (patch) => (result) => ({
    ...result,
    data: Array.isArray(result.data)
      ? result.data.map((row) => ({ ...row, ...patch }))
      : result.data && { ...result.data, ...patch },
  }),
}

module.exports = { createServiceHarness, replies, id, ORG, ACTOR }
