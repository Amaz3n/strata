require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const fs = require("node:fs")
const path = require("node:path")
const test = require("node:test")

/**
 * Structural guards for the money layer.
 *
 * These are deliberately source scans rather than behaviour tests, and they live
 * apart from `fintech-payment-domain.test.js` for that reason: a scan enforces an
 * invariant no type can express (a grant that must be revoked, a column that must
 * be wide), and mixing the two made a suite that looked far better covered than
 * it was. Anything that can be asserted by calling a function belongs next door.
 */

const MIGRATIONS_DIR = path.resolve(__dirname, "../supabase/migrations")

function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR).filter((name) => name.endsWith(".sql")).sort()
}

function readMigration(name) {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, name), "utf8").toLowerCase()
}

/** Names that put a function in the money slice. */
const MONEY_FUNCTION_PATTERN =
  /payment|disbursement|vendor_bill|ledger|payable|vendor_credit|reconciliation|recipient|funding|remittance/i

/**
 * Functions created before the revoke convention existed, still un-revoked in
 * their own migration. Both were locked down in production by a later migration
 * and neither is reachable by `anon` or `authenticated` today, so this list is
 * documentation of debt rather than an exemption from the rule.
 *
 * It may only ever shrink. Fixing one of these fails this test until its name is
 * removed, which is the point: an allowlist that silently tolerates its own
 * entries becoming stale is how the leak this test exists to catch got in.
 */
const GRANDFATHERED_UNREVOKED_FUNCTIONS = ["apply_invoice_payment_atomic", "record_payment_reversal_atomic"]

test("every callable money RPC is revoked from public, anon and authenticated", () => {
  const created = new Map()
  const triggerFunctions = new Set()
  const revoked = new Set()

  for (const name of migrationFiles()) {
    const sql = readMigration(name)
    const createPattern = /create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z0-9_]+)\s*\(/g
    for (let match = createPattern.exec(sql); match; match = createPattern.exec(sql)) {
      const fn = match[1]
      if (!MONEY_FUNCTION_PATTERN.test(fn)) continue
      if (!created.has(fn)) created.set(fn, name)
      // A trigger function cannot be invoked directly — Postgres refuses — so a
      // grant on one is not an exposure.
      if (/\)\s*returns\s+trigger/.test(sql.slice(match.index, match.index + 4000))) triggerFunctions.add(fn)
    }
    const revokePattern = /revoke\s+(?:all|execute)[^;]*?on\s+function\s+(?:public\.)?([a-z0-9_]+)\s*\([^;]*?from\s+([^;]+);/gs
    for (let match = revokePattern.exec(sql); match; match = revokePattern.exec(sql)) {
      const roles = match[2]
      // `revoke ... from public` alone is the bug this guard exists for:
      // Supabase grants EXECUTE to anon and authenticated explicitly, not
      // through public, so both survive it. `submit_payment_run_atomic` shipped
      // that way and was callable unauthenticated in production for a month.
      if (roles.includes("public") && roles.includes("anon") && roles.includes("authenticated")) {
        revoked.add(match[1])
      }
    }
  }

  const unrevoked = [...created.keys()]
    .filter((fn) => !triggerFunctions.has(fn) && !revoked.has(fn))
    .sort()
  assert.deepEqual(
    unrevoked,
    [...GRANDFATHERED_UNREVOKED_FUNCTIONS].sort(),
    `Money RPCs must be revoked from public, anon and authenticated in the migration that creates them. Unexpected: ${unrevoked.join(", ") || "none"}`,
  )
})

/** The text between an opening paren and its match, exclusive. */
function balancedParenBody(sql, openIndex) {
  let depth = 0
  for (let index = openIndex; index < sql.length; index += 1) {
    if (sql[index] === "(") depth += 1
    else if (sql[index] === ")") {
      depth -= 1
      if (depth === 0) return sql.slice(openIndex + 1, index)
    }
  }
  return sql.slice(openIndex + 1)
}

/**
 * Tables whose cent columns must be `bigint`.
 *
 * `payments` sat at `integer` while every upstream table was `bigint` and the AP
 * RPCs passed `bigint` parameters into it, so a payment above $21,474,836.47 did
 * not clamp — it raised, inside the atomic RPC, after the provider had taken the
 * money. Commercial pay applications reach that number.
 */
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

