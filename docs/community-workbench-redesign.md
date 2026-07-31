# Community workbench redesign

An assessment of `/communities/[id]` and a proposed replacement, written from two
seats: someone who has run a production builder's operating rhythm, and a senior
designer holding `docs/design.md`.

**Status:** review + gameplan. Nothing here is implemented.

---

## 1. What the page is today

| Surface | File | Carries |
| --- | --- | --- |
| Shell | `app/(app)/communities/[id]/layout.tsx` | Title, breadcrumb, tabs, status badge, 4 lot-count stats |
| Lots (default) | `components/communities/community-plat.tsx` | 34px tile grid, 6 color lenses, search, phase filter, arrange mode, add-lots dialog, legend, bulk footer |
| Lot detail | `components/communities/lot-inspector.tsx` | Sheet: Land / Price / Home / Money |
| Offering | `components/communities/offering-tab.tsx` | Price sheet (inline edit), incentives table + dialog |
| Settings | `app/(app)/communities/[id]/settings/page.tsx` | Identity form + location form + archive, then phases table, then takedowns table, then team table |

Three tabs: **Lots · Offering · Settings**.

---

## 2. The core problem

**The page's front door is a map, and a map is not the job.**

Nobody at a production builder opens a community to ask "what shape is the plat."
The plat matters twice — once when you set it up, and occasionally when a
consultant points at a screen with a buyer in the model home. The recurring
questions the community actually owns are supply, pace, price, and margin. None
of them are on this page.

**The list page is smarter than the detail page.** `/communities` computes, per
community, a full runway model (`lib/services/community-portfolio.ts`):
`salesPacePerMonth`, `requiredPacePerMonth`, `paceState`, `consumptionPerMonth`,
`monthsOfSupply`, `runway[]`, `dryAtMonth`, `verdict`, `startsLast90`,
`salesLast90`, `cancelsLast90`, `closingsByMonth[]`, `marginPercent`,
`targetMarginPercent`, and a typed `urgencies[]` list with deep links. Drilling
into a community **throws every one of those away** and replaces them with four
raw lot-status counts. The zoom-in loses information — that is backwards, and it
means the two surfaces speak different languages about the same object.

**Money is loaded and discarded.** `app/(app)/communities/[id]/page.tsx:28` calls
`getCommunityPnl(id)`, which runs the *entire* production portfolio report scoped
to one community. The returned `CommunityPnlRow` carries community-level
`revenueCents`, `closedRevenueCents`, `backlogRevenueCents`, `budgetCents`,
`actualCostCents`, `vpoCents`, `projectedMarginCents`, `projectedMarginPercent`,
and `targetMarginPercent`. The page keeps only `row.lots` and drops the rest. The
one number an owner asks about weekly — this community's projected margin against
its target — is fetched on every page view and never rendered.

---

## 3. Domain review — by role

| Role | Asks the community | Answered today? |
| --- | --- | --- |
| Land manager | Sellable lots, drain rate, dry date, next takedown | **No** — only on the board |
| Sales manager | Price sheet, incentive load, absorption, traffic | Half — price + incentives only |
| Sales consultant | What can I sell right now, and to whom is 47 sold | **No** — no buyer anywhere |
| Starts manager | What's releasable | Correctly delegated to `/starts` |
| Superintendent | Which of my houses are here | Correctly delegated to `/my-houses` |
| Controller / owner | Community P&L vs target | **No** — computed, discarded |

### Specific domain gaps

1. **No buyer on a lot.** The inspector shows Land / Price / Home / Money. There
   is no prospect, hold, hold expiry, purchase-agreement status, projected
   closing, or selections cutoff. A consultant clicking lot 47 with a buyer
   standing next to them learns nothing about the buyer already on it.
   `lib/services/community-sales.ts` has reservations and agreements;
   `PlatLotDTO` (`lib/services/lots.ts:237`) does not join them.

2. **Two thirds of the lot record is invisible and uneditable.** `LotDTO`
   (`lib/services/lots.ts:30`) and `lotCreateSchema` (`lib/validation/lots.ts:15`)
   both carry `address`, `dimensions` (width / depth / acreage / irregular),
   `swing`, `costBasisCents`, `acquiredDate`, `notes`. The inspector exposes four
   fields: status, phase, takedown, premium. **Swing and lot width are what decide
   whether a plan physically fits a lot** — the single most common production
   land question — and there is no editor for either anywhere in the app.
   `costBasisCents` is the land cost feeding margin; also uneditable.

