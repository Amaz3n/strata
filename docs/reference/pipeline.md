# Pipeline

How a residential or commercial builder gets from "someone asked us to build
something" to a signed job. Production builders sell lots from the Sales desk
instead; `/pipeline` redirects them there.

## The idea

Precon is one thing: getting to a signed price. At every moment a deal waits on
exactly one party — **you**, **a trade**, or **the client** — and the screen is
organised around that, not around stages, tabs or documents.

- **One screen.** `/pipeline` lists every deal on the left, grouped by whose move
  it is, oldest wait first, aged in colour. The open deal fills the right. The app
  sidebar never changes; there is no deal sidebar.
- **One sentence, one button.** The deal header says where it stands ("2 lines need
  a price, 1 waiting on trades") and offers exactly one next action. Every other
  action is contextual (on a line, in the More menu).
- **Stage is derived, never set.** Nobody picks "contacted" or "qualified". The
  only manual moves are *Mark lost* and *Reopen*.

`dealMove()` in `lib/precon/deal-move.ts` is the whole judgment: ball, stop,
sentence, action, label and the firmness of the price, from the worksheet, quote
requests, the current documents and open client questions. It is pure and tested
(`tests/precon-deal-move.test.js`). The list (`listPipelineDeals()`) and the deal
page (`getDealWorkbench()`, both in `lib/services/precon-deals.ts`) feed it the
same inputs, so the list can never disagree with the page. Never compute a deal's
next step anywhere else.

## Routes

| Route | What it is |
|---|---|
| `/pipeline` | The list, and an empty right pane |
| `/pipeline/[dealId]` | The deal: header, the work, the client's document |
| `/pipeline/[dealId]/plans` | Drawings and takeoff, opened over the deal |
| `/pipeline/[dealId]/files` | Files, opened over the deal |
| `/pipeline/[dealId]/quotes/[packageId]` | The full bid package workbench, for tenders |
| `/pipeline/prospects/[id]/**` | Redirects only — old links and emails |

Plans, files and quote packages are takeovers: the list hides and a
`DealTakeoverBar` leads back. They exist only once pricing has started; viewing
them never creates the pricing project.

## The work

A deal starts from one field — a name. Before pricing it is notes: *What are they
building?*, one idea per line. **Start pricing** creates the pricing project and
turns each line into a worksheet row.

Each line is priced one of three ways: **your number**, an **allowance**, or a
**trade's quote** (requested from the line; quotes land back on it). Measuring a
line from plans makes your number firm. Firmness is weighted by cost:

- firm = a selected quote or a measured quantity
- allowance = a held number
- guess = your own unmeasured number

The worksheet is the only place a price is edited. It autosaves into
`precon_workspaces.brief.pricing_worksheet` under the workspace's optimistic
version, with browser recovery and conflict review (`use-pricing-worksheet.ts`).

## One document that hardens

The client sees one document. While the price is soft it goes out as a
**Budget** — a range, approval only. Once at least `SIGNATURE_FIRMNESS` (75%) of
cost is firm and every client question is answered, the same button sends the
**Proposal & agreement** for signature. Nobody picks which.

- Both are `estimates` rows (`metadata.precon.purpose` `budget` or
  `construction_agreement`) prepared by `prepareDealDocument()` as a snapshot of
  the worksheet. A changed worksheet makes the next send a new version.
- A budget's range is stored at `metadata.pricing_worksheet.range` and rendered by
  the portal, the live preview and the PDF (`estimatePriceRange()`).
- Agreement terms default from `DEFAULT_PAYMENT_TERMS` / `DEFAULT_ALLOWANCE_POLICY`
  in `lib/services/precon-pricing.ts`; the pricing basis is written from the quotes,
  measurements and plans the price rests on.
- The right pane renders the document live from the lines (`DealDocumentPane`),
  so what you price is what the client will read.

## Questions for the client

Open questions are `precon_decisions` rows of kind `client_decision` that block
the agreement. They print in the client's document and the client answers them
on the review link (`answerEstimateQuestion()`); the builder can also record an
answer. An open question holds the price at budget.

## Signing is the handoff

After the client signs, the button is **Countersign**, then **Start building**.
`startBuilding()` activates the project through `start_prospect_project` (contract,
contacts, records) and drafts the job budget from the cost side of the signed
lines — allowances tagged, contingency reserved when the price carries one. There
is no separate handoff step.

The formal-handoff tables and RPCs (`project_precon_handoffs`,
`convert_executed_prospect_handoff`, `transition_precon_handoff`) are no longer
called by the app and are candidates for a gated cleanup migration.

## Verification

```bash
pnpm test:precon
```
