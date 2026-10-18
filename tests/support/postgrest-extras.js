"use strict"

/**
 * PostgREST behaviour the shared fake (`fake-supabase.js`) does not model yet,
 * layered onto a service harness from `service.js`. Candidates to fold into the
 * fake itself.
 *
 *   const service = createServiceHarness({ tables })
 *   withIlike(service)                              // .ilike(column, pattern)
 *   withTableRpc(service, "get_variance_analysis")   // rpc(...) pages like a table
 */

/** `%` and `_` wildcards, case-insensitive, as Postgres ILIKE. */
function ilikeMatcher(pattern) {
  const source = String(pattern)
    .split("")
    .map((char) => (char === "%" ? ".*" : char === "_" ? "." : char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("")
  return new RegExp(`^${source}$`, "is")
}

/** Give every query of the harness client `.ilike(column, pattern)`. */
function withIlike(service) {
  const from = service.client.from
  service.client.from = (table) => {
    const query = from(table)
    query.ilike = (column, pattern) => {
      const matcher = ilikeMatcher(pattern)
      return query.addFilter((row) => row[column] != null && matcher.test(String(row[column])))
    }
    return query
  }
  return service
}

/**
 * Make `rpc(name, args)` answer from the seeded table `name`, filtered by
 * `filters(args)` (an object of column → value), so the caller can chain
 * `.order()` / `.range()` the way PostgREST allows on a set-returning function.
 */
function withTableRpc(service, name, filters = () => ({})) {
  const rpc = service.client.rpc
  service.client.rpc = (called, args) => {
    if (called !== name) return rpc(called, args)
    service.queries.push({ table: `rpc:${name}`, action: "rpc", payload: args })
    let query = service.client.from(name)
    for (const [column, value] of Object.entries(filters(args))) query = query.eq(column, value)
    return query
  }
  return service
}

module.exports = { withIlike, withTableRpc }
