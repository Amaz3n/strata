# Plan 007: Repo hygiene sweep — tracked binaries, stray files, dead dep, dead export

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7e98e5de..HEAD -- package.json .gitignore lib/services/retainage.ts workers/drawings-worker/`
> If any in-scope file changed since this plan was written, compare the
> "Current state" facts against the live repo before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-verification-baseline.md (verification commands)
- **Category**: tech-debt / dependencies
- **Planned at**: commit `7e98e5de`, 2026-07-07 (working tree carried
  uncommitted changes)

## Why this matters

The repo carries a 57 MB Google Cloud CLI tarball, a stale npm lockfile beside
the real pnpm one, five root-level scratch files (including an empty SQL file
named like a migration sitting OUTSIDE `supabase/migrations/`), compiled
worker output that the Dockerfile rebuilds anyway, a dependency with zero
imports, one high-severity (build-time-only) audit advisory, and a dead
exported service function. Individually trivial; collectively they slow
clones, confuse contributors and agents about what's real, and violate the
repo's own "leave no trash" rule. Everything here is deletion or one-line
config — no behavior changes.

## Current state (verified facts)

All of the following are git-tracked (`git ls-files`) as of planning:

| Item | Path | Fact |
|------|------|------|
| Tarball | `google-cloud-cli-darwin-arm.tar.gz` | 57 MB binary at repo root |
| Stale lockfile | `package-lock.json` (root) | pnpm is the package manager (`pnpm-lock.yaml`, `pnpm-workspace.yaml`); note `workers/drawings-worker/package-lock.json` is DIFFERENT — that subpackage uses `npm ci` in its Dockerfile and its lockfile must stay |
| Scratch scripts | `fix-pages.sh`, `fix-signatures.js`, `compare_migrations.js` | one-off scripts at root, not referenced by any `package.json` script |
| Empty SQL | `temp_schema_dump.sql` | 0 bytes |
| Misplaced migration | `20260211120000_fix_drawing_sheets_mv_permissions.sql` (root) | 0 bytes, named like a migration but outside `supabase/migrations/` |
| Notes file | `2025-12-06-please-review-my-app-this-app-will-compete-with-a.txt` | stray prompt/notes text at root |
| Compiled output | `workers/drawings-worker/dist/*.js` (7 files) | tracked, but `workers/drawings-worker/Dockerfile` runs `npm ci` + `RUN npm run build` and only then `CMD ["node", "dist/index.js"]` — the image never uses the committed dist |
| Dead dependency | `react-pdf` in `package.json` | zero imports across `app/`, `components/`, `lib/` (verified by grep) |
| Audit advisory | `picomatch` <4.0.4 (via `@sentry/nextjs → @rollup/plugin-commonjs`) | high-severity ReDoS, build-tooling path only |
| Dead export | `createInvoiceWithRetainage` in `lib/services/retainage.ts` (starts ~line 210) | zero callers outside its own file; also ignores its `retainage_percent` parameter (invoice retainage is actually derived inside `createInvoice`, `lib/services/invoices.ts:434`) |

`tsconfig.tsbuildinfo` is already gitignored and untracked — leave it alone.

Repo conventions: "Leave no trash" (CLAUDE.md) — deletions are the fix, not
archival moves. Schema changes only via `supabase/migrations/`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install (after dep change) | `pnpm install` | exit 0, lockfile updated |
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint | `pnpm lint` | exit 0 |
| Tests | `pnpm test` | all pass |
| Audit | `pnpm audit --prod` | no high/critical after the pin |

## Scope

**In scope**:
- Deletions of exactly the tracked files listed above
- `.gitignore` (additions)
- `package.json` + `pnpm-lock.yaml` (remove `react-pdf`, add picomatch override)
- `lib/services/retainage.ts` (remove the dead export only)

**Out of scope** (do NOT touch):
- `workers/drawings-worker/package-lock.json` and everything else under
  `workers/` except the `dist/` directory.
- `supabase/migrations/` — nothing in this plan creates or edits migrations.
- Git history rewriting (filter-repo/BFG) to purge the tarball from history —
  worthwhile but operator-decision territory (rewrites shared history); note
  it, don't do it.
- The other four PDF libraries (`pdf-lib`, `pdfjs-dist`, `@react-pdf/renderer`,
  `mupdf`) — all have real imports; consolidation was audited and deferred.
- `createRetainageRecord` and the rest of `lib/services/retainage.ts` — only
  `createInvoiceWithRetainage` is dead.

## Git workflow

- Branch: `advisor/007-repo-hygiene-sweep`
- One commit per step is fine; short imperative subjects.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Verify, then delete the stray tracked files

First re-verify each fact (files can gain callers between planning and
execution):

- `wc -c temp_schema_dump.sql 20260211120000_fix_drawing_sheets_mv_permissions.sql` → both 0 bytes. If the root migration file is NOT empty, STOP (it may be an unapplied fix someone parked — check whether `supabase/migrations/` contains a file with the same timestamp; report either way).
- `grep -rn "fix-pages.sh\|fix-signatures.js\|compare_migrations.js" package.json scripts/ vercel.json .github 2>/dev/null` → no matches.

Then: `git rm google-cloud-cli-darwin-arm.tar.gz package-lock.json fix-pages.sh fix-signatures.js compare_migrations.js temp_schema_dump.sql 20260211120000_fix_drawing_sheets_mv_permissions.sql "2025-12-06-please-review-my-app-this-app-will-compete-with-a.txt"`

**Verify**: `git status` shows exactly those 8 deletions staged.

### Step 2: Remove tracked worker dist and update .gitignore

- `git rm -r workers/drawings-worker/dist`
- Append to `.gitignore`:

```
*.tar.gz
/package-lock.json
workers/drawings-worker/dist/
```

(The `/package-lock.json` leading slash keeps the worker's own npm lockfile
trackable.)

**Verify**: `git check-ignore workers/drawings-worker/dist/index.js` → path is
ignored; `git check-ignore workers/drawings-worker/package-lock.json` → NOT
ignored (exit 1).

### Step 3: Drop `react-pdf` and pin picomatch

- Re-verify: `grep -rn "react-pdf" app/ components/ lib/ --include='*.ts' --include='*.tsx' | grep -v "@react-pdf"` → no matches (the `@react-pdf/renderer` scoped package is a DIFFERENT, used library; only the bare `react-pdf` goes).
- Remove `"react-pdf"` from `package.json` dependencies.
- Add `"picomatch": ">=4.0.4"` to BOTH override blocks in `package.json`
  (`overrides` and `pnpm.overrides` — the file maintains both).
- `pnpm install`

**Verify**: `pnpm audit --prod` → no high/critical advisories; `pnpm typecheck && pnpm lint` → exit 0.

### Step 4: Delete the dead retainage export

- Re-verify: `grep -rn "createInvoiceWithRetainage" app/ components/ lib/ --include='*.ts' --include='*.tsx' | grep -v retainage.ts` → no matches. If a caller has appeared, STOP.
- Delete the entire `createInvoiceWithRetainage` function from
  `lib/services/retainage.ts`, plus any imports it alone used.

**Verify**: `pnpm typecheck && pnpm lint` → exit 0.

### Step 5: Full verification

**Verify**: `pnpm test` → all pass; `git status` shows changes only to the
in-scope paths.

## Test plan

No new tests — this plan removes things. The full existing suite plus
typecheck is the regression net.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `git ls-files | grep -E 'tar.gz|temp_schema_dump|fix-signatures|fix-pages|compare_migrations|2025-12-06'` → empty
- [ ] `git ls-files | grep '^package-lock.json'` → empty (worker's own lockfile still tracked)
- [ ] `git ls-files workers/drawings-worker/dist` → empty
- [ ] `grep '"react-pdf"' package.json` → no match
- [ ] `pnpm audit --prod` → no high/critical
- [ ] `pnpm typecheck && pnpm lint && pnpm test` all exit 0
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- The root migration-named SQL file is non-empty (see Step 1).
- Any "dead" item re-verifies as live (a new import/caller/script reference
  appeared since planning).
- `pnpm install` after the dependency change alters unrelated resolution
  entries en masse (>50 lockfile package changes) — report before committing.

## Maintenance notes

- The tarball remains in git HISTORY (~57 MB in every full clone). Purging it
  requires `git filter-repo` and a force-push — operator decision, coordinate
  with anyone who has clones. Recorded here so it isn't forgotten.
- Deferred deliberately: consolidating `pdfjs-dist` vs `mupdf` (two PDF
  rasterizers) — both are live in the drawings pipeline; behavioral
  differences make this a real project, not hygiene.
- Deferred deliberately: `-new` filename renames
  (`components/bids/bid-package-detail-client-new.tsx`,
  `components/bid-portal/bid-portal-client-new.tsx` + its dead sibling
  `bid-portal-client.tsx`) — flagged in the audit; rename touches large live
  files and deserves its own careful change.
