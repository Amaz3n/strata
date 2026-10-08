# Books: legal entities

**Decision (2026-10-07, owner):** a legal entity is a **segment of the one Books
ledger**, not a second ledger. Every journal line names the legal entity that owns
it; trial balance, statements and the close run per entity; consolidation adds
entities together and eliminates what they owe and sold each other.

**Status (B14).** Built and verified locally: the owning company on every journal
line, resolved in the one posting function; intercompany legs that settle what two
companies already owe each other first; ownership fixed once posted; per-company
trial balance, P&L, balance sheet, AR/AP aging, 1099s (by paying company) and
sales/use tax (Reports → Company); consolidated statements with eliminations;
intercompany lot sales; the intercompany reconciliation and its close control; a
close that saves each company's statements; one opening batch per company;
Books → Companies; companies in the export (schema 33), with an archive round trip
proven. Not built: independent per-company close, minority interests.

A separate per-entity ledger (`books_native_*`, per-entity charts and calendars)
was built in October 2026 but never shipped. It is retired: every transaction type
already posts, ties out and closes on the main ledger, and a second engine would
have to repeat all of it.

## Model

- **Legal entity** (`books_legal_entities`): a company the organization keeps
  books for — a land company, a building company. Organization-scoped; never a
  security boundary on its own (division scope remains the enforcement layer).
  Every organization has exactly one **primary** entity, created with Books, so a
  single-company builder never sees the concept.
- **Shared chart and calendar.** Entities in one organization share the chart of
  accounts and the fiscal calendar. Affiliated companies with different charts or
  year-ends are out of scope for the first release.
- **Ownership on the line.** `journal_lines.legal_entity_id` is required. An entry
  balances **per entity** (debits = credits within each entity), so an entry that
  touches two entities carries explicit intercompany legs.

## Who owns a posting

Resolved once, at posting, by one function — never inline:

1. A line on an account a company owns (its bank, cash or card account, or its
   land account) belongs to that company, even when the line names a job.
2. A line on a **project** belongs to the project's owning entity
   (`projects.legal_entity_id`, default the primary entity).
3. Any other line takes the entity chosen on the document (an opening batch names
   its company), else the primary entity.

Changing a project's owner after it has posted is a governed correction, never a
silent rewrite of posted lines.

## Intercompany

When one entry's lines resolve to different entities (entity A's bank pays a bill
for entity B's project), posting adds the pair that makes each entity balance:

```
Entity B   Dr 5000 Job cost                  X    Cr 2180 Due to affiliates (A)   X
Entity A   Dr 1180 Due from affiliates (B)   X    Cr 1000 Cash                    X
```

Each intercompany line names its owner and counterparty. When one company owes
another, posting first settles what the other already owes it (a voided payment
unwinds the balance rather than adding the opposite one), so two companies never
carry a receivable and a payable with each other at once; A's due-from-B always
equals B's due-to-A.

## Intercompany lot sales

A land company sells a lot to an affiliate's home from the home's inventory tab
(`sell_books_lot_to_affiliate`). The seller is the company holding the lot's land
basis; it books revenue at the price and relieves the lot's cost (both lines tagged
`intercompany_eliminate`). The home takes the lot in at the price, and posting adds
the due-from / due-to legs. The sale replaces the ordinary land-to-start transfer
(same posting key) and is kept in `books_intercompany_sales`.

## Consolidation

Consolidated statements sum the companies and remove the due-from / due-to legs and
the lines tagged `intercompany_eliminate`. From the sales register they add computed
eliminations: the seller's profit stays out of the home's inventory (moving with it
from construction to completed homes) until the home sells to an outside buyer,
when it comes out of cost of sales. So the group earns exactly what the companies
earned together, and the lot is carried at the land company's cost. Eliminations
are never posted to a company's books. Consolidation assumes wholly owned
affiliates; minority interests are out of scope.

## Reconciliation

Books → Companies shows what each pair of companies owes the other, read from both
sides, and the lots sold between them. The close's blocking intercompany control
requires every company's due-from to equal its affiliate's due-to; posting writes
both legs in one atomic entry, so a one-sided posting cannot occur.

## Opening balances

Each company brings its own opening position as its own batch (the opening wizard
asks which company when there is more than one). Lines on a job or an owned account
still belong to that job's or account's company, so a batch whose lines resolve to
more than one company is refused rather than inventing intercompany balances at
cutover.

## Tax reports

1099s are filed by the company that paid: the owner of the cash line on the posted
payment, reversal or expense (unposted payments count for the primary company).
Sales and use tax belong to the company whose job the invoice or bill is on.

## Close

Companies in one organization close a month together (a deliberate first-release
scope: affiliated builder companies share one bookkeeper and calendar). The close
saves the consolidated statements and, when there is more than one company, each
company's trial balance, P&L, balance sheet, cash flow and AR/AP aging, so a closed
month reads as it was closed for every company. Independent per-company close and
reopen are not built.
