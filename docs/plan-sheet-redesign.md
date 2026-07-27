# Plans detail — review and redesign proposal

Two parts: (1) what I think of the production org playbook now that the surfaces
exist, with the changes I'd make to it; (2) the ground-up redesign of
`/plans/[id]`, **The Plan Sheet**, which is now built.

**Status.** Part 2 shipped. Part 1 is a review — the playbook itself has not been
edited, and the schema additions in §1.5 are not applied.

---

## Part 1 — Review of the playbook

The spine is right. Nine stations, one home per mutation, desks vs. workbenches,
community as a lens and not a nav mode — that is a coherent model and it is the
reason this tier feels like software for builders rather than a CRM with a
hardhat. What follows are the places where it is wrong, drifted, or incomplete.

### 1.1 The playbook has drifted from the repo

`/starts/pipeline`, `/starts/trades`, `/starts/reports`, `/starts/settings` and
`app/(app)/starts/layout.tsx` are deleted in the working tree; the surfaces are
now `/starts`, `/starts/[id]`, `/schedule/trades`, `/settings/starts`. Role 6's
"Lives on" list points at three routes that no longer exist. Same for
`/communities/[id]/plans` (now `/offering`) and `/selections` (folded into Design
Studio). Also: the Demo readiness list numbers 1, 2, 4, 5 — item 3 is missing.

Fix the route inventory before it becomes the thing a new executor trusts.

### 1.2 Plans is badly under-described — it is the most important page in the tier

The spine says Plans owns "House plans, elevations, specs." What it actually owns
is the **bill of process**: takeoff and cost basis, the template bundle, the
release/version contract that every in-flight house is pinned to, community
availability and launch price. `instantiatePlanForProject` turns one plan version
into a budget, a schedule, checklists, a drawing set and a selection sheet.

That makes Plans the only page in Arc where a single mistake multiplies across
every house you will ever build. A wrong number on an invoice costs you once. A
wrong takeoff line costs you 40 times and you find out at closing. The playbook
should say so, and the page should be built like it matters that much.

### 1.3 There is no role that lives on Plans

Every one of the eleven roles names a home surface and none of them is `/plans`.
That is a real gap, not an oversight of prose. Add:

> **Estimator / Product Manager** — at 25–200 closings this is often the
> owner, the ops VP, or a shared seat with Purchasing. Lives on `/plans`.
> Mutates: plans, elevations, takeoffs, template bundles, releases. Reads:
> actual-vs-takeoff variance from closed houses, price book coverage.
> Weekly loop: value-engineer the draft edition, watch the unpriced-line count,
> release on a cadence tied to price-book renewals — not ad hoc.

Right now Role 6 (Starts/Purchasing) implies takeoff maintenance without saying
it, and Role 2 (Sales Manager) owns price without any stated counterparty owning
cost. The margin conversation has two sides and the playbook only staffs one.

### 1.4 The structural-vs-finish option seam is in the wrong place

`option_scope` is already `"structural" | "design_studio"`, which is the right
distinction. But the playbook assigns *all* options to Design Studio and the
Design Studio Coordinator, and the plan page shows nothing about options at all.

In a real production builder those are two different products owned by two
different people:

- **Structural options** — bonus room, 4th bedroom, extended garage, sunroom,
  morning room, gourmet kitchen. They change the takeoff, the schedule, the
  footprint on the lot, and they die at framing. They belong to the plan and the
  estimator.
- **Finish options** — flooring, cabinets, counters, fixtures. They are the
  coordinator's catalog and are cut off per selection group.

My recommendation: **structural options are edited on the plan**, finish options
in Design Studio. Design Studio keeps read-only visibility of structural (it
still has to show them on the selection sheet). Otherwise "one home per mutation"
holds on paper while in practice the estimator has to leave the plan to change
something that reprices the plan.

### 1.5 A plan has no dimensions, so "does it fit?" is unanswerable

`lots.dimensions` carries `width_ft` / `depth_ft`. `house_plans` carries neither.
So the question a sales consultant and a land manager ask constantly — *which of
my plans fit the 50s in Phase 2?* — cannot be asked anywhere in Arc. Add
`width_ft`, `depth_ft` (and optionally a minimum lot width) to `house_plans`, and
the Communities Lots tab gets a real "plans that fit" filter for free.

### 1.6 Nothing closes the loop between what we estimated and what we spent

Every number on the plan surface is forward-looking. There is no path from the 14
closed houses built on v2 back to "the takeoff said $188,600 and we actually
spent $196,900, concentrated in framing." That comparison is the single most
valuable number a production builder can have, it is fully derivable from data
Arc already stores (pinned version → project → budget/actuals), and it is the
thing that tells you a takeoff is wrong *before* you build 40 more of them.

I would make this a first-class element of the plan page and a section of
Reports. If I could only add one thing to the production tier, it would be this.

### 1.7 Margin has no upper sanity bound

`grossMarginPct` colors anything ≥22% as success. The seeded demo currently shows
**75–80% gross margin** on the plan library, because the sample takeoffs total
~$20k against $385k homes — and the UI paints that bright green. A production
builder's gross margin is 18–24%. Anything above ~30% means the cost basis is
incomplete, not that you are printing money. The scale needs a top end that reads
"check the takeoff," and the demo seed needs realistic takeoffs before any demo.

