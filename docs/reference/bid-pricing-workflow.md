# Trade pricing and subcontract preparation

The bid workbench records a pricing choice separately from a contractual award.

1. Draft the trade scope and open bidding. Issued scope lines and instructions become immutable.
2. Collect current vendor quotes. Withdrawn, expired, superseded and obsolete scope revisions cannot be selected or awarded.
3. Select a quote for pricing. Accept signed add/deduct alternates, assign each unpriced item and written exclusion, and record the decision. The decision preserves the vendor value separately from complete scope cost. Only eligible selected decisions are offered to the estimate.
4. Change an issued scope through **Start scope revision**, edit the new draft, then reopen bidding. Old scope is snapshotted and old pricing choices are retired. Addenda also advance the scope revision. Vendors must acknowledge addenda and submit a quote against the current revision; stale browser forms are rejected.
5. Once the signed owner contract has a commercial handoff, prepare the subcontract award. Review agreed scope, governing documents, schedule and commercial terms. Resolve vendor/bond readiness or record an authorized exception. This creates a reviewed draft commitment; approval and signature remain separate actions.
6. Subcontract award does not release the project to delivery. The project handoff owns baseline approval and operational readiness.

A GC scope plug is an estimating assumption. It does not increase the chosen vendor's contract automatically. Every excluded item needs an owner and disposition (allowance, self-perform, another package, or a documented owner exclusion). Avoid carrying another package's cost twice when composing the final estimate.

Pricing decisions and scope revisions are append-only records exposed through authorized server services. A decision snapshots the quote version, scope revision, accepted alternates, gap dispositions, rationale and monetary basis. Replacing a choice supersedes the previous record. Quote withdrawal, quote replacement and scope changes retire the active choice. Expiry is evaluated on read and again at the decision/award boundary.

## Rollout and verification

Deployed `20260921121014_bid_pricing_decisions_and_scope_revisions.sql` with the preconstruction workspace/handoff migrations on September 21, 2026 after user authorization.

Behavioral tests:

- `node --test tests/bid-pricing-decisions.test.js`
- `ARC_TEST_PGLITE_MODULE=/path/to/@electric-sql/pglite node --test tests/bid-pricing-db.test.js`
- After installation in a disposable Supabase test database, `supabase/tests/bid_pricing_access.test.sql` checks the grants.

The PGlite test applies the actual migration to isolated fixture tables. Its existing submission and award conversion functions are minimal stand-ins; it validates the new wrappers/triggers, historical snapshots, transaction rollback, and privileges without modifying an application database. Existing conversion internals are covered separately.
