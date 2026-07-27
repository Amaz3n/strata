# Arc Design Standard

The single source of truth for how Arc looks and moves. `CLAUDE.md` carries a
short digest of the hard rules; this file is the full standard. `app/globals.css`
holds the tokens and points here.

**The look:** a quiet, modern console — Linear/Vercel, not a newspaper.
Paper-white surfaces, graphite ink, sharp corners, mono tabular figures.
Structure comes from spacing and subtle surface shifts (a slightly darker panel,
a low-contrast 1px border) — never from tinted section blocks, heavy rules, or
enclosure for its own sake. Authority comes from density and alignment, not
decoration.

**Who it is for:** construction PMs, superintendents, purchasing managers, and
bookkeepers. They scan hundreds of rows and money numbers a day, on a second
monitor, for eight hours. Every decoration you add is something they have to
look past.

---

## 1. Two zones

Arc has an ascetic product and an expressive edge. The boundary is **the
surface**, not the component.

### Ascetic zone — everything under `app/(app)/**`

Desks, workbenches, tables, forms, financial UI, dialogs and sheets opened from
them. The rules in §2–§6 are absolute here. There are no exceptions and no
"just this once": a desk that reads as decorated is a bug.

### Expressive zone

- `app/(auth)/**` — sign-in, sign-up, invite acceptance
- Token portals — `app/p`, `app/s`, `app/b`, `app/d`, `app/e`, `app/f`,
  `app/i`, `app/r`, `app/t`, `app/proposal`, `app/access`
- Legal/marketing/help — `app/terms`, `app/privacy`, `app/esign-terms`, `app/help`

These face clients, subs, and buyers who see Arc a handful of times and are not
scanning for numbers. Depth, gradient, motion, and brand character are welcome
here — subject to §5's reduced-motion floor and §4's token rule (a gradient
built from `--primary` is fine; one built from `#4f46e5` is not).

### The crossing allowlist

Three identity elements may appear **inside** the ascetic zone:

| Element | Where | Why |
|---|---|---|
| `components/ui/project-avatar.tsx` | Anywhere a project is named | Identity + fast visual keying across 200 rows |
| Empty-state illustration | The empty state only | Nothing to scan yet; the page is not doing work |
| Brand mark | Sidebar, header | It is the brand |

Nothing else crosses. If you want to add a fourth, it goes in this table in the
same change — an undocumented exception is drift.

---

## 2. Radius

`--radius: 0rem`. Arc is square, and that is the identity.

- **Never set a radius class to control shape.** `rounded-lg`, `rounded-md`, and
  `rounded-sm` all resolve to `0` through the theme; writing them is a no-op that
  implies rounding that never renders. The token owns radius, not the component.
- `rounded-full` is allowed for **small status chips, dots, and avatars** — things
  that are round because they are round, not because they are softened.
- `rounded-xl` / `rounded-2xl` resolve to a real 4px+ and are **expressive zone
  only**.

There are ~658 legacy no-op `rounded-lg`/`rounded-md` occurrences. They are
harmless and not worth a sweep, but do not add more.

---

## 3. Tokens only

Every color in the app resolves to a variable defined in `app/globals.css`.

- No hex, rgb, or oklch **literals** in components.
- No raw Tailwind palette classes — `bg-emerald-500`, `text-indigo-50`,
  `border-slate-200`. This includes the grays.
- No new grays. If you need a surface between `--muted` and `--card`, use
  `color-mix(in oklab, ...)` against existing tokens.

**Format matters.** Tokens are `oklch`, not `hsl` — never wrap one in `hsl()`.

| Context | Form |
|---|---|
| Tailwind class | `bg-chart-1`, `text-warning`, `border-l-chart-3` |
| Inline style / Recharts `fill`+`stroke` | `var(--color-chart-1)` |
| shadcn `ChartConfig.color` | `var(--chart-1)` |

**This rule is linted.** `.eslintrc.js` bans raw palette classes and 6-digit hex
literals in `.tsx` via `no-restricted-syntax` — in both plain strings and
template chunks.

- **New code errors.** `pnpm lint` fails.
- **132 pre-existing files are grandfathered to warnings** (949 violations) so
  the rule can be a hard error everywhere else. `pnpm lint` is `--quiet`, so the
  debt does not drown the signal; run **`pnpm lint:tokens`** to see it.