### 1.8 Pages: add, delete, merge

- **Merge** the plan page's *Margin* and *Where it's built* sections. Both are
  "one row per community." Two sections, one axis. (Done in the redesign below.)
- **Keep** the Plans / Community-Offering split exactly as it is: Plans decides
  *which* communities may sell a plan and sets the launch price once; the
  Offering tab owns the weekly reprice. That is a genuinely good boundary.
- **Do not** build a community-level Plans tab. `/plans` with the community lens
  is that view — same reasoning as the absent community Starts tab.
- **Move** cross-plan analysis (cycle time by plan, margin by plan, cost drift by
  plan) to Reports. The plan page should carry only its own slice of it.
- **Consider deleting** `/plans`' product-ladder chart from the *library* page and
  making it a Reports section. It is an executive artifact — a sales manager's
  "where are the gaps in my product line" — sitting on the estimator's index page.
  It is also the only thing on the library page a builder would screenshot, so
  this is a judgment call, not a defect.

---

## Part 2 — The redesign: **The Plan Sheet**

### 2.1 What is wrong with the page today

I read every section and drove the live page. The problems are structural, not
cosmetic:

1. **It is a settings form pretending to be a workbench.** `1650` is rendered as
   an editable text input. So is `3`, `2`, `1`, `2`. Reading the plan means
   reading form fields. The page is enormous and says very little.
2. **The takeoff — the heart of the page — is a wall of controls.** Every row is
   five `<Select>`/`<Input>` elements, for 25–200 rows, with no grouping, no
   sorting, no search, no keyboard grid, and horizontal overflow that clips the
   delete button. An estimator works by cost-code division; the page offers an
   elevation dropdown and a CSV paste box.
3. **The version model is invisible where it matters.** The one question a
   release asks — *what changed and what does it do to margin* — is answerable
   only via a collapsed drift accordion at the very bottom of the page, and only
   for already-superseded versions. You cannot see v3-vs-v2 while deciding
   whether to release v3.
4. **Release has no weight.** It freezes the bill of process for every future
   house. It is a small button in a row of five checkmarks styled exactly like
   every other section.
5. **The plan does not look like a house.** The most identifying artifact — the
   elevation rendering — is a grey placeholder icon with an upload link, and the
   plan-set PDF is a text link. This is a product catalog page with no product.
