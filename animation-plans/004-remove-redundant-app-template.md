# 004 — Remove the redundant app template boundary

- **Status**: DONE
- **Commit**: e4b84fcf
- **Severity**: LOW
- **Category**: Purpose & frequency
- **Estimated scope**: delete 1 file after behavioral verification

## Problem

The authenticated tree has three navigation-fallback owners: the Next.js loading convention, an explicit template boundary, and optimistic client feedback:

```tsx
// app/(app)/template.tsx:1-11 — current
import { Suspense } from "react"
import { AppNavigationFallback } from "@/components/layout/app-navigation-fallback"

export default function AppTemplate({ children }: { children: React.ReactNode }) {
  return <Suspense fallback={<AppNavigationFallback />}>{children}</Suspense>
}
```

```tsx
// components/layout/app-page-content.tsx:24 — current
{isNavigationPending ? <AppNavigationFallback tier={productTier} /> : children}
```

Next.js templates remount when their segment changes. This template has no state, effects, DOM shell, or behavior beyond duplicating `app/(app)/loading.tsx`, making ownership harder to reason about and adding another possible fallback swap.

## Target

After plan 001 proves that `app/(app)/loading.tsx` covers all authenticated descendants, delete `app/(app)/template.tsx`.

Retain `app/(app)/loading.tsx` as the framework-owned prefetched streaming fallback, the optimistic feedback in `components/layout/app-page-content.tsx` for immediate unprefetched/programmatic navigation, and `AppChromeFallback` for unresolved authenticated layout work.

## Repo conventions to follow

- Prefer App Router `loading.tsx` for route streaming.
- Keep persistent state in layouts; do not add a replacement template unless a route explicitly needs remount semantics.
- Preserve the existing interruptible React `useTransition` navigation.

## Steps

1. Complete and verify plans 002, 003, and 001 first.
2. Capture before-removal behavior under Slow 3G for top-level siblings, nested siblings, a dynamic parameter change, browser Back/Forward, and an unprefetched link.
3. Delete only `app/(app)/template.tsx`.
4. Run all mechanical checks and repeat the exact navigation matrix.
5. If navigation loses immediate feedback, retains stale content without pending feedback, or stops being interruptible, restore the file and report the dependent path. Do not invent a replacement boundary in this plan.

## Boundaries

- Do NOT delete `app/(app)/loading.tsx`.
- Do NOT remove the optimistic fallback in `components/layout/app-page-content.tsx`.
- Do NOT alter layouts, page state, scroll restoration, or navigation APIs.
- Do NOT add dependencies.
- Do NOT execute this plan before plan 001 is complete and verified.

## Verification

- **Mechanical**: run `pnpm typecheck`, `pnpm lint`, and `pnpm build`; all must exit 0. Confirm `test ! -e 'app/(app)/template.tsx'` and `test -f 'app/(app)/loading.tsx'` both pass.
- **Feel check**: under Slow 3G, test Projects → Books, project Schedule → Photos, one dynamic record to another, browser Back/Forward, an unprefetched destination, and rapid last-click-wins navigation. Confirm the Arc mark appears once after its delay, chrome stays mounted, and content replaces the mark directly.
- **State check**: confirm sidebar state, mobile navigation, active route highlighting, and the app header remain stable. Confirm no page relied on the template to reset client state.
- **Done when**: removing the template causes no visual, streaming, state-reset, or interruptibility regression and leaves exactly two intentional layers: framework streaming plus optimistic pending feedback.

