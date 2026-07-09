# Plan 002: Sanitize counterparty-supplied signature SVG at write and render

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**: `git diff --stat 7e98e5de..HEAD -- components/contracts/contract-detail-sheet.tsx lib/services/lien-waivers.ts lib/services/conversions.ts lib/services/proposals.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: plans/001-verification-baseline.md (for `pnpm typecheck` / `pnpm test`)
- **Category**: security
- **Planned at**: commit `7e98e5de`, 2026-07-07 (working tree carried
  uncommitted changes; excerpts reflect the working tree)

## Why this matters

Signature SVG markup supplied by external signers (clients and subcontractors
signing via unauthenticated token links) is stored verbatim and later rendered
into the builder's authenticated dashboard via `dangerouslySetInnerHTML`. SVG
can carry script (`<script>`, event-handler attributes, `<foreignObject>`), so
a crafted "signature" submitted through a public signing link executes in the
org's session inside a financial app — stored XSS. There is currently **no
HTML/SVG sanitizer anywhere in the repo** (no DOMPurify/sanitize-html in
`package.json` or imports). This plan adds one sanitization utility and applies
it at every point where signature SVG is stored or rendered.

## Current state

- **The sink** — `components/contracts/contract-detail-sheet.tsx:86-90`:

```tsx
{contract.signature_data?.signature_svg ? (
  <div className="rounded-md border bg-muted/40 p-3">
    <div
      className="signature-preview"
      dangerouslySetInnerHTML={{ __html: contract.signature_data.signature_svg }}
    />
```

This is the only `dangerouslySetInnerHTML` in product UI (the other match, in
`app/layout.tsx:45`, is a static theme script — leave it alone).

- **An untrusted write path** — `lib/services/lien-waivers.ts:88-124`,
  `signLienWaiver(token, signatureData)`: called from a public token route,
  accepts `signature_svg: string` from the request and stores it into
  `lien_waivers.signature_data` with no validation:

```ts
export async function signLienWaiver(
  token: string,
  signatureData: {
    signature_svg: string
    signer_name: string
    signer_ip?: string
  },
) {
  ...
  .update({
    status: "signed",
    signed_at: signedAt,
    signature_data: { ...signatureData, signed_at: signedAt },
  })
```

- **The flow that feeds contracts**: portal/estimate/proposal signing captures
  a signature payload; `lib/services/conversions.ts:34-42` types
  `ProposalAcceptanceSignatureData` with `signature_svg?: string | null` and
  passes it through (`conversions.ts:263` `p_signature_data:
  input.signaturePayload`; `:812` copies `estimate.signature_data` onto the
  contract). `lib/services/proposals.ts` also handles `signature_data`. The
  exact capture points where a request body first supplies the SVG must be
  found by grep in Step 2 — sanitize at first ingestion, not deep in the
  pipeline.

- Repo conventions: services own logic (`lib/services/`); shared utilities
  live in `lib/`; TypeScript strict, no `any`. New dependency additions are
  allowed but must be justified — this plan adds exactly one.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Install dep | `pnpm add isomorphic-dompurify` | exit 0, lockfile updated |
| Typecheck | `pnpm typecheck` | exit 0 |
| Lint | `pnpm lint` | exit 0 |
| Tests | `pnpm test` | all pass, incl. new sanitizer tests |

## Scope

**In scope** (the only files you should modify/create):
- `lib/security/sanitize-svg.ts` (create)
- `lib/security/sanitize-svg.test.ts` (create)
- `components/contracts/contract-detail-sheet.tsx`
- `lib/services/lien-waivers.ts`
- The first-ingestion points found in Step 2 (expected: the proposal/estimate
  signing service functions and the lien-waiver signing action; list them in
  your report)
- `package.json` / `pnpm-lock.yaml` (dependency add only)

**Out of scope** (do NOT touch):
- `app/layout.tsx` — its `dangerouslySetInnerHTML` is a static inline theme
  script, not user data.
- Signature *capture* UI components (the drawing pads) — they generate the
  SVG client-side; the trust boundary is the server, not the pad.
- Migrating stored signatures to raster/PNG — noted in Maintenance as a
  possible future hardening; not this plan.
- Any database migration or backfill of already-stored SVG (see Maintenance).

## Git workflow

- Branch: `advisor/002-sanitize-signature-svg`
- Commit style: short imperative subject matching `git log`.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Create the sanitizer utility

Add `isomorphic-dompurify` (works in both Node and browser contexts — the
sink is a client component, the write paths are server code). Create
`lib/security/sanitize-svg.ts`:

```ts
import DOMPurify from "isomorphic-dompurify"

/**
 * Sanitizes counterparty-supplied signature SVG before storage or rendering.
 * Signatures are stroke paths; anything beyond basic shapes is stripped.
 */
export function sanitizeSignatureSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true },
    FORBID_TAGS: ["foreignObject", "use", "image", "animate", "set", "script", "style"],
    FORBID_ATTR: ["href", "xlink:href", "style"],
  })
}
```

**Verify**: `pnpm typecheck` → exit 0.

### Step 2: Find every first-ingestion point for signature SVG

Run:
- `grep -rn "signature_svg" lib/ app/ components/ --include='*.ts' --include='*.tsx'`
- `grep -rn "signaturePayload\|signature_data" app/ --include='*.ts'` (server
  actions and token-route actions that accept a request body containing SVG)

Classify each hit as: (a) type definition, (b) read/render, (c) pass-through,
or (d) **first ingestion from a request** — the point where an HTTP/action
input first becomes a value that will be persisted. Expected (d) sites include
`signLienWaiver` in `lib/services/lien-waivers.ts` and the proposal/estimate
signing service(s) reached from portal routes. List all (d) sites in your
report.

**Verify**: you have an explicit list of (d) sites with file:line.

### Step 3: Sanitize at every first-ingestion point

At each (d) site, wrap the incoming SVG:
`signature_svg: sanitizeSignatureSvg(input.signature_svg)` (preserve
null/undefined handling — sanitize only when a non-empty string is present).
In `signLienWaiver` specifically, sanitize before the `.update()` call.

**Verify**: `pnpm typecheck && pnpm lint` → exit 0.

### Step 4: Sanitize at the render sink

In `components/contracts/contract-detail-sheet.tsx`, import
`sanitizeSignatureSvg` and change the sink to
`dangerouslySetInnerHTML={{ __html: sanitizeSignatureSvg(contract.signature_data.signature_svg) }}`.
This is belt-and-braces: already-stored unsanitized SVG (written before this
plan) is neutralized at display time.

**Verify**: `grep -rn "dangerouslySetInnerHTML" components/ app/ --include='*.tsx' | grep -v layout.tsx | grep -v sanitizeSignatureSvg` → no matches.

### Step 5: Tests

Create `lib/security/sanitize-svg.test.ts` (runnable via the pattern in
`lib/services/invoice-numbers.test.ts` — `node --test` with
`scripts/register-ts-node-test.js`; add the file to the `test:unit` script in
`package.json` created by plan 001). Cases:

1. A plain path signature (`<svg viewBox="0 0 100 40"><path d="M1 2 L3 4" stroke="black"/></svg>`) passes through with path and viewBox intact.
2. A `<script>` element inside the SVG is removed.
3. An `onload` attribute on the `<svg>` element is removed.
4. A `<foreignObject>` element is removed.
5. An `href`/`xlink:href` attribute is removed.
6. Empty string input returns an empty/safe string without throwing.

**Verify**: `pnpm test:unit` → all pass including the 6 new cases.

## Done criteria

Machine-checkable. ALL must hold:

- [ ] `pnpm typecheck` exits 0
- [ ] `pnpm lint` exits 0
- [ ] `pnpm test:unit` passes, including `lib/security/sanitize-svg.test.ts`
- [ ] `grep -rn "dangerouslySetInnerHTML" components/ | grep -v sanitizeSignatureSvg` returns nothing
- [ ] Every (d) site from Step 2 calls `sanitizeSignatureSvg` (list them in the PR/report)
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- `isomorphic-dompurify` fails to install or import in the server context
  (report the error rather than swapping in a hand-rolled regex sanitizer —
  regex sanitizers are how this class of bug survives).
- Step 2 reveals signature SVG rendered somewhere else with
  `dangerouslySetInnerHTML` that this plan's scope list doesn't cover — report
  the site; do not expand scope silently.
- Sanitization visibly corrupts a legitimate signature in test case 1 (i.e.
  the path data itself is stripped) — the DOMPurify config needs adjusting;
  report if two attempts don't resolve it.

## Maintenance notes

- Any NEW feature that stores or renders counterparty markup (signatures,
  rich-text notes from portals) must route through `lib/security/` — reviewers
  should reject raw `dangerouslySetInnerHTML` on non-static data.
- Deferred: backfill-sanitizing `signature_data.signature_svg` already stored
  in `lien_waivers` / `contracts` / `estimates` rows. The render-site
  sanitization (Step 4) neutralizes those on display, so the backfill is
  defense-in-depth; it requires a production data migration and operator
  approval (local dev points at PRODUCTION Supabase — never run data
  mutations without explicit approval).
- Deferred: storing signatures as PNG data URLs instead of SVG would remove
  the sink class entirely; larger change, product decision.
