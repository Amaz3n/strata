# Testing

**A test is a claim about behavior that a user or a ledger depends on.** It is
not a record that a change happened, not a snapshot of how the code is written
today, and not evidence for a tracker. If a test would still pass after the
behavior broke, or would fail after a refactor that kept the behavior, it is a
bad test — delete it or rewrite it.

Read this before adding a test. The existing suite is not the exemplar: a large
share of `tests/` predates this standard and is being rewritten to it. Copy the
exemplars named below, never the nearest sibling file.

## The tiers

Pick the cheapest tier that can actually observe the behavior.

| Tier | Use it for | How | Exemplar |
|---|---|---|---|
| **Pure** | Math, rules, state machines, parsers, formatting — anything with no I/O | `require` the module's exports and assert on return values | `tests/pay-app-math.test.js` |
| **Service** | A service's contract: what it reads, writes, refuses, emits | Call the real exported function inside `runWithServiceOrgContext()` (`lib/services/context.ts`) with the shared fake client from `tests/support/` | — (set by the test overhaul pilot) |
| **Database** | RLS, constraints, triggers, SQL functions, transactional atomicity | PGlite with whole migration files applied through a shared harness in `tests/support/` — never a hand-typed copy of a table, never a migration sliced by string offset | — (set by the test overhaul pilot) |
| **Browser** | A user flow across pages | Playwright (`e2e/`) | `pnpm verify:e2e` |

Push judgment out of services into pure modules (`lib/financials/*`,
`lib/drawings/*`, `lib/control-tower/model.ts`) and test it there. That is how
money gets tested in Arc: the rollup is pure, so it is tested exhaustively and
cheaply, and the service test only proves the service calls it.

## Rules

1. **Test through public exports.** Never read a source file to test it: no
   `readFileSync` on `lib/`, `app/`, `components/` or `supabase/`, no
   `ts.createSourceFile` / `transpileModule` to lift a function out of a module,
   no `assert.match` against source text. If the function you need is not
   exported, either it is covered through the export that calls it, or it is
   judgment that belongs in a pure module — move it there and export it.
2. **One suite per module.** Tests for `lib/services/takeoff.ts` live in
   `tests/takeoff.test.js`. A new feature adds cases to the suite for its area;
   it does not start a file named after the ticket, the audit, or the
   invariant (`*-integrity`, `*-hardening`, `*-regression`, `*-recovery`).
3. **Shared fixtures, not per-file harnesses.** Fakes, ID helpers and builders
   live in `tests/support/`. A test file that defines its own query-builder
   mock or its own `Module._load` override is re-implementing infrastructure.
4. **Assert outcomes, not calls.** Prefer "the invoice total is 12,345 cents"
   and "the write was refused with this error" over "`from('invoices')` was
   called twice". Recording calls is for proving something did NOT happen
   (no write after a refusal).
5. **Name the behavior.** `test('a void invoice cannot be paid')`, not
   `test('EP04-07 acceptance')` or a 40-word sentence. One behavior per test;
   a table of cases inside one test is fine.
6. **Fast.** A test runs in well under a second. Anything slower is a
   benchmark or an evaluation and belongs behind its own script, not in
   `pnpm test`.
7. **Never red.** A failing test is fixed or deleted in the same change that
   notices it. A skipped test needs a reason on the same line and an owner.
8. **Written like the code.** Formatted, readable, no one-line minified
   harnesses. Tests are read far more often than they are written.
9. **No coverage theatre.** Don't add a test to prove a change was made, to
   back a checklist entry, or to pad a count. Fewer, sharper tests win.

## Where tests live and how they run

- `tests/*.test.js` — Node test runner, `pnpm test:node`. Area scripts in
  `package.json` (`test:financials`, `test:takeoff`, …) run subsets.
- `lib/**/*.test.ts` — Bun, `pnpm test:bun`.
- `supabase/tests/*.sql` — pgTAP against a local stack, `pnpm test:db`.
- `e2e/` — Playwright, `pnpm verify:e2e`.
- `tests/support/` — the only place shared harness code goes.
- `tests/fixtures/` — static inputs (captured schemas, sample PDFs). A fixture
  is read by a test; nothing else lives there.
