# Repository health

Status: reference — maintained with the code.

Arc treats cleanup as an evidence loop, not a periodic rewrite.

## The deletion rule

A route, component, service, feature flag, dependency, or database object is a
deletion candidate only when all applicable evidence agrees:

1. **Static reachability:** no live importer, route registration, job registry,
   dynamic loader, mobile client, or migration dependency needs it.
2. **Runtime reachability:** the surface or action has no recorded use during
   the window chosen by its owner. Never attach user content or secrets to this
   telemetry.
3. **Ownership:** the domain owner confirms there is no contractual, support,
   accounting, or migration obligation keeping it alive.

Database objects and public URLs additionally require a staged migration or
redirect. Static analysis alone never authorizes their removal.

## Continuous checks

- `pnpm health:repo` inventories source size, files over 1,000 lines, and direct
  dependencies without a discovered source/config import.
- `pnpm health:repo --check` is part of `pnpm verify` and blocks new unexplained
  direct dependencies.
- `pnpm security:audit` blocks high and critical production-tree advisories;
  dependency upgrades should still clear lower-severity findings when practical.
- Lint and TypeScript own unused imports and invalid references.
- The local Supabase pgTAP suite owns behavioral RLS/RPC/transaction contracts;
  CI starts an isolated Postgres 17 instance and never reads `.env.local`.
- Cron handlers return HTTP 207 for partial failure so `job_runs` records them
  as failed rather than green.

## Lifecycle metadata

Every new feature flag or compatibility path needs an owner, safe default,
creation date, review date, and deletion condition. Every active plan is either
current intent or deleted when shipped; durable knowledge moves to a reference
document first.

Review this inventory quarterly and after a large product-posture expansion.
Prioritize security and money correctness, then reliability and scale, then
deletion and stylistic consolidation.
