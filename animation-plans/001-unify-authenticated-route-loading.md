# 001 — Collapse authenticated route loading to one boundary

- **Status**: DONE
- **Commit**: e4b84fcf
- **Severity**: MEDIUM
- **Category**: Cohesion & tokens
- **Estimated scope**: delete 130 redundant files; retain 1 canonical boundary

## Problem

The authenticated route tree contains 131 `loading.tsx` files. The route-group boundary already covers every descendant:

```tsx
// app/(app)/loading.tsx:1 — canonical inherited boundary
export { AppNavigationFallback as default } from "@/components/layout/app-navigation-fallback"
```

Next.js automatically wraps a segment's page and descendants with its `loading.tsx` Suspense boundary. Every deeper `app/(app)/**/loading.tsx` therefore overrides the canonical boundary rather than adding necessary coverage. At commit `e4b84fcf`, 130 tracked descendant files duplicate or conflict with it:

```sh
git ls-files 'app/(app)/**/loading.tsx'
```

The pathspec does not include the canonical `app/(app)/loading.tsx`. Some descendants duplicate the Arc fallback; others render route skeletons, allowing a slow navigation to change visual language midway through the wait.

## Target

Retain exactly one authenticated framework loading file: `app/(app)/loading.tsx`. Delete exactly the 130 tracked paths returned by `git ls-files 'app/(app)/**/loading.tsx'`.

Every authenticated route then inherits `AppNavigationFallback`. Skeletons remain component-local for stable content geometry. Buttons retain pending labels or compact spinners. Uploads, imports, and background jobs retain determinate progress when a real percentage exists.

## Repo conventions to follow

- Reuse `components/layout/app-navigation-fallback.tsx`; do not duplicate its SVG or timing.
- Preserve `components/ui/skeleton.tsx` and `.skeleton-shimmer` in `app/globals.css` for component-local fetches.
- Preserve `Progress`, `Loader2`, and pending labels inside interactive components.
- Keep `app/loading.tsx` for root startup and keep auth, help, public portal, and token-route loaders for their separate shells.

## Steps

1. Run `git ls-files 'app/(app)/**/loading.tsx'` and inspect the full manifest. It must contain exactly 130 paths, all beneath `app/(app)/`, and must not contain `app/(app)/loading.tsx`. If any condition fails, STOP and report drift.
2. Delete exactly those 130 manifest paths using explicit patch deletions or another reviewable mechanism. Do not use a broad unresolved filesystem glob.
3. Confirm `app/(app)/loading.tsx` remains tracked and still re-exports `AppNavigationFallback`.
4. Confirm `app/loading.tsx`, `app/(auth)/loading.tsx`, `app/help/loading.tsx`, and all public/token loaders outside `(app)` remain unchanged.
5. Confirm no component-local `Skeleton`, `Loader2`, pending label, or `Progress` implementation was touched.

## Boundaries

- Do NOT delete `app/(app)/loading.tsx`.
- Do NOT delete any `loading.tsx` outside `app/(app)/**`.
- Do NOT remove component-local skeletons, action spinners, pending labels, or progress bars.
- Do NOT modify `app/(app)/template.tsx` here; plan 004 evaluates that separate boundary after this migration.
- Do NOT change `components/brand/arc-loading-mark.tsx` or animation timing here.
- Do NOT add dependencies.
- If the manifest differs from 130 files at commit `e4b84fcf`, STOP and report instead of improvising.

## Verification

- **Mechanical**: `test "$(git ls-files 'app/(app)/**/loading.tsx' | wc -l | tr -d ' ')" = "0"`; `test -f 'app/(app)/loading.tsx'`; `rg -q 'AppNavigationFallback' 'app/(app)/loading.tsx'`; then run `pnpm typecheck`, `pnpm lint`, and `pnpm build`. All must exit 0.
- **Boundary check**: inspect production build output and confirm authenticated routes remain streamable/dynamic as expected, with no missing-Suspense or uncached-data build error.
- **Feel check**: throttle to Slow 3G and navigate among top-level siblings (Projects → Books → Sales), nested siblings (project Schedule → Photos → Reports), and dynamic records. Confirm persistent chrome remains interactive and one delayed Arc mark occupies the content region until ready. Rapidly click two destinations and confirm last-click-wins.
- **Regression check**: directly load and hard-refresh representative authenticated URLs. Confirm `AppChromeFallback` covers unresolved authenticated layout work and the inherited `(app)` boundary covers descendant streaming. Confirm public/auth pages retain their contextual skeletons.
- **Done when**: the authenticated tree has one `loading.tsx`, all 130 nested overrides are gone, builds pass, direct and client navigations show one coherent fallback, and local feedback primitives are unchanged.

