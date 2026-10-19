# Pipeline

How a residential or commercial builder gets from "someone asked us to build
something" to a signed job. Production builders sell lots from the Sales desk
instead; `/pipeline` redirects them there.

## The idea

Precon is one thing: getting to a signed price. At every moment a deal waits on
exactly one party — **you**, **a trade**, or **the client** — and the screen is
organised around that, not around stages, tabs or documents.

- **Two views.** `/pipeline` is the overview: a funnel counting the four open
  stops (`DEAL_STOPS` up to Signed) with the money in each — the funnel is the
  process, never outcomes — attention chips for what needs someone
  (your move, waiting on trades, waiting on clients, stalled for 14 days,
  follow-ups due) and one paged table. A row carries the deal and client,
  its stage as a badge, its last activity (days ago over the date: an edit, the
  worksheet, or the client on a sent document), firmness, owner and value. Firmness is a level meter of
  twenty cells — red, amber, then green from `FIRM_PRICE_SHARE` — lit to the
  firm share of cost; the owner is an avatar badge;
  the value carries a caption saying what it rests on. Your moves sort first,
  oldest wait first. Opening a row goes to the deal room.
- **The deal room is one header over tabs.** The header never moves: name, stage
  badge and the ⋯ menu (edit, mark lost or reopen); the client (linked to the
  directory), site, phone and a reassignable owner; a facts strip (value,
  firmness meter, last activity, the client's budget, timeframe with the
  follow-up); and the next-move band. Below it the tabs are routes —
  Overview, Pricing, Bids, Proposal, Plans, Files — under the overview's width.
- **Won and lost both leave the list.** The pipeline is work still to do, so a
  deal leaves when Start building runs, just as a lost one does. Building is
  the deal page's final stop, never an overview stage: its count would be an
  arbitrary window and its money is booked, not prospective. Won deals (the last 90 days) sit
  behind the **Won** filter, each opening its project; lost ones behind **Lost**.
- **New deal is the first phone call.** Only the name is required. The client
  is picked from the directory (`searchDirectoryPeople`) so a person is never
  typed in twice; someone new is described on a second pane of the same dialog
  and comes back as the deal's client, and the deal promotes them into the
  directory when it is created, so cancelling leaves nothing behind. Notes are
  free text. Budget is a band or an exact amount; timeframe a band or a start
  date; "Other" as a source asks where.
- **Value sharpens as the deal moves.** `dealValue()` reads the client's stated
  budget band (`prospects.budget_range`, normalised by `budgetBand()` whatever
  form it was stored in), then what is priced so far, then the range an estimate
  shows, then a price with its basis (agreement, firm costs, proposal). A range
  counts at its midpoint in the funnel's totals; a stated band counts as nothing.
