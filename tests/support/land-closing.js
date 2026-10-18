"use strict"

/**
 * Fake of `close_lot_takedown`
 * (supabase/migrations/20261012170000_ep04_review_fixes.sql) for the service
 * harness's `rpc` option. It does what the function does to the rows a service
 * reads back — close the takedown, apply its paid deposits, make its controlled
 * lots owned — and nothing else: the gates are proven against the real function
 * in tests/land-contracts-db.test.js.
 *
 *   createServiceHarness({ tables, rpc: landClosingRpc() })
 */

function landClosingRpc() {
  return {
    close_lot_takedown(args, store) {
      const takedown = (store.lot_takedowns ?? []).find((row) => row.id === args.p_takedown_id && row.org_id === args.p_org_id)
      if (!takedown || takedown.status !== "scheduled") return { data: null, error: { message: "Only a scheduled takedown is closed" } }
      Object.assign(takedown, { status: "closed", actual_date: args.p_actual_date })
      let applied = 0
      for (const deposit of store.land_contract_deposits ?? []) {
        if (deposit.takedown_id !== takedown.id || deposit.status !== "paid") continue
        deposit.status = "applied"
        applied += Number(deposit.amount_cents)
      }
      const lotIds = []
      for (const lot of store.lots ?? []) {
        if (lot.takedown_id !== takedown.id || lot.status !== "controlled") continue
        Object.assign(lot, { status: "owned", acquired_date: args.p_actual_date })
        lotIds.push(lot.id)
      }
      return { data: { lot_ids: lotIds, applied_deposit_cents: applied }, error: null }
    },
  }
}

module.exports = { landClosingRpc }
