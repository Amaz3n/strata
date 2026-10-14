"use strict"

/**
 * A Supabase-shaped client over a PGlite database, for service tests whose
 * subject is a SQL state machine (reserve, settle, resolve) that the in-memory
 * fake cannot model. Only the surface a caller names is supported:
 *
 *   const client = createPgliteClient(db, { failRpc: (name) => name === "settle_trade_notice" })
 *   await client.from("trade_notice_deliveries").select("id,status").eq("org_id", org).maybeSingle()
 *   await client.rpc("reserve_trade_notice", { ... })      // as service_role
 *
 * `failRpc(name, args)` makes a call answer `{ error }` once it returns true,
 * which is how a test loses the response to a write that did commit.
 */

const { rpc } = require("./pglite")

function createPgliteClient(db, { failRpc = () => false } = {}) {
  return {
    from(table) {
      const filters = []
      const query = {
        select(columns) { query.columns = columns; return query },
        eq(column, value) { filters.push([column, value]); return query },
        async maybeSingle() {
          const where = filters.map(([column], index) => `${column} = $${index + 1}`).join(" and ")
          const { rows } = await db.query(`select ${query.columns} from public.${table} where ${where} limit 2`, filters.map(([, value]) => value))
          if (rows.length > 1) return { data: null, error: { message: "expected at most one row" } }
          return { data: rows[0] ?? null, error: null }
        },
      }
      return query
    },
    async rpc(name, args) {
      if (failRpc(name, args)) return { data: null, error: { message: `${name} response lost` } }
      try {
        return { data: await rpc(db, name, args), error: null }
      } catch (error) {
        return { data: null, error: { message: error.message } }
      }
    },
  }
}

module.exports = { createPgliteClient }
