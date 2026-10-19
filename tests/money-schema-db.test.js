"use strict"

/**
 * Repository invariants for the money schema, checked against the database
 * every migration actually builds (not against migration text).
 *
 * - No money RPC is executable by `anon` or `authenticated`. Supabase grants
 *   EXECUTE to both roles explicitly (default privileges), so `revoke ... from
 *   public` alone leaves them callable — `submit_payment_run_atomic` shipped
 *   that way and was callable unauthenticated in production for a month.
 * - Every cent column on a payment table is bigint. `payments.amount_cents` sat
 *   at integer while the AP RPCs passed bigint into it, so a payment above
 *   $21,474,836.47 raised inside the atomic RPC after the provider had taken
 *   the money.
 */

const assert = require("node:assert/strict")
const test = require("node:test")

const { createDatabase } = require("./support/pglite")

/** Names that put a function in the money slice. */
const MONEY_FUNCTION = "payment|disbursement|vendor_bill|ledger|payable|vendor_credit|reconciliation|recipient|funding|remittance"

const WIDE_MONEY_TABLES = [
  "payments",
  "payment_reversals",
  "payment_allocations",
  "disbursements",
  "payment_run_items",
  "payment_runs",
  "payment_ledger_entries",
  "payment_run_fee_charges",
]

let db
test.before(async () => {
  db = await createDatabase()
})
test.after(() => db.close())

test("no money RPC can be called by a browser role", async () => {
  // A trigger function cannot be invoked directly, so a grant on one is no exposure.
  const { rows } = await db.query(
    `select p.oid::regprocedure::text as signature,
            has_function_privilege('anon', p.oid, 'execute') as anon,
            has_function_privilege('authenticated', p.oid, 'execute') as authenticated
     from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and p.prorettype <> 'trigger'::regtype
       and p.proname ~ $1`,
    [MONEY_FUNCTION],
  )
  assert.ok(rows.length > 50, `expected to find the money RPCs, found ${rows.length}`)
  const exposed = rows.filter((row) => row.anon || row.authenticated).map((row) => row.signature).sort()
  assert.deepEqual(exposed, [], "revoke these from public, anon and authenticated in the migration that creates them")
})

test("browser roles are granted EXECUTE by default, so the check above is not vacuous", async () => {
  const { rows } = await db.query(
    `select defaclacl::text[] as acl from pg_default_acl
     where defaclnamespace = 'public'::regnamespace and defaclobjtype = 'f'`,
  )
  const acl = rows.flatMap((row) => row.acl)
  assert.ok(acl.some((entry) => entry.startsWith("anon=X")))
  assert.ok(acl.some((entry) => entry.startsWith("authenticated=X")))
})

test("every cent column on a payment table is bigint", async () => {
  const { rows } = await db.query(
    `select table_name || '.' || column_name as column, data_type
     from information_schema.columns
     where table_schema = 'public' and table_name = any($1) and column_name like '%\\_cents'`,
    [WIDE_MONEY_TABLES],
  )
  assert.ok(rows.length >= WIDE_MONEY_TABLES.length, `expected cent columns on every money table, found ${rows.length}`)
  const narrow = rows.filter((row) => row.data_type !== "bigint").map((row) => `${row.column} is ${row.data_type}`)
  assert.deepEqual(narrow.sort(), [])
})