- When you clean a file, delete its path from `GRANDFATHERED` in `.eslintrc.js`
  in the same change. Never add one.

Note: paths under dynamic route segments must escape the brackets
(`app/d/\\[token\\]/page.tsx`) or the glob reads `[token]` as a character class
and the entry silently matches nothing.

---

## 4. Color is state

Blue = primary/active. Amber = warning/aging. Red = late/destructive.
Green = success.

Color is **never decoration and never section identity**. A payments section is
not green — a *paid amount* is. A safety module is not orange — an *open
incident* is. When a reviewer can't say what state a color is reporting, remove it.

Available ramps: `--chart-1..5` (categorical, blue leads), `--age-0..2`
(fresh → aging → stale, used by AR/AP aging bands and anywhere time pressure is
visualized), `--signer-1..5` (e-sign identities), `--success` / `--warning` /
`--destructive`.

---

## 5. Layout and density

- **Pages open with the work.** A title row, then the data. No hero blocks, no
  colored marquee panels, no oversized stat billboards. Existing marquee headers
  are legacy, not a pattern to copy.
- **Tables over cards.** These users scan. A card grid holds a tenth of the rows
  and costs a scroll. Reach for cards only when each item genuinely has an
  image or a shape a row can't carry.
- **Money is `tabular-nums`,** right-aligned, in integer cents formatted at the
  edge.
- **Sections separate with whitespace and a `.microlabel` first.** Reach for a
  bordered `bg-card` / `bg-muted` panel only when a region must read as one unit
  (a line-item card, a docked pane). Never tint a section background to label it.
- **Match your siblings.** Type sizes, row heights, and padding come from the
  neighboring pages in the same directory. If your new tab looks like it came
  from a different app, it did — redo it.
- **Scale is the design case, not the stress case.** 400-lot communities and
  200-active-project orgs are normal. Every list gets pagination or an explicit
  cap from day one, and the cap is *visible* to the user when it truncates.

---

## 6. Motion

### Ascetic zone

1. **One orchestrated entrance per page load** — `.desk-rise`, staggered with
   `--desk-stagger: 0 | 1 | 2…`. Not one per component.
2. **Hover/state transitions ≤ 200ms.**
3. **No infinite animation** except a live-progress indicator for work that is
   actually happening right now: `.skeleton-shimmer`, `.receipt-scan-sweep`,
   `drawing-shimmer`. An idle page must be perfectly still.

### Expressive zone

Free, within two limits: honor `prefers-reduced-motion: reduce` (globals.css
and each component stylesheet already do), and never animate a property that
triggers layout.

---

## 7. Components

- **shadcn/ui primitives only**, from `components/ui/`. Need a variant? Extend
  the primitive. Never fork it, never inline a parallel one.
- **Every view ships four states:** empty, loading, error, and dark mode. A view
  missing any of them is unfinished, not "iterating."
- **Loading states are skeletons that match the real layout,** not spinners in
  the middle of a blank page. The page shape should not jump when data lands.

---

## 8. Where CSS lives

- `app/globals.css` — tokens, base styles, and the small shared class library
  (`.microlabel`, `.spectrum`, `.desk-rise`, the permitted progress shimmers).
  **Target: under ~500 lines.**
- **Component-specific CSS lives next to its component** — see
  `components/schedule/gantt.css`, `components/starts/starts.css`,
  `components/design-studio/studio.css`.

> **Known debt:** `globals.css` is currently 644 lines because the
> `.project-avatar` shimmer block lives there. Per this rule it belongs in
> `components/ui/project-avatar.css`. Move it the next time that file is touched.

---

## 9. What is enforced vs. judged

| Rule | Enforcement |
|---|---|
| Tokens only (palette classes, hex literals) | ESLint — `pnpm lint` / `pnpm lint:tokens` |
| Radius 0 | `--radius` token — structural |
| Reduced motion | Per-stylesheet media query |
| Zone boundaries, density, color-is-state, four states | **Review judgment** |

The judged rules are the ones that decay. When a rule in this file is violated
often enough to feel normal, either enforce it in the linter or change the rule
here — do not leave it as prose everyone overrides.