3. **A created lot range can never get addresses.** `lotRangeSchema` takes
   prefix / from / to / phase / takedown — no address. The inspector renders
   `lot.address` as read-only sheet copy (`lot-inspector.tsx:106`). A 48-lot range
   lands with 48 null addresses and **no path in the product to fill them.**

4. **The "assigned" queue has no surface.** Lifecycle is controlled → owned →
   developed → assigned → started → closed. "Assigned" = sold, not yet released.
   That backlog is a daily sales↔starts conversation. Here it is one tile color,
   with no list, no age, and no blocker.

5. **Traffic is fully built and completely invisible.**
   `lib/services/community-traffic.ts` exports `listCommunityTraffic`,
   `incrementCommunityTraffic`, `logCommunityTraffic`;
   `lib/validation/communities.ts:67` defines the schema;
   `app/(app)/communities/actions.ts:83` exports `logCommunityTrafficAction`.
   **`listCommunityTraffic` and `logCommunityTrafficAction` have zero callers.**
   Weekly traffic → appointments → sales → cancels is the production sales
   office's Monday ritual. Either surface it or delete the service.

6. **The margin lens hardcodes somebody else's underwriting.**
   `community-plat.tsx:135-137` buckets at <12% / <18% / 18%+ while
   `targetMarginPercent` exists per community. Wrong colors for any builder not
   underwritten at 18.

7. **No standing spec inventory or aging.** `listSpecInventory` exists and is used
   by `/sales`' Find-a-home. Spec aging is the sales manager's second-biggest
   lever after price, and `SPEC_AGING_ALERT_DAYS` is already an urgency the
   portfolio computes — unshown here.

8. **No export.** Land managers email a lot inventory to a lender monthly.

---

## 4. Design review

### Structural

1. **Three-to-four stacked chrome bands before any data.** Header strip (tabs +
   stats) → lens/search/actions bar → legend bar → sometimes an arrange hint bar.
   Roughly 120px of chrome above a 34px grid. `docs/design.md` §5: "Pages open
   with the work."

2. **Six-segment lens control is past the glance limit,** and it mixes two kinds
   of thing: Status/Phase/Takedown are *facets*; Premium/Home/Margin are
   *analyses*. One control, two mental models.

3. **The legend reflows per lens** — 6 items for Status, N+1 for Phase, 5 for
   Premium, 2 for Home, 4 for Margin. The page height changes as you click.

4. **The plat is not responsive.** `DEFAULT_PLAT_COLUMNS = 12` is fixed
   regardless of viewport, so a 27" monitor wastes two thirds of its width and a
   400-lot community becomes a 34-row scroll.

5. **Select vs inspect is modifier-disambiguated with no affordance.**
   `community-plat.tsx:199` — plain click inspects, meta/ctrl/shift selects. No
   checkbox, no select-all, no keyboard path, nothing tells the user.

6. **Arrange mode is a hidden full-mode switch** built on HTML5 drag-and-drop:
   no keyboard alternative, no undo, and drop-to-swap has no confirmation.

7. **Settings is a junk drawer of three visual languages.** A `max-w-3xl`
   two-column form with a bottom-right Save, then two full-bleed bordered tables
   with row dropdowns, then a third bordered table. `CommunitySettingsForm`
   applies its own `p-4` inside the page's `p-4` — double padding, and the form is
   capped while the tables below run full width. Visibly asymmetric. Worse, a lot
   takedown is a multi-million-dollar contract event filed under "Settings."

8. **Three commit models on one entity.** Settings = explicit Save. Offering
   price = blur-to-save. Inspector premium = blur-to-save. Inspector status =
   instant on select. A user cannot form one mental model of "is my edit saved."

9. **Four empty-state styles.** `<Empty>` component on the board, an ad-hoc
   centered div on the plat, table-row placeholders in offering/structure, a
   dashed-border box in team.

10. **Section headings are `text-sm font-semibold`** across offering/structure/
    team, where the newer settings surfaces use `.microlabel` + whitespace
    (`docs/design.md` §5). This directory looks like it came from an earlier app.

### Correctness

