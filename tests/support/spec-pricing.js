"use strict"

/**
 * Fakes of the two service-role SQL functions behind a spec home's price and
 * incentive moves (supabase/migrations/20261012170000_ep04_review_fixes.sql),
 * for the service harness's `rpc` option. They do what the functions do to the
 * rows a service reads back — write the move, set the lot's price, refuse a lot
 * that changed — and nothing else: the guards and policies are proven against
 * the real functions in tests/spec-dispositions-db.test.js.
 *
 *   createServiceHarness({ tables, rpc: specPricingRpc() })
 */

const { randomUUID } = require("node:crypto")

function refuse(message) {
  return { data: null, error: { message } }
}

function specPricingRpc() {
  return {
    record_spec_price_move(args, store) {
      const lot = (store.lots ?? []).find((row) => row.id === args.p_lot_id && row.org_id === args.p_org_id)
      const applyPrice = args.p_apply && args.p_kind === "price"
      if (applyPrice && (!lot || lot.updated_at !== args.p_lot_updated_at)) {
        return refuse("The home changed while you were repricing it. Review it and try again.")
      }
      const id = randomUUID()
      store.spec_price_proposals = store.spec_price_proposals ?? []
      store.spec_price_proposals.push({
        id,
        org_id: args.p_org_id,
        lot_id: args.p_lot_id,
        project_id: args.p_project_id,
        community_id: args.p_community_id,
        kind: args.p_kind,
        asking_price_cents: args.p_asking_price_cents,
        from_cents: args.p_from_cents,
        to_cents: args.p_to_cents,
        incentive_expires_on: args.p_expires_on,
        reason: args.p_reason,
        required_permission: args.p_required_permission,
        status: args.p_apply ? "applied" : "proposed",
        proposed_by: args.p_actor_id,
        proposed_at: new Date().toISOString(),
        decided_by: null,
        decided_at: null,
      })
      if (applyPrice) lot.asking_price_override_cents = args.p_to_cents
      return { data: id, error: null }
    },
    decide_spec_price_proposal(args, store) {
      const proposal = (store.spec_price_proposals ?? []).find((row) => row.id === args.p_proposal_id && row.org_id === args.p_org_id)
      if (!proposal || proposal.status !== "proposed") return refuse("This price change was already decided or withdrawn.")
      const lot = (store.lots ?? []).find((row) => row.id === proposal.lot_id)
      if (args.p_approve && proposal.kind === "price" && (!lot || lot.updated_at !== args.p_lot_updated_at)) {
        return refuse("The home changed while you were deciding. Review it and try again.")
      }
      Object.assign(proposal, {
        status: args.p_approve ? "approved" : "rejected",
        decided_by: args.p_actor_id,
        decided_at: new Date().toISOString(),
        decision_note: args.p_note,
      })
      if (args.p_approve && proposal.kind === "price") lot.asking_price_override_cents = proposal.to_cents
      return { data: null, error: null }
    },
  }
}

module.exports = { specPricingRpc }
