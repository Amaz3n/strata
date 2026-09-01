# 003 — Delay visual and assistive loading feedback together

- **Status**: DONE
- **Commit**: e4b84fcf
- **Severity**: MEDIUM
- **Category**: Accessibility
- **Estimated scope**: 4 files, about 60 lines

## Problem

The Arc mark is visually suppressed for 250ms, but its status semantics exist immediately:

```tsx
// components/layout/app-navigation-fallback.tsx:6-14 — current
<div
  className="flex min-h-full w-full flex-1 items-center justify-center"
  data-navigation-pending="true"
  role="status"
  aria-busy="true"
  aria-label="Loading page"
>
  <div className="arc-loading-presence flex min-h-56 items-center justify-center">
```

```css
/* app/globals.css:510-513 — current */
.arc-loading-presence {
  opacity: 0;
  animation: arc-loading-enter 0.18s ease-out 0.25s forwards;
}
```

Sighted users avoid flashes on fast routes, but screen-reader users can hear “Loading page” on those same near-instant navigations.

## Target

Create a small client wrapper that waits exactly 250ms before mounting both the visible mark and its polite status announcement. Once mounted, the mark enters over 180ms with a strong UI ease-out:

```css
animation: arc-loading-enter 0.18s cubic-bezier(0.23, 1, 0.32, 1) forwards;
```

The mounted status uses `role="status"`, `aria-live="polite"`, `aria-busy="true"`, and the caller-provided label. Before 250ms there is no status node and no animation. The timeout is cleared on unmount. Reduced motion mounts the static mark at 250ms with no transform or animation.

## Repo conventions to follow

- Place the reusable client wrapper beside the brand component, e.g. `components/brand/delayed-loading-status.tsx`.
- Reuse `ArcLoadingMark`; do not copy its SVG.
- Keep `.arc-loading-presence` and `@keyframes arc-loading-enter` in `app/globals.css`.
- Use the audit-standard ease-out curve `cubic-bezier(0.23, 1, 0.32, 1)` and preserve the existing 180ms duration.

## Steps

1. Add `components/brand/delayed-loading-status.tsx` with `"use client"`, `useEffect`, and `useState(false)`. Start a 250ms timeout, clear it on cleanup, return `null` until elapsed, then render a configurable wrapper containing `<div className="arc-loading-presence">{children}</div>`. Accept `label`, `className`, and `children` props. Apply `role="status"`, `aria-live="polite"`, `aria-busy="true"`, and `aria-label={label}` only to the mounted wrapper.
2. In `app/globals.css`, remove the `0.25s` animation delay from `.arc-loading-presence` and replace bare `ease-out` with `cubic-bezier(0.23, 1, 0.32, 1)`. Keep the reduced-motion rule that forces opacity 1 and removes transforms.
3. Refactor `components/layout/app-navigation-fallback.tsx` to render its sizing/layout wrapper immediately, but put `ArcLoadingMark` inside `DelayedLoadingStatus label="Loading page"`. Keep `data-navigation-pending="true"` on the immediate outer wrapper for tests and UI state; do not put ARIA status semantics there.
4. Refactor `app/loading.tsx` to use `DelayedLoadingStatus label="Loading Arc"` around `ArcLoadingMark` and remove immediate `role`, `aria-busy`, and `aria-label` from its outer shell.
5. Refactor `AppChromeFallback` in `app/(app)/layout.tsx` the same way with label `Loading Arc`. The empty sidebar/header geometry may render immediately; only the mark and announcement are delayed.
6. Add focused fake-timer tests for cancellation before 250ms, absence of status semantics before 250ms, and simultaneous mark/status presence at 250ms.

## Boundaries

- Do NOT delay the persistent app chrome geometry.
- Do NOT announce loading with `aria-live="assertive"`.
- Do NOT change the 250ms threshold or 180ms entrance duration.
- Do NOT remove the reduced-motion rules or the Arc shimmer’s reduced-motion suppression.
- Do NOT add dependencies.

## Verification

- **Mechanical**: run the focused wrapper tests, `pnpm typecheck`, and `pnpm lint`; all must exit 0.
- **Feel check**: with no throttling, navigate through prefetched routes and confirm no mark flashes. Under Slow 3G, confirm the mark appears after about 250ms and fades/translates in once. In DevTools at 10% animation speed, confirm the entrance starts fast and settles without a second delay.
- **Accessibility check**: use VoiceOver. Confirm a fast navigation produces no loading announcement; a sustained navigation announces “Loading page” once. Toggle `prefers-reduced-motion` and confirm the mark appears statically after 250ms.
- **Done when**: visual and assistive feedback share the same delay, timers clean up, and fast navigation remains silent and flash-free.

