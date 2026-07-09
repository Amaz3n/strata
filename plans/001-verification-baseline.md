# Plan 001: Establish a one-command verification baseline (test + typecheck)

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7e98e5de..HEAD -- package.json tests/ lib/services/*.test.ts lib/invoices/*.test.ts lib/integrations/accounting/*.test.ts scripts/register-ts-node-test.js`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests / dx
- **Planned at**: commit `7e98e5de`, 2026-07-07 (note: the working tree had
  substantial uncommitted changes at planning time; the excerpts below reflect
  the working tree, not the bare commit)
- **Revision status**: revised on 2026-07-07 after executor dry-run found all
  seven co-located TS tests import `bun:test`. The revised plan keeps the repo
  on its existing `node:test` convention and expands scope to convert those TS
  tests to `node:test` + `node:assert/strict` before wiring scripts.

## Why this matters

There is no single command that answers "does this codebase work?". The
`package.json` exposes only `test:financials` and `test:mobile`; the file
`tests/financials-phase0.test.js` and **all seven** co-located TypeScript unit
tests under `lib/` (invoice balance, invoice numbering, QBO webhook/API
parsing, party details, approved-cost preview) are referenced by **no script
at all** — they never run in any documented flow, so regressions in
money-critical parsing and numbering logic ship silently. There is also no
`typecheck` script: `tsconfig.json` has `noEmit: true`, so `tsc` only ever
runs inside `next build`, which developers are told not to run locally. Every
other plan in this directory uses the commands this plan creates as its
verification gate.

## Current state

- `package.json:5-13` — the full scripts block today:

```json
"scripts": {
  "build": "next build",
  "dev": "NODE_OPTIONS='--max-old-space-size=6144' next dev --turbo",
  "db:schema:check": "bash ./scripts/check-schema-sync.sh",
  "lint": "eslint .",
  "test:financials": "node --test tests/financials-regression.test.js tests/qbo-import-reliability.test.js",
  "test:mobile": "node --test tests/mobile-api-contract.test.js",
  "start": "next start"
}
```

- Orphaned test files (in no script):
  - `tests/financials-phase0.test.js`
  - `lib/services/invoice-balance.test.ts`
  - `lib/services/invoice-numbers.test.ts`
  - `lib/services/approved-cost-invoice-preview.test.ts`
  - `lib/invoices/party-details.test.ts`
  - `lib/integrations/accounting/qbo-api.test.ts`
  - `lib/integrations/accounting/qbo-webhook.test.ts`
  - `lib/integrations/accounting/qbo-account-utils.test.ts`
  (Re-derive the exact list with `git ls-files '*.test.ts' '*.test.js'` — if it
  differs from the above, use what you find.)

- `scripts/register-ts-node-test.js` — an existing CommonJS loader that
  registers `.ts`/`.tsx` compilation via the `typescript` package and resolves
  the `@/` path alias. The existing `tests/*.test.js` files require it
  internally. TypeScript test files can therefore be run with:
  `node --test --require ./scripts/register-ts-node-test.js <file.test.ts>`

- Blocker discovered during first execution attempt: every co-located
  TypeScript test currently starts with:

```ts
// @ts-expect-error bun test types are not part of this app tsconfig
import { describe, expect, it } from "bun:test"
```

  There is no Bun script or Bun dependency in `package.json`, and the repo's
  documented convention is `node:test`. Convert these test files to
  `node:test` and `node:assert/strict`; do not add Bun, Jest, Vitest, or any
  other test framework.

- Repo conventions that apply: tests use `node --test` (node:test runner), no
  test framework dependency. Do not introduce vitest/jest. The repo rule "Do
  NOT run `pnpm build`" stands — `tsc --noEmit` is fine, `next build` is not.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install | `pnpm install` | exit 0 (should be a no-op); if it fails due registry/network access but `node_modules/` already exists, skip install and proceed with local verification |
| Lint | `pnpm lint` | exit 0 |
| Existing tests | `pnpm test:financials` | all pass |
| Run one TS test | `node --test --require ./scripts/register-ts-node-test.js lib/services/invoice-numbers.test.ts` | exit 0 or a report of pre-existing failures |

## Scope

**In scope** (the only files you should modify):
- `package.json` (scripts block only)
- `CLAUDE.md` (one line in "Definition of done" — see Step 6)
- The seven co-located TS test files, only to replace `bun:test` imports and
  `expect(...)` assertions with equivalent Node built-ins:
  - `lib/services/invoice-balance.test.ts`
  - `lib/services/invoice-numbers.test.ts`
  - `lib/services/approved-cost-invoice-preview.test.ts`
  - `lib/invoices/party-details.test.ts`
  - `lib/integrations/accounting/qbo-api.test.ts`
  - `lib/integrations/accounting/qbo-webhook.test.ts`
  - `lib/integrations/accounting/qbo-account-utils.test.ts`

**Out of scope** (do NOT touch, even though they look related):
- Any test's covered behavior or production code under test. If an orphaned
  test fails after the mechanical runner/assertion conversion, report it; do
  not fix the code under test or weaken the assertion.
- `tsconfig.json` — do not loosen compiler options to make `typecheck` pass.
- `eslint` config — lint stays as-is.

## Git workflow

- Branch: `advisor-001-verification-baseline` (branch off current branch; the
  working tree may carry unrelated uncommitted changes — do not commit files
  outside the in-scope list).
- Commit style: short imperative subject, matching `git log` (e.g. "Add
  one-command test and typecheck scripts").
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Inventory every existing test file

Run `git ls-files '*.test.ts' '*.test.js' 'tests/*.js'` to get the definitive
list.

**Verify**: the command reports the seven TS files above plus the JS tests in
`tests/`.

### Step 2: Convert co-located TS tests from Bun APIs to Node APIs

For each of the seven TS files listed in scope:

1. Remove the `// @ts-expect-error bun test types are not part of this app tsconfig`
   line.
2. Replace `import { describe, expect, it } from "bun:test"` with:

```ts
import assert from "node:assert/strict"
import { describe, it } from "node:test"
```

3. Convert expectations mechanically without changing the tested values:
   - `expect(actual).toBe(expected)` -> `assert.equal(actual, expected)`
   - `expect(actual).toEqual(expected)` -> `assert.deepEqual(actual, expected)`
   - `expect(actual).toHaveLength(n)` -> `assert.equal(actual.length, n)`
   - `expect(actual).toBeGreaterThan(0)` -> `assert.ok(actual > 0)`
   - `expect(actual).toBeLessThan(0)` -> `assert.ok(actual < 0)`

Do not rewrite test names, fixtures, imports for production modules, or
asserted values. This is a runner/assertion migration only.

**Verify**: `rg -n "bun:test|expect\\(" lib/**/*.test.ts` returns no matches.

### Step 3: Dry-run every existing test file

Run each file individually:

- JS tests: `node --test tests/<file>.test.js`
- TS tests: `node --test --require ./scripts/register-ts-node-test.js <path>.test.ts`

Record which files pass and which fail, with the failure output. Do not fix
failures in the code under test.

**Verify**: you have a pass/fail record for every test file found.

### Step 4: Add `typecheck` and unified `test` scripts

Edit `package.json` scripts:

```json
"typecheck": "tsc --noEmit",
"test:unit": "node --test --require ./scripts/register-ts-node-test.js lib/services/invoice-balance.test.ts lib/services/invoice-numbers.test.ts lib/services/approved-cost-invoice-preview.test.ts lib/invoices/party-details.test.ts lib/integrations/accounting/qbo-api.test.ts lib/integrations/accounting/qbo-webhook.test.ts lib/integrations/accounting/qbo-account-utils.test.ts",
"test": "pnpm test:unit && pnpm test:financials && pnpm test:mobile && node --test tests/financials-phase0.test.js"
```

Use the file list from Step 1, not the one above, if they differ. If a test
file from Step 3 fails for pre-existing reasons, still include it — a red test
that runs is better than a green one that doesn't — UNLESS it fails for
environmental reasons (needs network/DB credentials), in which case exclude it
and document the exclusion in your report and in a `//` comment nowhere —
instead note it in the plans/README.md status cell.

