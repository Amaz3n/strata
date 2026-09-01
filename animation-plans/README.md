# Loading motion implementation plans

Plans were written against commit `e4b84fcf`.

| Plan | Title | Severity | Status |
| --- | --- | --- | --- |
| 001 | Unify authenticated route loading | MEDIUM | DONE |
| 002 | Inherit the active product tier in loaders | MEDIUM | DONE |
| 003 | Delay visual and assistive loading feedback together | MEDIUM | DONE |
| 004 | Remove the redundant app template boundary | LOW | DONE |

## Recommended execution order

1. **002** — establish correct tier-color inheritance before expanding the shared fallback.
2. **003** — make the shared fallback fast and accessibility-consistent before increasing its coverage.
3. **001** — delete all 130 nested authenticated loading overrides after the shared primitive is correct.
4. **004** — remove the redundant template Suspense boundary only after inherited loading behavior is verified.

Plans 002 and 003 both touch `components/layout/app-navigation-fallback.tsx`; execute them sequentially and preserve both changes. Plan 001 depends on both because it expands that component to every authenticated route boundary.

Plan 004 depends on plan 001. It deliberately retains the optimistic fallback in `components/layout/app-page-content.tsx`; removing that final client-side layer requires separate performance evidence and is not part of this roadmap.

The intended loading taxonomy after completion is:

- Arc mark: authenticated route navigation and unresolved app-shell loading.
- Skeleton shimmer: local regions with stable, meaningful final geometry; public/auth shells where structure provides context.
- Spinner or pending label: compact actions such as buttons and inline saves.
- Determinate progress: uploads, imports, conversions, and background work with a real measurable percentage.
