# Plan 005: Convert estimate server actions to the ActionResult pattern

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7e98e5de..HEAD -- 'app/(app)/estimates/actions.ts' components/estimates/estimates-client.tsx components/pipeline/prospect-detail-sheet.tsx`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: plans/001-verification-baseline.md (verification commands)
- **Category**: bug (error handling / repo-rule violation)
- **Planned at**: commit `7e98e5de`, 2026-07-07 (working tree carried
  uncommitted changes; excerpts reflect the working tree)

## Why this matters

The repo has an explicit rule (CLAUDE.md, "Non-negotiable code rules"):
*"Server actions must return `{ success, error }` result objects — thrown
errors get redacted to a useless digest in prod."* The estimate actions
violate it: `duplicateEstimateAction`, `updateEstimateStatusAction`,
`sendEstimateAction`, `reviseEstimateAction`, `createEstimateVersionAction`,
and `getEstimateForEditAction` all let service errors throw. In production a
failed send/duplicate/status-change shows the user an opaque digest instead of
the real message ("You don't have permission…", validation errors, QBO
failures). The invoices actions file already implements the correct pattern
and is the exemplar to copy.

## Current state

- **The offending actions** — `app/(app)/estimates/actions.ts:111-155+`:

```ts
export async function duplicateEstimateAction(estimateId: string) {
  const estimate = await duplicateEstimate({ estimateId })
  revalidatePath("/estimates")
  return estimate
}

export async function updateEstimateStatusAction(estimateId: string, status: "draft" | "sent" | "approved" | "rejected") {
  const estimate = await updateEstimateStatus({ estimateId, status })
  revalidatePath("/estimates")
  return estimate
}

export async function sendEstimateAction(estimateId: string, message?: string) { ... }
export async function getEstimateShareLinkAction(estimateId: string) { ... }
export async function getEstimateBuilderSigningLinkAction(estimateId: string) { ... }
export async function reviseEstimateAction(estimateId: string) { ... }
export async function createEstimateVersionAction(estimateId: string, input: unknown) { ... }
export async function getEstimateForEditAction(estimateId: string) { /* throws "Estimate not found" */ }
```

  Audit the WHOLE file: any exported action that can throw a service error
  gets wrapped, not just the ones excerpted. Pure-read list helpers that
  already return `[]` on error (e.g. the template-list loader at the top of
  the file) may stay as they are.

- **The exemplar** — `app/(app)/invoices/actions.ts:48-60` and
  `lib/action-result.ts`:

```ts
import { actionError, type ActionResult } from "@/lib/action-result"

// Thrown errors are redacted to a digest in prod, so every action returns an ActionResult
// (see lib/action-result.ts); clients unwrap with unwrapAction().
async function run<T>(fn: () => Promise<T>): Promise<ActionResult<T>> {
  try {
    return { success: true, data: await fn() }
  } catch (error) {
    console.error("[invoices.action]", error)
    return actionError(error)
  }
}

export async function listInvoicesAction(...) {
  return run(() => listInvoices({ ... }))
}
```

  `lib/action-result.ts` exports `ActionResult<T>`, `actionError()` (with
  Zod-issue formatting), and `unwrapAction<T>()` for client call sites.

- **Client call sites** (must be updated to unwrap — the return type changes
  from `T` to `ActionResult<T>`):
  - `components/estimates/estimates-client.tsx`
  - `components/pipeline/prospect-detail-sheet.tsx`
  Re-derive the full list at execution time:
  `grep -rln "EstimateAction\|EstimateStatusAction\|EstimateVersionAction\|EstimateForEditAction\|EstimateShareLinkAction\|EstimateBuilderSigningLinkAction" components/ app/ --include='*.tsx' --include='*.ts' | grep -v 'estimates/actions'`
  Client convention: `const result = await xAction(...)` then
  `unwrapAction(result)` inside the existing try/catch, or check
  `result.success` and `toast.error(result.error)` — match how
  `components/invoices/` client files consume invoice actions (open one and
  copy its idiom).

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `pnpm typecheck` | exit 0 — this is the main safety net: every un-updated call site becomes a type error |
| Lint | `pnpm lint` | exit 0 |
| Tests | `pnpm test` | all pass |

## Scope

**In scope** (the only files you should modify):
- `app/(app)/estimates/actions.ts`
- Every client file surfaced by the grep above (expected: the two listed)

**Out of scope** (do NOT touch):
- `lib/services/estimates.ts` and other services — they are SUPPOSED to throw;
  the wrapping happens at the action layer only.
- `lib/action-result.ts` — use as-is.
- Portal/token estimate routes (`app/e/[token]`, `components/portal/`) — they
  consume services directly or have their own error paths; only the
  authenticated app actions in the file above change.
- Other `actions.ts` files that also violate the rule (e.g. parts of
  `app/(app)/pipeline/actions.ts` may) — one file per plan; report extras,
  don't fix them here.

## Git workflow

- Branch: `advisor/005-estimate-actions-result-pattern`
- Commit style: short imperative subject matching `git log` (the July 2026
  invoices overhaul commit is precedent for this exact change shape).
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Add the `run` wrapper to estimates actions

In `app/(app)/estimates/actions.ts`, add the same private `run<T>` helper as
the invoices exemplar (log prefix `"[estimates.action]"`), importing
`actionError` and `ActionResult` from `@/lib/action-result`.

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Wrap every throwing action

Convert each exported mutating/detail action to `return run(async () => { ... })`,
keeping `revalidatePath` calls INSIDE the wrapped function after the service
call succeeds (a failed action must not revalidate). Do not change any
service-call arguments or Zod parsing — `run` + `actionError` already format
`ZodError` nicely.

**Verify**: `pnpm typecheck` → now expect errors ONLY in the client files that
consume these actions (their types changed). List them; they are your Step 3
worklist. If errors appear anywhere else, STOP.

### Step 3: Update client call sites

For each consuming component, unwrap results using the idiom in
`components/invoices/` client code (find a call like
`unwrapAction(await createInvoiceAction(...))` or a `result.success` check
with `toast.error(result.error)` and copy it). Preserve each component's
existing toast/pending-state behavior — this change should be invisible on
the success path.

**Verify**: `pnpm typecheck && pnpm lint` → exit 0.

## Test plan

No new tests: the conversion is mechanical and the type system is the
regression net (an unconverted call site cannot compile). Run the full
existing suite to confirm nothing else regressed.

**Verify**: `pnpm test` → all pass.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck`, `pnpm lint`, `pnpm test` all exit 0
- [ ] Every exported action in `app/(app)/estimates/actions.ts` that calls a
      throwing service returns `ActionResult<...>` (spot-check: no bare
      `return estimate` after an unwrapped service call remains)
- [ ] `grep -n "unwrapAction\|success" components/estimates/estimates-client.tsx` shows results are unwrapped
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- A consuming call site passes an action reference into a shared helper/hook
  whose type expects the raw value (changing that helper would ripple beyond
  scope).
- Step 2's typecheck surfaces errors outside the expected client files.
- You find a call site in portal/token code (`app/e/`, `app/p/`,
  `components/portal/`) importing these actions — the plan assumed none;
  report it.

## Maintenance notes

- The audit found the same violation pattern likely present in other action
  files (`app/(app)/pipeline/actions.ts` was flagged as a candidate). This
  plan deliberately covers only estimates; sweep the rest with the same recipe
  in follow-up plans.
- Review focus: every `revalidatePath` must remain on the success path only.
- Future actions in this file must use `run()` — the file-top comment (copy
  the invoices one) is the reviewer's cue.