test("every cent column on a money table settles at bigint", () => {
  // Replay declarations and widenings in migration order; the last write wins,
  // exactly as Postgres sees them.
  const columnTypes = new Map()

  for (const name of migrationFiles()) {
    const sql = readMigration(name)

    for (const table of WIDE_MONEY_TABLES) {
      const createPattern = new RegExp(`create\\s+table\\s+(?:if\\s+not\\s+exists\\s+)?(?:public\\.)?${table}\\s*\\(`, "g")
      for (let match = createPattern.exec(sql); match; match = createPattern.exec(sql)) {
        // The column list ends at its own closing paren. A fixed-size slice
        // instead ran off the end of short tables and into the next statement,
        // where PL/pgSQL parameters named `p_amount_cents integer` read as
        // columns and failed this test on functions that have no columns at all.
        const body = balancedParenBody(sql, match.index + match[0].length - 1)
        const columnPattern = /([a-z0-9_]*_cents)\s+(bigint|integer|int4|int8|numeric)/g
        for (let column = columnPattern.exec(body); column; column = columnPattern.exec(body)) {
          columnTypes.set(`${table}.${column[1]}`, column[2])
        }
      }

      const addPattern = new RegExp(
        `alter\\s+table\\s+(?:public\\.)?${table}\\s+add\\s+column\\s+(?:if\\s+not\\s+exists\\s+)?([a-z0-9_]*_cents)\\s+(bigint|integer|int4|int8|numeric)`,
        "g",
      )
      for (let match = addPattern.exec(sql); match; match = addPattern.exec(sql)) {
        columnTypes.set(`${table}.${match[1]}`, match[2])
      }

      // One `alter table` can carry several `alter column ... type` clauses.
      const alterPattern = new RegExp(`alter\\s+table\\s+(?:public\\.)?${table}\\s+([^;]+);`, "g")
      for (let match = alterPattern.exec(sql); match; match = alterPattern.exec(sql)) {
        const typePattern = /alter\s+column\s+([a-z0-9_]*_cents)\s+type\s+(bigint|integer|int4|int8|numeric)/g
        for (let clause = typePattern.exec(match[1]); clause; clause = typePattern.exec(match[1])) {
          columnTypes.set(`${table}.${clause[1]}`, clause[2])
        }
      }
    }
  }

  assert.ok(columnTypes.size > 0, "the money-column scan found no columns, so it is not actually checking anything")
  const narrow = [...columnTypes.entries()]
    .filter(([, type]) => type !== "bigint" && type !== "int8")
    .map(([column, type]) => `${column} is ${type}`)
    .sort()
  assert.deepEqual(narrow, [], `Money columns must be bigint: ${narrow.join(", ")}`)
})

test("the release sweep asks whether any rail is enabled before asserting readiness", () => {
  const payouts = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-payouts.ts"), "utf8")
  const releaseSweep = payouts.slice(payouts.indexOf("export async function releaseMaturedVendorTransfers"))
  const railCheck = releaseSweep.indexOf("await hasEnabledPaymentRail()")
  const readiness = releaseSweep.indexOf("await assertPaymentLaunchReady()")
  assert.ok(railCheck > 0, "releaseMaturedVendorTransfers must short-circuit when no organization is on the rail")
  assert.ok(
    railCheck < readiness,
    "the rail check must precede the readiness assertion, or a deployment with no enabled rail fails the money tick every five minutes instead of having nothing to do",
  )
})

test("the stale-payment scan is shared, so reconciliation is not its only caller", () => {
  const reconciliation = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-reconciliation.ts"), "utf8")
  const watchdog = fs.readFileSync(path.resolve(__dirname, "../lib/services/ops-watchdog.ts"), "utf8")
  assert.match(reconciliation, /loadStalePaymentState/)
  assert.match(watchdog, /loadStalePaymentState/)
  // The watchdog runs on no flag at all. If it ever gates itself on the
  // reconciliation switch, the four-week stuck disbursement becomes invisible
  // again for exactly the same reason it was the first time.
  const probe = watchdog.slice(watchdog.indexOf("async function checkStalePaymentStates"))
  assert.doesNotMatch(
    probe.slice(0, probe.indexOf("\n}\n")),
    /FINTECH_PAYMENTS_RECONCILIATION_ENABLED|enabled.*true/,
    "the stale-payment probe must not depend on the reconciliation flag or on a rail being enabled",
  )
})

test("AP notification types that move money are email-eligible and routed", () => {
  const types = fs.readFileSync(path.resolve(__dirname, "../lib/types/notifications.ts"), "utf8")
  for (const key of ["vendor_bill_submitted", "vendor_bill_approved", "vendor_bill_rejected", "vendor_payment_paid"]) {
    assert.match(types, new RegExp(`key: "${key}"`), `${key} must remain on the email allowlist`)
  }
  const events = fs.readFileSync(path.resolve(__dirname, "../lib/services/events.ts"), "utf8")
  assert.match(events, /vendor_bill_submitted: \["bill\.approve"\]/)
  assert.match(events, /event\.event_type === "vendor_payment_paid"/)
})

test("ACH return processing never voids accounting synchronously", () => {
  const providerEvents = fs.readFileSync(path.resolve(__dirname, "../lib/services/payment-provider-events.ts"), "utf8")
  const returnPath = providerEvents.slice(providerEvents.indexOf("async function processDisbursementReturn"))
  assert.doesNotMatch(returnPath, /voidBillPaymentInAccounting/)
  assert.match(returnPath, /enqueueBillPaymentVoid/)
})

test("fintech test summary reports at least sixty percent behavioral assertions", () => {
  const files = fs.readdirSync(__dirname)
    .filter((name) => name.startsWith("fintech-payment-") && name.endsWith(".test.js"))
    .sort()
  let behavior = 0
  let guards = 0
  for (const name of files) {
    const source = fs.readFileSync(path.join(__dirname, name), "utf8")
    const count = [...source.matchAll(/^test\((?:"|'|`)/gm)].length
    if (name === "fintech-payment-guards.test.js") guards += count
    else {
      assert.doesNotMatch(source, /\b(?:fs\.|paymentSource\(|readFileSync\()/, `${name} must contain behavior tests only`)
      behavior += count
    }
  }
  const total = behavior + guards
  const ratio = total === 0 ? 0 : behavior / total
  console.log(`Fintech test mix: ${behavior} behavior, ${guards} guards, ${(ratio * 100).toFixed(1)}% behavior`)
  assert.ok(ratio >= 0.6, `expected >=60% behavior assertions, received ${(ratio * 100).toFixed(1)}%`)
})
