# Books: legal entities

**Decision (2026-10-07, owner):** a legal entity is a **segment of the one Books
ledger**, not a second ledger. Every journal line names the legal entity that owns
it; trial balance, statements and the close run per entity; consolidation adds
entities together and eliminates what they owe and sold each other.

**Status (B14, in progress).** Built: the owning company on every journal line,
resolution in the one posting function, intercompany legs that settle what two
companies already owe each other before adding new balances, ownership fixed once
posted, per-company trial balance / P&L / balance sheet (Reports → Company),
consolidated statements that eliminate due-from/due-to, Books → Companies, and
companies in the export (schema 33; older archives restore as one primary company).
Not yet: per-company close and subledgers (AR/AP aging by company), the
intercompany reconciliation, and eliminating intercompany sales (e.g. a land
company selling a lot to the building company).

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

1. A line on a **project** belongs to the project's owning entity
   (`projects.legal_entity_id`, default the primary entity).
2. A **cash** line belongs to the entity that owns the bank or GL cash account.
3. A company-level line with neither (overhead, a manual journal) takes the entity
   chosen on the document, else the primary entity.

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

## Consolidation

Consolidated statements sum the entities and eliminate, from lines tagged as
intercompany: due-from against due-to, and intercompany revenue against the
matching cost. Eliminations are computed, never posted to an entity's books.

## Close

The close runs per entity for the shared period: closing or reopening one entity's
month does not freeze or unfreeze another's. Controls (job cost, AR, AP, deposits,
inventory, warranty, impairment) tie per entity.
