# Production builder org — intended use by role

Who does what in Arc at a local production builder, which surface each role lives
on, and what they mutate versus only read. Written for demo prep and as the
reference when deciding where a new production feature belongs.

**Scope.** Arc's production tier targets the **local production builder**:
25–200 closings a year, one metro, 3–10 active communities, roughly 15–40 staff.
Not a national builder (division structure, thousands of closings), not a custom
builder (that is the residential tier).

**Status.** This describes intended use, derived from how production builders are
organised — not from an installed customer. Arc has no production client yet. See
[Demo readiness](#demo-readiness) for what that means for the demo.

---

## The spine

Every production feature belongs to exactly one station on this line. If a
proposed feature does not fit one, it probably does not belong in the tier.

| Station | Page | Owns |
| --- | --- | --- |
| The operating unit | **Communities** | Lots, phases, takedowns, the offering and its pricing, community P&L, the assigned team |
| The product | **Plans** | House plans, elevations, specs |
| The options | **Design Studio** | Option catalog, packages, cutoffs, appointments |
| The sale | **Sales** | Buyers, holds, agreements, closings |
| The release | **Starts** | Start packages, gates, even-flow release |
| The build | **Home** / **Homes** | Schedule, budget, daily logs, punch |
| The service | **Warranty** | Post-close requests, visits, backcharges |
| The money | **Billing / Payables / Purchasing** | Invoices, POs, draws, vendor payments |
| The view | **Reports** | Backlog, cycle time, even-flow, portfolio |

Three rules keep it coherent:

- **One home per mutation.** A record is edited on exactly one surface. Every
  other surface links to it. Sales shows that a selections appointment is due; it
  never schedules one — that is Design Studio's.
- **Org pages are desks, project pages are workbenches.** A desk ranks and
  aggregates across homes and deep-links in. A workbench is where the change
  actually happens.
- **The community is a lens, not a nav mode.** Scope is org → community → home,
  but only two of those change the sidebar. Community narrows every desk at once
  from the header lens; it never forks the navigation. See
  [The community lens](#the-community-lens).

---

## Where does this feature go?

Three tests, in order. The first one that fires wins.

**1. Who owns this record's lifecycle?** Not who reads it — who *advances* it.
That role's home surface owns the mutation. Every other surface links to it.

**2. Is this a queue across many objects, or everything about one object?**
A queue is a desk. One object is a workbench. `/sales` is a queue of buyers;
`/communities/[id]` is one community. "Sold lots awaiting release" is a queue, so
it belongs on `/starts` — not as a tab on the community.

**3. Does this fact change a decision made on this page?** If yes, **display it**,
no matter who owns it. Read-only, deep-linked to the owner.

> Test 3 is the one that gets skipped, and skipping it is how a page goes hollow.
> When holds moved to the Sales desk, the community stopped *showing* buyers as
> well as stopped editing them — so a consultant with a buyer in the model home
> could not answer "what is going on with lot 47". Moving a mutation is not the
> same decision as moving a fact. There is no rule against showing another
> role's data; only against editing it.

The field version: **who does this at 9am on a Tuesday, and what were they
looking at when they decided to?** That screen is where it goes.

### The lot has three owners

An entity is not always owned whole. A lot is one row split by lifecycle stage:

| Transition | Who advances it | Home |
| --- | --- | --- |
| controlled → owned | Land manager (takedown closes) | Communities |
| owned → developed | Land manager | Communities |
| developed → assigned | Consultant (buyer contracts) | Sales |
| assigned → started | Starts manager (release) | Starts |
| started → closed | Closing coordinator | Sales / closing |

**The community owns the lot until it becomes sellable, then reads it.** This is
why the lot inspector's status control stops at *Developed*: everything past it
is the consequence of an owning event, and hand-setting it is how the workbench
and the desks drift apart.

### Allocation

| Feature | Mutated on | Displayed on |
| --- | --- | --- |
| Lot land state, phase, takedown, address, dimensions, swing, cost basis | Communities | Sales, Starts |
| Lot premium | Communities | Sales, agreement |
| Phases, takedowns | Communities → Land | Board |
| Community team | Communities → Settings | — |
| Plan product (elevations, specs) | Plans | Communities → Offering |
| Base price per community, incentives | Communities → Offering | Sales |
| Hold, reservation, buyer, agreement | Sales | Communities → Inventory |
| Selections, cutoffs, appointments | Design Studio | Communities, Sales |
| Start release, gates | Starts | Communities (urgency strip) |
| Traffic log | Sales (inquiry side effect) + Communities → Offering | Reports |
| Spec inventory | Starts (creates the spec) | Communities → Offering, Sales |
| Community P&L | nowhere — derived | Communities (header), Reports |
| Cross-community land supply | nowhere — derived | Reports |

**Known exception, unresolved:** releasing a plan to a community
(`community_plan_availability`) is mutated in the plan library, but by test 1 it
is the sales manager's offering decision and should move to the community
Offering tab. The plan library owns the *product*, not its release.

## The community lens

Production staff are assigned to communities, so the ambient community scope in
the app header narrows every desk at once. This replaced the per-desk community
`<Select>` that each surface used to carry.

- It is **assignment-defaulted**: `community_assignments` records who works a
  community, and somebody with exactly one assignment opens Arc already scoped to
  it. Two or more assignments is ambiguous, so the lens stays open.
- "All communities" is always one click away, and choosing it is *stored* — an
  explicit clear outranks the assignment default on the next request.
- Assignment is a convenience scope, **not** a security boundary. Division scope
  (`membership_divisions`) remains the enforcement layer.

**Why a lens and not a third sidebar.** Only some roles are community-bound. The
sales consultant and land manager are; the starts/purchasing manager explicitly
is not, because even-flow release is levelled across every community at once, and
neither is the design studio coordinator, whose catalog is org-level. A nav mode
would trap the cross-community roles, duplicate every desk at two scopes, and put
identically-labelled surfaces ("Sales", "Starts") at two scopes showing different
totals — the fastest way to make people stop trusting the numbers. A lens gets
the assigned user the same result with the scope visible in the header.

Consequently the community workbench does **not** rebuild desks as tabs. It is
**Inventory · Offering · Land · Settings** — four tabs, four owners. There is no
community Sales tab and no community Starts tab: `/sales` and `/starts` with the
lens on are those views. What the community *does* carry is the read of them —
the buyer on a lot, the urgency strip — because of test 3 above.

---

## Roles

### 1. New Home Sales Consultant — *the primary Sales user*

A W-2 employee of the builder, usually one per community, sitting the model home.
Not an outside realtor: co-op brokers bring buyers and take a fee, but they never
touch Arc.

**Lives on:** `/sales`

**Daily loop**

1. Open Sales. The board opens on what is due, sorted by urgency — not on a report.
2. Work the attention chips: follow-ups due → holds expiring → out for signature
   → closings this week → new inquiries. Each chip filters the list beneath it.
3. Log walk-ins and web inquiries as they arrive (**New inquiry**, which captures
   the community).
4. With a buyer in the model, open **Find a home** to browse what is actually
   sellable right now — available lots and standing specs, with price and move-in.
5. Open a buyer's deal for the whole file: stage track, history, price breakdown,
   deposit, documents, and one stage-gated primary action.

**Mutates:** prospects (create, qualify, set follow-ups). Holds and agreements are
started here but executed on the community desk.

**Reads:** inventory, pricing, closing status, construction progress for their
sold buyers.

**What makes this role different from residential sales:** the consultant is not
scoping a project — the plan, price, and lot already exist. Their job is matching
a buyer to an inventory unit, then shepherding that buyer for 4–10 months to
settlement. Most of their book is *already sold* people. That is why the deal
board carries stages 4–7 in the same list as new leads: cancellations happen in
the long middle, and a board that only showed top-of-funnel would hide two thirds
of the job.

**Rhythm that matters:** they work weekends. Saturday is peak traffic; Monday is
follow-up and paperwork day.

---

### 2. Sales Manager / VP of Sales

One person; at the small end, the owner. Owns pricing and incentives, and answers
"how are we doing" across communities.

**Lives on:** `/reports`, `/communities/[id]/offering`

**Weekly loop**

1. Monday: review last week's traffic, appointments, sales, cancellations.
2. Adjust pricing and incentives per community on the community Offering tab —
   the only place a community price sheet or incentive is edited.
3. Watch backlog units and value, cancellation rate, incentive % of price, and
   average days from agreement to close on Reports.
4. Drop into an individual consultant's deals when a community is soft.

**Mutates:** price sheets, incentives, asking-price overrides.

**Reads:** the backlog report, closing calendar, spec aging.

> The consultant's board and the manager's rollups are deliberately separate
> surfaces. Backlog is an executive report and lives on Reports; it is not a tab
> on the consultant's work queue.

---

### 3. Online Sales Counselor (OSC)

Only exists above roughly 50 closings a year. Handles inbound web leads, qualifies
them, and books model-home appointments for the consultants.

**Lives on:** `/sales`, filtered to new inquiries.

**Mutates:** prospects — creates, qualifies, sets the follow-up, assigns the owner.

Below that size, the community consultant does this themselves and no separate
role is configured.

---

### 4. Contract / Closing Coordinator

Processes agreements and addenda, then drives the file from contract to
settlement: lender, title, appraisal, walkthrough, final documents.

**Lives on:** `/sales?due=closing_soon` for the queue, `/projects/[id]/closing` for
the work.

**Daily loop**

1. Filter Sales to closings this week to see every settlement in flight at once.
2. Open each home's closing file to work the gated checklist.
3. Mark cleared to close, then settle.

**Mutates:** closings, closing checklist items, settlement.

**Reads:** the deal board as a cross-home queue.

> Before this redesign, someone chasing eight settlements had to visit eight
> project pages. The closing-this-week filter is that desk.

---

### 5. Design Studio Coordinator

Runs the buyer's selections appointments and holds the cutoff dates that keep
construction from stalling.

**Lives on:** `/design-studio` (Catalog · Packages · Groups & cutoffs · Appointments)

**Mutates:** option catalog, packages, selection groups and cutoffs, appointments.

**Reads:** which homes are under contract and approaching their cutoff.

> Selection appointments are **owned here**. The Sales deal surfaces "selections
> due" as a next action and links across — it must never schedule or edit one.

---

### 6. Starts / Purchasing Manager

Turns a signed agreement into a released house, and keeps the release cadence even
so trades are not feast-or-famine.

**Lives on:** `/starts` (release board), `/starts/pipeline`, `/starts/trades`,
`/purchasing`

**Loop**

1. Review start-package candidates — homes with an executed agreement and a lot.
2. Clear the start gates (permits, plans, budget, selections locked).
3. Release to the field on the even-flow cadence.
4. Issue POs and manage vendor pricing.

**Mutates:** start packages, gate definitions, purchase orders.

**Reads:** backlog and the sales pipeline as the input to the release schedule.

---

### 7. Superintendent / Field Manager

Runs 8–15 houses at a time.

**Lives on:** `/` (Home — the field band leads the page for anyone carrying
houses), then `/projects/[id]` for a specific home.

**Daily loop**

1. Open Home. The field band leads: this week's scheduled work grouped by
   activity across every assigned house ("Frame inspection · 6"), because the
   job is one activity across many lots, not one house at a time. The band
   header carries house count, late items, and missing daily logs; the window
   toggles Today / This week / 2 weeks.
2. Complete scheduled items in place, without leaving the page.
3. Drop into a house for daily logs, photos, inspections, punch.

The per-house roster (phase, days versus target, percent complete, open punch,
last log) belongs on **Homes** filtered to the viewer — not duplicated here.

**Mutates:** schedule items, daily logs, photos, punch items, inspections.

**Reads:** selections and their cutoffs, closing dates.

---

### 8. Warranty Manager

Post-close service.

**Lives on:** `/warranty`

**Mutates:** warranty requests, visits, technician dispatch, backcharges.

**Reads:** closed homes, defect analysis, cost summaries.

---

### 9. Land / Development Manager

Feeds the machine: acquires and develops lots so there is inventory to sell.

**Lives on:** `/communities` (the board), `/communities/[id]/land` — the runway,
phases, and takedowns. Cross-community land supply is a Reports section, not a
Communities view.

**Mutates:** communities, phases, lots, takedowns.

**Reads:** absorption — how fast lots are selling versus how fast they deliver.

---

### 10. Controller / Bookkeeper

**Lives on:** `/billing`, `/payables`, `/projects/[id]/financials`, `/reports`

**Mutates:** invoices, draws, payables, QBO sync.

**Reads:** WIP over/under, community P&L, backlog value.

---

### 11. Owner / President

**Lives on:** `/` and `/reports`

Watches backlog units and value, closings by month, cycle time, even-flow
adherence, cancellation rate, and community P&L. Does not have a workbench —
every number deep-links to the desk that owns it.

---

## Cross-role handoffs

The moments where a record changes hands. Each one is a demo beat.

| Handoff | Trigger | From → To |
| --- | --- | --- |
| Inquiry → buyer | Hold placed on a lot | Consultant → Consultant |
| Buyer → sold | Purchase agreement executed | Consultant → Coordinator |
| Sold → released | Start gates cleared | Starts → Superintendent |
| Sold → selections | Contract active, cutoff approaching | Coordinator → Design Studio |
| Built → closed | Cleared to close, settled | Superintendent → Coordinator |
| Closed → serviced | Settlement recorded | Coordinator → Warranty |

The purchase-agreement execution is the busiest: it flips the contract to active,
converts the reservation, marks the prospect won, locks selections, and creates a
projected closing — all in one callback.

---

## Demo readiness

Honest gaps, most blocking first.

1. **There is no production demo data.** The `Acme Production` org has 0 prospects,
   0 reservations, 0 purchase agreements, 0 closings. Every production surface is
   an empty state today. A demo needs a seeded community with lots, plans with
   elevations and pricing, buyers spread across all seven deal stages, several
   weeks of `community_traffic`, and a `target_absorption_per_month` on each
   community — without the last two the community board shows pace but cannot
   show pace *against* anything.

2. **Holds must be placed from the community desk.** `Find a home` shows what is
   sellable and links to the community Sales tab to place the hold. Wiring the
   hold flow directly into the picker would tighten the core demo moment
   ("buyer standing in the model home").

4. **No role presets.** Permissions exist (`sales.read`, `sales.manage`,
   `start.write`, `warranty.manage`, …) but there is no one-click "New Home Sales
   Consultant" role. For a demo, log in as an admin or pre-build the roles.

5. **Division scoping is untested at scale.** Multi-division exists in the schema
   and in `getDivisionAccessForUser`, but a local production builder usually has
   one division. Demo single-division unless asked.