11. **The truncation message promises something the UI cannot do.**
    `community-plat.tsx:463`: *"Showing 600 of 720 lots. Narrow by phase to reach
    the rest."* The phase filter is client-side dimming (`isDimmed`, line 188) —
    it never refetches. `listLotsForPlat` takes no phase parameter. On a >600-lot
    community those lots are **unreachable**, and the copy sends the user in a
    circle. `PLAT_LOT_CAP = 600` against a stated design case of 400-lot
    communities is one growth spurt from biting.

12. **Search is client-side over only the loaded 600** — same problem, silent.

13. **Two different lot totals on screen.** The header sums `community.lotCounts`
    (from a 5,000-row scan in `getCommunity`); the plat shows `total` from a
    separate 600-capped count query. On a large community the header says 720 and
    the strip below says 600.

---

## 5. Duplication and dead code

| Item | Evidence | Call |
| --- | --- | --- |
| `listLots` + `LotDTO` full lot list | zero callers in `app/` or `components/` | **Delete** or make it the new inventory table's source |
| `lib/services/community-traffic.ts` read path | `listCommunityTraffic` zero callers | Surface it or delete it |
| `logCommunityTrafficAction` | zero UI callers (`actions.ts:83`) | Same |
| `getCommunityPnl` | runs the whole portfolio report; page keeps `.lots` only | Return community totals to the header, or narrow the query |
| Two takedown-create dialogs | `community-board.tsx:497` (name/date/lots/price) vs `community-structure.tsx:372` (adds phase, deposit, status, notes) | Keep the full one; board deep-links to it |
| `type LotStatus` import | unused, `community-plat.tsx:28` | Delete |
| Doubled lot scan per render | `getCommunity` scans ≤5,000 lots for counts; `listLotsForPlat` refetches ≤600 | Derive counts from one read |
| Stale doc | `docs/production-org-playbook.md:73` documents tabs "Lots · Land · Offering · Sales · P&L · Team · Settings"; line 255 references `/communities/[id]/land`. Neither exists | Update with the redesign |

---

## 6. Proposed redesign

### Principle

The community is the **operating unit**. It is a workbench — lots, phases,
takedowns, pricing, incentives, and team are mutated here — and it is the only
home for one community's land economics. It must answer, in this order:

1. Is this community healthy? *(supply · pace · margin — one glance)*
2. What needs someone today? *(urgencies)*
3. What is the inventory, lot by lot? *(a table)*
4. What are we selling and for how much? *(offering)*
5. How is the container built? *(land · team · settings)*

### Header — replace four counts with the four managed numbers

Today: `Sellable · Building · Closed · Lots`. Four flavours of the same fact.

Proposed, right-aligned, `tabular-nums`, one line, no billboard:

| | | |
| --- | --- | --- |
| **Sellable** | `34` | of 118 |
| **Supply** | `8.2 mo` | dry Mar '27 — toned by `verdict` |
| **Pace** | `3.1 / 4.0` | toned by `paceState` |
| **Margin** | `17.4%` | vs 18.0% target — toned against `targetMarginPercent` |

Every value already exists (`community-portfolio.ts`, `production-reporting.ts`).
This makes the detail header speak the board's language, so drilling in is a zoom
rather than a topic change.

### Urgency strip

One row of chips under the header, rendered from the existing
`CommunityUrgency[]` (holds expiring · starts blocked · cutoffs due · specs
aging). Already typed, already carrying `href` and `tone`. Currently shown only
on the board, where it is least actionable.

### Tabs — four, one per role

**`Inventory · Offering · Land · Settings`**

Four tabs against four header stats — symmetric, and each maps to an owner.

#### Inventory *(default)* — the change that matters

**A lot table is primary; the plat becomes a view toggle on the same data.**

