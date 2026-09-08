# Arc Books implementation tracking

Scope: all 22 findings in `arc-books-review-2026-09-07.md`. Implementation changes cover each area below. The 13 reviewed migrations and one trigger permission hardening follow-up were applied to production Arc through Supabase MCP on September 8, with explicit user approval. **The task is not yet accepted end to end:** full-schema workflow/concurrency, authenticated UI and complete restore verification are outstanding. Existing unrelated work is preserved.

| Item | Implemented change | Verification / boundary |
| --- | --- | --- |
| 01 | Economic readers retain original and reversing entries; bank matching preserves historical movements | Targeted statement and SQL tests pass |
| 02 | Contra-account statement presentation uses category signs; TB preserves normal-balance direction | Targeted tests pass |
| 03 | Fiscal dates, final POC → retained earnings → official snapshots, zero-net-income closing and residual reclose | Fiscal/posting tests pass; full close/reopen acceptance pending |
| 04 | Date- and version-aware fact identities; failed source coding does not retire valid history | Identity tests pass |
| 05 | Atomic org/account/direction/capacity-checked bank matching | Isolated SQL passes |
| 06 | Bank-to-book proof, outstanding book lines, frozen evidence, authorized reopen and visible comparison | Isolated SQL passes, including period/reopen gates |
| 07 | Atomic deposit batch membership, posting, matching and retry | Isolated SQL passes |
| 08 | Actual funding mappings; bank/card selectors for expenses and manual AP payments; atomic payment funding | Native funding and first AP payment/retry SQL passes |
| 09 | Approved vendor credits reach job cost; bank-coded direct costs create linked job actuals | Bank-cost SQL passes; complete vendor-credit workflow acceptance pending |
| 10 | Employer labor cost independent of client billing approval; payroll/reimbursement/withholding settlement | Gross/net/clearing SQL passes |
| 11 | Evidenced land acquisition, financed basis, development allocation, eligible interest, construction/completed inventory and sale relief | Isolated lifecycle SQL passes; production workflow acceptance pending |
| 12 | Visit amounts distinguished from approved posted actuals; source capacity, reserve estimate/consumption/recovery and reversal | Isolated approval/recovery/reversal SQL passes |
| 13 | Settlement DTO readers, specific-source projection, durable failed/posting state, actual settlement dates and UI | Typechecked; authenticated closing acceptance pending |
| 14 | Contract/project net positions presented as separate assets/liabilities with supporting positions | Statement tests pass; incomplete historical tags remain project-level |
| 15 | Actual operating cash and event-aware cash-flow classification | Depreciation and asset-disposal scenarios pass |
| 16 | Anchored recurrence, unique occurrences, durable proposals and terminal schedule state | Month-end/retry/completion SQL passes |
| 17 | Atomic AR/AP/deposit/retainage/debt/asset openings, independent approvals, source ownership, depreciation baseline and unused-batch reversal | Actual first AR/AP receipt/payment and deposit application RPCs pass in isolated fixture |
| 18 | Versioned export completeness contract, additional workflow dependencies, relationship checks and streamed supporting-byte verification; offline verifier | Roundtrip/integrity tests pass; full application-schema restore remains pending |
| 19 | Historical-version rebuild, explicit reversal-chain/economic checks, native register exceptions and truthful maintenance outcomes | Financial suite passes; full register/rebuild acceptance pending |
| 20 | Reviewer-supported clearing schedules tied to exact ledger digest; stale reviews rejected | Targeted schedule tests pass |
| 21 | Taxable/exempt/unclassified bases, credit inputs, opening/deposit/release exclusions and write-off separation | Tax basis tests pass; filing-period acceptance pending |
| 22 | Org-wide permission contract, captured cost/project dimensions, dimension breakdowns, fiscal overhead, shared statements and aggregate paging | Typechecked and targeted tests pass; full-volume/UI acceptance pending |

Current evidence: `pnpm test:financials` passed 818 tests. The four focused Books suites passed 108 tests. The final `pnpm lint` and `pnpm typecheck` runs both passed. The two SQL runners use selected real definitions with minimal dependencies and a posting stub; they are not a full-schema database acceptance run.

See [the concrete migration review](/Users/agustinzenuto/Code/Arc/advisor-plans/arc-books-migration-review-2026-09-07.md) for the exact ordered 13-file set, SHA-256 digests, applied remote versions, supported boundaries and remaining acceptance gates. Production verification confirmed all 42 functions, expected columns and enabled triggers, reporting adapters, and service-only execution for Books RPCs and definer guards. No test business transactions, payments, application deployment or commit were performed.