6. **Two sections ask the same question** (Margin, Where it's built — both "per
   community").
7. **Details:** money printed to the cent on a price sheet (`$385,000.00`); a
   176px left rail that empties out on scroll; a header title collision
   (`Plans`/`CL1650`/`All divisions` overlap); disabled-input read mode instead of
   text; per-row Save buttons on elevations.

### 2.2 The idea

**A plan is a product with editions.** That is the whole design.

- The **left panel is the product** and never moves: the elevation, the name, the
  specs, and four vital signs. It answers "what is this?" for the sales manager,
  the super and the land manager, who are 80% of the page's traffic.
- The **right canvas is the edition** you are working on, chosen by one control.
- There are **no tabs**. Tabs were how the old page hid the fact that it had no
  point of view about what matters.

### 2.3 Left: the product panel (sticky, ~366px)

- **Elevation render**, 4:3, filling the panel. Elevation swatches directly
  underneath as a filmstrip — switching cross-fades the render and re-reads the
  sqft (elevation B is +40 sf). When there is no art, the panel shows the plan
  code set huge in a tinted blueprint field, not a grey icon. It still looks
  deliberate, and the "add rendering" affordance is one click.
- **Identity block**: code, name in display type, series, spec ribbon, and a
  **lot-fit chip** ("Fits 50′ and wider · 42′ × 68′ footprint") — the §1.5 data
  addition, and the single most-asked question about a plan.
- **Four vital signs**, in the order people ask them:
  1. **Sells for** — the price band across communities.
  2. **Costs to build** — `$/heated sf` as the hero (that is how builders
     compare), total as the sub, with the draft's delta beside it.
  3. **Gross margin** as a **corridor gauge**, not a percentage in a color: a
     track with underwater / healthy 18–24% / check-the-takeoff zones and a pin.
     A 75% margin lands in "check the takeoff," which is the correct reading.
  4. **Estimated vs. actual** — §1.6. "14 closed houses · $194,700 est. vs
     $203,180 actual · +4.4%, concentrated in 3200 Framing and 9100 Landscape."
     This is the number that makes the page worth opening on a Monday.

### 2.4 Right: the canvas

**Edition timeline** across the top — v1 · v2 · v3 as a horizontal track with the
consequential fact under each one ("7 houses still on it", "released 3 Feb · 14
houses built", "draft · 2027 repricing"). Selecting an edition changes the whole
canvas *and* the left panel's numbers. One control, no tabs.

**The status band** is the loudest element on the page and changes character
with the edition's state:

- **Draft** → a **release ramp**. The five gates are segments you can watch fill;
  required gates are solid-edged, optional ones hatched; open gates are red and
  clickable, jumping to the exact editor that closes them. The **Release** button
  sits physically at the end of the ramp, so you can see how far you are from
  being allowed to press it. The subtitle states the consequence in plain
  language ("v2 becomes superseded; its 14 houses keep building to v2").
- **Released / current** → a calm ledger: who released it, when, how many houses,
  median cycle, actuals variance. One action: *Start a new edition*.
- **Superseded** → a diff header: "7 houses are still building to it," and the
  canvas below reads as the change ledger against the current edition.

**Block 1 — The bill (takeoff).** The single biggest change on the page:

- **Grouped by cost-code division** (3200 Framing, 6100 Interior finish, 9100
  Landscape), collapsible, each group carrying its subtotal, its delta, and a
  **share bar** so the shape of the cost is legible in one glance.
- **Diff-native.** A `v2 | v3 | Δ` column set is always present when a prior
  edition exists. Unchanged lines dim. One toggle — *Only what changed vs v2* —
  collapses the bill to the release argument. This turns approving a release from
  an act of faith into an act of reading, and it is the reason the page can be
  trusted.
- **Elevation deltas are columns, not a filter.** `Base | A | B` inline. A plan
  with three elevations is one table, not four filtered views.
- **Read-first, edit-in-place.** Cells are text; click makes one a field, Tab
  moves across, Enter commits. Released editions are simply not editable — no
  disabled-input graveyard.
- **Price-book source shown only where it is interesting** (differs from manual,
  or unpriced). Unpriced counts pin to the group header where they can block.
- **Cost-of-sales stack** closes the block: one horizontal bar splitting the base
  price into build / lot / indirects / gross, with the worst and best community
  called out and the repricing's margin cost stated in points.

**Block 2 — What a start generates (the bundle).** Reframed from four dropdowns
and two checkbox farms into a **manifest of consequences**: five rows, each
saying what will exist inside the house the moment a lot is released, with real
counts, the plan-set thumbnail, the schedule's phase strip, and one inline
control each. Editing is a side effect of reading. Structural options appear here
as a row that links to their editor (§1.4).

**Block 3 — Where it sells and where it stands.** The merge from §1.8. One row
per community: elevations offered, price, lot basis, margin, a lot-status bar
with counts, and a *Reprice →* deep link to the Offering tab. Two old sections,
one axis, half the page height.

### 2.5 Motion, used three times only

Switching editions cross-fades the numbers and tweens the margin pin along its
corridor. Switching elevation cross-fades the render and slides the delta column.
Closing a release gate fills its ramp segment. Nothing else animates.

### 2.6 What shipped, and what is still outstanding

Built:

| Piece | Where |
| --- | --- |
| The sheet shell, edition selector, status band | `components/plans/plan-sheet.tsx`, `plan-editions.tsx`, `plan-status-band.tsx` |
| Product panel with the four vital signs | `components/plans/plan-product-panel.tsx` |
| Specs/elevations moved behind an edit sheet | `components/plans/plan-product-editor.tsx` |
| Division-grouped, diff-native bill | `lib/plans/bill.ts`, `components/plans/plan-bill.tsx` |
| Bundle as a manifest of consequences | `components/plans/plan-manifest.tsx` |
| Offering + footprint merged, one row per community | `lib/plans/offering.ts`, `components/plans/plan-market.tsx` |
| Actual-vs-takeoff per edition | `getPlanBuildPerformance` in `lib/services/house-plans.ts` |
| Margin plausibility ceiling (also applied to the plan library) | `lib/plans/margin.ts` |

Deleted: `plan-workbench`, `plan-product-section`, `plan-release-section`,
`plan-cost-section`, `plan-margin-matrix`, `plan-bundle-section`,
`plan-footprint-section`, `plan-version-rail`.

Still outstanding:

| Need | Where | Effort |
| --- | --- | --- |
| `width_ft` / `depth_ft` on `house_plans`, for the lot-fit chip | migration + product editor | small — needs a production migration, not applied |
| Structural options scoped to a plan | read from `selection_catalog` where `option_scope='structural'` | small (read), medium (edit) |
| Realistic demo takeoffs — the sample org shows a 75% gross margin | `demo-community-seed.ts` | small, and blocking for any demo |
| Header breadcrumb collapses to zero width and the page title paints over the division lens | `components/layout/app-header.tsx` | the left header section is 358px against ~373px of content, so the breadcrumb (the only shrinkable child) is squeezed to 0; the fix is to let the lens selects shrink or narrow `CommandSearch`, which is a header-wide decision |

### 2.7 One idea from the proposal that did not survive contact

Elevation deltas as `Base | A | B` columns. The data model does not support it
honestly: an elevation line is its own line ("A: extra gable framing"), not a
variant of a base line, so pivoting would have invented relationships that are
not there. The bill tags each row with its elevation and keeps the filter instead.

---

## Open questions for you

1. Do you agree structural options move to the plan, or do you want Design Studio
   to stay the single catalog home even for framing-gated options?
2. Is estimated-vs-actual worth a service now, or does it wait for real customer
   data? My view: build it now — it is the page's reason to exist.
3. Product ladder: keep on the plan library, or move to Reports?