- **One sentence, one button.** The next-move band says where it stands ("2 lines need
  a price, 1 waiting on trades") and offers exactly one next action, on whichever tab is open — a
  move that belongs to a line goes to Pricing with that line open. Every other
  action is contextual (on a line, in the ⋯ menu).
- **Stage is derived, never set.** Nobody picks "contacted" or "qualified". The
  only manual moves are *Mark lost* and *Reopen*.

`dealMove()` in `lib/precon/deal-move.ts` is the whole judgment: ball, stop,
sentence, action, label and the firmness of the price, from the worksheet, quote
requests, the current documents and open client questions. It is pure and tested
(`tests/precon-deal-move.test.js`). The list (`listPipelineDeals()`) and the deal
room (`getDealRoom()`, both in `lib/services/precon-deals.ts`) feed it the
same inputs, so the list can never disagree with the room. The room's layout
loads the header once and holds the worksheet state in `DealRoom`
(`components/pipeline/deal-room.tsx`), so the header's move follows an edit on
Pricing before it saves. Never compute a deal's next step anywhere else.

## Routes

| Route | What it is |
|---|---|
| `/pipeline` | The overview: funnel, attention chips, the table of deals |
| `/pipeline/[dealId]` | Overview: log a call or note, the timeline; details, notes and client questions beside it |
| `/pipeline/[dealId]/pricing` | The line list and its rail (price summary or the open line); `?row=` opens a line |
| `/pipeline/[dealId]/bids` | The trade list, and one trade's Scope, Bidders, Leveling and Questions; `?trade=` selects it, `?bid=` opens a proposal |
| `/pipeline/[dealId]/bids/[packageId]` | One request's full bid package workbench, in the tab |
| `/pipeline/[dealId]/quotes/*` | Redirects to `bids` (links already sent in emails) |
| `/pipeline/[dealId]/proposal` | The proposal's sections beside the live document, the versions sent; `?send=1` opens Review & send |
| `/pipeline/[dealId]/plans` | The plan room: the set, what the latest issue changed, every sheet; `?sourceFile=` offers a PDF from Files as the plans |
| `/pipeline/[dealId]/files` | The deal's files (`DealFiles`); `?path=` opens a folder. The header reads Pipeline › deal › Files › folders and nothing links to the pricing project |
| `/pipeline/prospects/[id]/**` | Redirects only — old links and emails |

`app/(app)/pipeline/[dealId]/layout.tsx` renders the header and tabs. Plans and files live in the pricing
project, so before the price starts those tabs offer to start it; viewing them
never creates the project.

**Switching tabs never reloads.** The layout starts every tab's data
(`loadDealTabs()`) beside the header's and hands the promises to the room; each
tab page is a Suspense boundary around a reader that `use()`s its promise
(`components/pipeline/deal-tab-data.tsx`). The layout stays mounted across tab
changes, so a tab opens on data already loading or loaded, and going back reads
the same resolved promise. Only what a URL adds is read by the page itself: a
deep-linked folder (`?path=`) and a file offered as the plans (`?sourceFile=`).
An action that calls `revalidatePath`, or `router.refresh()`, re-renders the
layout and starts a fresh set inside that transition, so the old tabs hold until
the new data lands. The pricing and proposal autosaves deliberately do **not**
revalidate — the room holds the live worksheet and proposal, and reloading
every tab on each keystroke save is what made the tabs reload.

## Plans and measuring

The Plans tab is a plan room, not a register (`DealPlans`, loaded by
`getDealPlans()`): the set bar (who issued it, its revision, sheet count, Upload
a revision), a band when the latest issue changed sheets that carry measured
lines, and the sheets by discipline,
each saying how many lines were measured on it. A sheet opens the full-screen
`DrawingViewer` **over the deal** — never inside the tab, and only to read:
it offers no measuring tools — hosted once for the
whole room by `useDealDrawings()` (`components/pipeline/deal-drawings.tsx`), so
Pricing and Plans open the same viewer.

**Measuring always measures into a pricing line.** Takeoff starts from Pricing:
Measure on a line calls `beginWorksheetMeasurement()`, which links the line
to its takeoff item, and opens the viewer in **line mode**: the item is armed,
tools that measure the wrong way are refused, and the panel is `LineLedger` —
the live quantity with its waste or wall height, the rate, the line total
against the guess, the sheets it was measured on. **Done**
(`applyLineMeasurement()`) puts the quantity and rate on the line in one step;
there is no separate send. A quoted line keeps the trade's price and takes the
measurement as evidence. Cancelling leaves the geometry and the line as they were.

**New plans never move a price on their own.** A revision carries measurements
onto the new sheets for review, and until a person confirms them the line is
*under review*, not changed (`planChanges()`, `lib/precon/plan-changes.ts`,
pure). The next move says so first ("Review measurements"); once confirmed,
lines whose measurement now reads differently are listed with the money each
moves, and the builder picks **Use new** or **Keep** per line
(`resolvePlanChanges()`; a kept line records `kept_quantity` and stays quiet
until the plans move again).

## The work

A deal starts from a name and whatever the first call gave. Notes are only
notes; nothing is read out of them. **Start the price** (`startDealPrice()`)
creates the pricing project and seeds the worksheet from one of four places:

- **a template** — an estimate template's lines, its groups as sections
- **the plans** — an empty sheet, then the Plans tab to measure lines in
- **a past deal** — its lines and your numbers, never its quotes or measurements
  (`listDealPriceSources()` lists recent priced deals the member can read)
- **blank** — the first line, typed

Each line is priced one of three ways: **your number**, an **allowance**, or
**bids** (`basis: "quote"`). Measuring a line from plans makes your number firm.
Firmness is weighted by cost:

- firm = a picked bid or a measured quantity
- allowance = a held number
- guess = your own unmeasured number, including the number a line marked for
  bids holds until its bid lands (`rowPricing()` reads it as an estimate)

**Pricing marks, Bids requests.** Choosing Bids on a line only marks it. A
marked line with no live request is `to_bid` (`linesToBid()`). The Bids tab
(`components/pipeline/deal-bids.tsx`) is a trade list beside one trade's
workspace. `bidTrades()` (`lib/precon/deal-bids.ts`, pure, tested) builds the
list: every request, plus marked lines grouped by cost code into draft trades
(lines with no cost code wait under "Not grouped" until given one). A trade's
status (choose, late, draft, out, chosen) comes from `requestStatus()`, and it
picks the view the trade opens on:

- **Scope**: the lines and their notes to bidders, alternates and unit prices,
  the drawing sheets picked one by one (`bid_package_sheets`), notes, other
  documents, an optional site walk, and the send card. `issuePricingRequest()` creates, details and invites in one
  step; changes after sending go out as an addendum.
- **Bidders**: everyone asked, with reminders, inviting more, and **Enter a
  bid** for one that came by email or phone, from an invited bidder or a
  directory company that wasn't asked (recorded as a lump sum).
- **Leveling**: scope lines × bidders. `levelBid()` fills every gap with your
  plug (your placeholder until you set one), counts alternates only when
  ticked and never adds unit prices. Exclusions show in the bidder's own words;
  outliers (`bidSpread()`) and bids about to expire are flagged. A proposal
  opens beside the grid; **Use this bid** prices the trade's lines back on
  Pricing through `selectPricingQuoteAction`.
- **Questions**: bidders' questions, each answered to every bidder.

Bidders see the picked sheets and the site walk on the bid portal, and download a
sheet through `/api/portal/b/[token]/sheets/[sheetId]`, which serves only
sheets linked to that request. Sheets and the site walk need
migration `20261022100000_bid_package_sheets_and_terms.sql`; until it is
applied `getDealBids()` reports `termsAvailable: false` and those controls are
hidden. The line's inspector only reports where its request stands and links
to Bids. The next move sends unrequested lines to **Request bids** once every
other line has a price.

The Pricing tab is a list and one rail (`components/precon/pricing-worksheet.tsx`).
The starting points show only until pricing has started. After that:

- **The list** (`pricing-line-list.tsx`) is grouped by section. Sections fold
  and carry a firmness bar and a subtotal.
- **Each line** carries a firmness mark, a caption saying what its price rests
  on, and its amount or the action it is waiting on.
- **Adding lines:** each section has a quick-add field. `parseQuickLine()` reads
  "Gutters 180 lf 12" or "Permits $2,400" and never invents a price. A pasted
  block adds one line per row.
- **The queue strip** above the list counts what needs a price, the lines to
  request bids for, the bids to pick and what is waiting on trades. **Work
  through** walks the lines that need a price; **Go to Bids** takes the rest.
- **The rail** is `PricingSummary` while no line is open: the receipt with
  margin, contingency and tax, the client's price and range, the preview, and
  how firm the price is.
- **An open line** shows `PricingLineInspector` in the rail instead: the three
  ways to price it, its measurement, where its bids stand and the rest behind
  *More*. ↑/↓ steps between lines and Esc closes.
- **An allowance's** "What it covers" is the line's notes, so it prints on the
  client's document.

The worksheet is the only place a price is edited. It autosaves into
`precon_workspaces.brief.pricing_worksheet` under the workspace's optimistic
version, with browser recovery and conflict review (`use-pricing-worksheet.ts`).

## One document, sent two ways

The client sees one document, the **Proposal**. The builder picks how its price
goes out on the Price section (`proposal.price_mode`): a **fixed price to sign**
(the default), or an **estimated range to approve**, which is not a contract and
leaves the payment schedule and signatures off. Firmness (`FIRM_PRICE_SHARE`,
75% of cost quoted or measured) is shown, never a gate.

- Both are `estimates` rows (`metadata.precon.purpose` `budget` for a range,
  `construction_agreement` for a fixed price, from `proposalKind()`) prepared by
  `prepareDealDocument()` as a snapshot of the worksheet. A changed worksheet
  makes the next send a new version.
- A range is stored at `metadata.pricing_worksheet.range` and rendered by
  the portal, the live preview and the PDF (`estimatePriceRange()`).
- The pricing basis is written from the quotes, measurements and plans the
  price rests on.

## The proposal

What the builder writes around the price is the deal's **proposal**:
`precon_workspaces.proposal` (`dealProposalSchema`), autosaved under its own
`proposal_version` so it never races the worksheet (`use-deal-proposal.ts`).
Only what the builder changed is stored; every other section falls back to the
org's defaults, so a fresh deal is already a complete document.

- `resolveProposalDocument()` (`lib/precon/proposal-documents.ts`, pure, tested)
  turns the proposal, the defaults and the priced lines into the
  `ProposalDocument` the client reads: cover letter, a scope paragraph per
  Pricing section (from line notes until edited), price, options, allowances,
  inclusions and exclusions, payment schedule, schedule, terms, signatures and
  questions. The deal room resolves it live (`proposal-model.ts`) and
  `prepareDealDocument()` resolves the same document at send, storing it at
  `estimates.metadata.proposal`, so the preview is the document. The portal, the
  live preview and the PDF (`lib/pdfs/quote-document.tsx`) all render from it.
- The Proposal tab lists the sections, each with its state from
  `proposalSectionStates()`: on its default, edited, or **needs you** (exclusions
  a chosen bid carried that nobody has ruled on, a payment schedule that does not
  add to 100%, a schedule section with no start window, a custom section with no
  text, an unanswered client comment), or **off**. The first section that needs
  you is the deal's next move (`dealMove()`'s `proposalNeeds`), before the send.
