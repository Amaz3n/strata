# 002 — Inherit the active product tier in loaders

- **Status**: DONE
- **Commit**: e4b84fcf
- **Severity**: MEDIUM
- **Category**: Cohesion & tokens
- **Estimated scope**: 3 files, about 25 lines

## Problem

Nested Suspense and route fallbacks call `AppNavigationFallback` without a tier, and the component silently defaults to residential blue:

```tsx
// components/layout/app-navigation-fallback.tsx:4 — current
export function AppNavigationFallback({ tier = "residential" }: { tier?: ProductTier }) {
```

```tsx
// app/(app)/template.tsx:11 — current
return <Suspense fallback={<AppNavigationFallback />}>{children}</Suspense>
```

Commercial and production users can therefore see a residential-colored shimmer after the optimistic fallback, even though `components/layout/app-page-content.tsx:24` correctly supplies the active tier initially.

## Target

The authenticated chrome publishes a CSS custom property inherited by every nested fallback:

```tsx
style={{
  "--arc-loading-light": `var(--tier-${productTier}-light)`,
} as React.CSSProperties}
```

`ArcLoadingMark` uses an explicit `tier` when supplied, otherwise the inherited property, with residential only as the root fallback:

```tsx
const light = tier
  ? TIER_LIGHT[tier]
  : "var(--arc-loading-light, var(--tier-residential-light))"
```

`AppNavigationFallback` no longer assigns `tier = "residential"`.

## Repo conventions to follow

- Existing color tokens are in `app/globals.css:147-153`: `--tier-residential-light`, `--tier-commercial-light`, and `--tier-production-light`.
- Keep the explicit `tier={productTier}` call in `components/layout/app-page-content.tsx:24`; explicit data wins over inheritance.
- Root and pre-auth loading may legitimately fall back to residential because no organization tier has resolved.

## Steps

1. In `components/brand/arc-loading-mark.tsx`, remove the default value from the `tier` prop and compute `light` using the exact target expression above.
2. In `components/layout/app-navigation-fallback.tsx`, remove `= "residential"` from the `tier` destructuring and continue passing the optional value to `ArcLoadingMark`.
3. In `app/(app)/layout.tsx`, wrap the resolved authenticated chrome in an element that inherits `--arc-loading-light: var(--tier-${productTier}-light)`. Use `className="contents"` so the wrapper does not alter layout. Type the custom property with `React.CSSProperties` or an imported `CSSProperties` type.
4. Leave `AppChromeFallback` unchanged: it renders before organization data resolves and should use the residential fallback.

## Boundaries

- Do NOT change the three tier token values.
- Do NOT introduce a second React context for loader color.
- Do NOT read cookies or repeat product-tier server queries inside `loading.tsx` files.
- Do NOT add dependencies.
- If the authenticated layout no longer has a single resolved `productTier`, STOP and report.

## Verification

- **Mechanical**: run `pnpm typecheck` and `pnpm lint`; both must exit 0.
- **Feel check**: under Slow 3G, navigate within residential, commercial, and production organizations. Confirm the initial optimistic mark and any streamed fallback use the same color with no blue flash between them. Inspect the fallback in DevTools and confirm `--arc-loading-light` resolves to the matching tier token.
- **Reduced motion**: enable `prefers-reduced-motion`; confirm the static mark retains the correct tier color while the highlight is hidden.
- **Done when**: every authenticated fallback inherits the active organization tier, while root/pre-auth loading safely remains residential.