`docs/design.md` §5 is explicit: tables over cards, these users scan. A table
gives you address, plan, buyer, status, price, premium, margin, and age-in-status
for 400 lots at once, sorted. A 34px colored square gives you one dimension and
costs a click per lot. The plat stays — spatial questions are real ("which lots
back the pond", "is the cul-de-sac sold out") and the consultant-pointing-at-a-
screen moment is real — but it is the alternate view, not the front door.

- **Toolbar:** `[Table | Map]` toggle · search *(server-side)* · status filter
  chips mirroring the lifecycle · phase filter *(server-side)* · `Add lots` ·
  `Export`.
- **Table columns:** Lot · Address · Phase · Status · Plan / elevation · Buyer ·
  List price · Premium · Margin · Days in status. Checkbox column for bulk.
- **Map view** additionally reveals: `Color by` select (one control replacing the
  6-segment group), the legend, and `Arrange plat`. Three controls disappear from
  the default toolbar because they belong to a view most people never open.
- **Server-side filter + pagination** so the cap is real and the truncation
  message stops lying. Cap stays visible when it truncates.
- **Bulk actions** identical in both views; table gets real checkboxes and a
  select-all, which also fixes the plat's undiscoverable modifier-click.

#### Lot detail sheet — keep the docstring's promise

`lot-inspector.tsx:54` claims "everything about one lot, in one place." Make it
true. Same sheet from both views:

- **Land** — status, phase, takedown, address *(editable)*, width × depth /
  acreage *(editable)*, swing *(editable)*, cost basis *(editable)*, acquired date
- **Product** — plan, elevation, premium, list price
- **Buyer** — prospect, hold + expiry, agreement status, projected close,
  selections cutoff *(read-only, deep-linking to `/sales` and `/design-studio` —
  one home per mutation)*
- **Home** — project link, current stage, % complete
- **Money** — revenue, budget, actual, VPO, projected margin

Plus **bulk address assignment** so a freshly created range can be addressed.

#### Offering

Substance unchanged. Add the two things the sales manager's Monday needs:

- **Standing inventory** — specs with age, list price, and status (`listSpecInventory`)
- **Absorption** — traffic → appointments → sales → cancels by week
  (`listCommunityTraffic` + `logCommunityTraffic`, both already written), against
  `targetAbsorptionPerMonth`

Restyle to `.microlabel` + whitespace to match the settings family.

#### Land *(new — promoted out of Settings)*

- **Runway chart for this community** — reuse `RunwayChart` from
  `community-board.tsx`, one lane at full width
- **Phases** table
- **Takedowns** table with its full dialog and the totals footer

A $2M land tranche stops being a preference.

#### Settings

Identity, location, planned lots, target pace, community team, archive. Only the
things set once. Single commit model: one explicit Save for the form; the team
table keeps its own immediate add/remove, which is fine because it is a roster,
not a form.

### Cross-cutting design fixes

- One commit model per surface, stated in the UI (form = Save; grid = save on
  blur with a settled indicator). Never three on one entity.
- One empty-state component (`<Empty>`) everywhere in this directory.
- Responsive plat: derive columns from container width, keep stored coordinates
  authoritative.
- Keyboard path for arrange mode, or gate arrange behind an explicit "edit plat"
  route with arrow-key nudge.
- Margin thresholds read `targetMarginPercent`, not constants.
- One lot read per render feeding both counts and rows.

---

## 7. Adjacent finding — outside this page, same doctrine

`CLAUDE.md` and `docs/production-org-playbook.md` both state: never add a
per-desk community `<Select>`; scope is the ambient lens.
`components/starts/launch-lane.tsx:274-288` renders exactly that, fed by
`resolveProductionDeskScope` (`lib/services/production-desk-scope.ts`), which also
backs `/schedule`, `/projects`, `/payables`, and `/billing`. Meanwhile `/sales`
and `/plans` use `getAmbientDeskContext()` with no picker.

Two scope mechanisms coexist. That needs one decision — the lens wins and the
selects come out, or the doctrine changes — but it is not this page's fix.

---

## 8. Suggested sequence

1. **Header + urgency strip.** Highest value per line of code; every number is
   already computed and thrown away. Fixes the zoom-in-loses-information problem.
2. **Inventory table + view toggle**, with server-side filter/pagination. Fixes
   the unreachable-lots bug and the density complaint at once.
3. **Lot sheet expansion** (land attributes editable, buyer block read-only).
   Unblocks swing/width, which unblocks plan-fit.
4. **Promote Land out of Settings**; restyle Offering and Settings to the settings
   family's vocabulary.
5. **Traffic + spec inventory on Offering**, or delete `community-traffic.ts`.
6. **Cleanup** — dead `listLots`, duplicate takedown dialog, unused import,
   doubled lot scan, `getCommunityPnl` over-fetch, playbook doc drift.