- **Sections are the builder's.** `proposal.layout` is the ordered list of
  sections, each on or off, under the standard heading or the builder's own,
  plus custom sections (`custom:<id>`, a heading and text). `normalizeProposalLayout()`
  keeps every built-in section exactly once and price, options, signatures and
  questions always on (options and questions print only when they have
  content). A section that is off empties its content in
  `resolveProposalDocument()`, so an off payment schedule creates no draws and
  is not checked for 100%. On a range, payments and signatures are left out.
- **Save as my default** writes one org setting per section (cover letter,
  terms, allowance wording, inclusions, exclusions, payment schedule, and the
  section layout as `proposal_sections`) through
  `save_organization_settings` section `proposal`. A letter is saved as a
  template: this deal's names are turned back into `{client}`, `{project}`,
  `{builder}` and `{sender}`.
- **Review & send** is a dialog over the proposal: the signing order (the deal's
  client first, up to three co-signers such as a spouse in
  `proposal.co_signers`, then the builder's countersignature), each name and
  email editable there, the message, and what changed since the last version
  sent (`proposalChanges()`, printed at the top of the client's document). A
  corrected client name or email is saved to the deal's primary contact by the
  send itself. It is the one place signers are edited; the Signatures section
  shows the order. Signers need distinct emails, because each link is keyed by one.

## The client's link

`/e/[token]` renders `DealProposalPortal` for any document with a proposal. The
link is the person's, not the version's: it opens the newest proposal
sent on the deal, and `?v=` reads an earlier one. The client ticks options and
watches the total move, asks about any section where it applies (the builder
answers on the Questions section, and the answer appears under the question),
and signs by typing their name with consent. With co-signers, each signs
on their own link (`estimate_review_links.signer_email`); the agreement is
client-signed when the last one signs, options lock once anyone has, and only
then does the builder countersign.

## Questions for the client

Open questions are `precon_decisions` rows of kind `client_decision`. They print
in the client's proposal and the client answers them on the review link
(`answerEstimateQuestion()`); the builder can also record an answer. An open
question never stops the builder sending; it stops the client signing — the Sign
button waits, and `submitEstimateDecision()` refuses a signature while any is
unanswered.

## Signing is the handoff

After the client signs, the button is **Countersign**, then **Start building**.
`startBuilding()` activates the project through `start_prospect_project` (contract,
contacts, records) and drafts the job budget from the cost side of the signed
lines — allowances tagged, contingency reserved when the price carries one — and
turns the signed payment schedule into the job's draws
(`createDrawsFromPaymentSchedule()`), the options the client picked billed with
the first. There is no separate handoff step.

The formal-handoff tables and RPCs (`project_precon_handoffs`,
`convert_executed_prospect_handoff`, `transition_precon_handoff`) are no longer
called by the app and are candidates for a gated cleanup migration.

## Verification

```bash
pnpm test:precon
```