**Verify**: `pnpm test:unit` runs and reports results for every listed file
(exit code may be non-zero if Step 3 found pre-existing failures — that is
acceptable and must be reported).

### Step 5: Run the typecheck and triage

Run `pnpm typecheck`. Expected: exit 0. If it reports errors, count them.
- 0 errors: proceed.
- 1–10 errors clearly caused by test files or scripts being newly included:
  fix only trivial issues (e.g. missing `@types/*` already installed
  elsewhere); otherwise report.
- More than 10 errors: this is a pre-existing debt discovery, not something to
  fix here. STOP condition — report the count and the top error classes.

**Verify**: `pnpm typecheck` → exit 0, or a written triage report.

### Step 6: Record the commands where agents will find them

In `CLAUDE.md`, section "## Definition of done", change the first bullet from
"`pnpm lint` clean." to "`pnpm lint`, `pnpm typecheck`, and `pnpm test` clean."
Make no other edits to `CLAUDE.md`.

**Verify**: `git diff CLAUDE.md` shows exactly one modified line.

## Test plan

This plan creates no new tests; it makes existing ones reachable. Final check:

- `pnpm test` executes every test file identified in Step 1 (or documents the
  environmental exclusions).
- `pnpm typecheck` runs `tsc --noEmit` against the whole repo.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0 (or a triage report exists per Step 5)
- [ ] `rg -n "bun:test|expect\\(" lib/**/*.test.ts` returns no matches
- [ ] `pnpm test:unit` runs all co-located TS tests
- [ ] `pnpm test` runs unit + financials + mobile + phase0 suites
- [ ] `git diff --name-only` shows only `package.json`, `CLAUDE.md`, and the
      seven in-scope TS test files changed
- [ ] `plans/README.md` status row updated (include pre-existing failure count
      in the status cell if non-zero)

## STOP conditions

Stop and report back (do not improvise) if:

- `scripts/register-ts-node-test.js` cannot compile one of the TS test files
  (e.g. it imports server-only modules that crash at require time) — report
  which files and the error; do not rewrite the loader.
- `pnpm typecheck` reports more than 10 pre-existing errors.
- Any test failure appears to indicate a REAL money-math bug (not a stale
  assertion) — report it immediately; it may warrant its own fix plan.

## Maintenance notes

- Plans 002–006 use `pnpm typecheck` and `pnpm test` as gates; if you renamed
  the scripts, update those plans.
- Follow-up deliberately deferred: rewriting the source-text (`readFileSync` +
  regex) assertions in `tests/financials-regression.test.js` into behavioral
  tests, and characterization coverage for draws/budgets/change-orders — both
  were audited as findings #8 and are unplanned as of this writing.
- CI should eventually run `pnpm lint && pnpm typecheck && pnpm test`; no CI
  config file was found in the repo at planning time, so this is a note, not a
  step.
