# Books dimensions

Which reporting dimensions each kind of Arc Books posting carries, which are
required, and the rules that keep them true. Read before changing
`lib/services/books/dimensions.ts`, the `dimensions` built in
`lib/services/books/fact-drafts.ts` (`draftFromFact`) or `posting-rules.ts`, or
any trigger on `journal_lines`. Proven by the DIM-01 golden scenario.

## Where a line's dimensions come from

A journal line has two dimension columns, `project_id` and `company_id`, and a
`dimensions` object. `draftFromFact` merges, in order:

1. **Project tags**, captured into the fact when it posts
   (`loadBooksProjectDimensions`): `organization_id` always; `division_id` /
   `division_name` when the project has a division; `lot_id`, `lot_name`,
   `community_id`, `community_name` when the project is on a lot (a project sits
   on at most one, `lots_project_unique`); `contract_id` when the project has
   exactly one contract. Every line with a project gets its project's tags.
2. **Document dimensions** (`payload.dimensions`, labor) on every line.
3. **Line dimensions** from the posting rule (cost lines, revenue lines).
4. **Settlement dimensions** on every line of a payment: the payment and the
   document it settles.
5. **Labor basis** on every line of a labor posting.

The database adds `books_account_classification` to every posted line (the
account's classification at posting). It is evidence beside the posting.

## Matrix

R = always present, O = when the source has it, — = never. "Project tags" means
the set in step 1, each O as described there.

| Document | `project_id` | `company_id` | Inside `dimensions` |
|---|---|---|---|
| Vendor bill | O (per cost line) | O (vendor) | Project tags on every line; cost lines add `cost_type` (R) and `cost_code_id` (O) |
| Expense | O | O (vendor) | As a vendor bill |
| Invoice | O | — | Project tags; on closing or on-invoice basis, revenue lines add `cost_code_id` (O) |
| Credit memo (receivable adjustment) | O | — | Project tags; revenue lines as the invoice |
| Retainage release | O | — | Project tags. The vendor is on the release bill, not on its lines |
| Invoice payment, bill payment | O | — | Project tags; `payment_id` (R) and `invoice_id` or `bill_id` (R); an allocated payment adds `payment_allocation_id` and posts each allocation to its own project |
| Customer deposit receipt, application, reversal | O | — | Project tags; `payment_id` and `invoice_id` (R) |
| Payment reversal | O | — | Project tags; `payment_id` and `invoice_id` or `bill_id` (R) |
| AP fee charge | — | — | None |
| Labor | R | — | Project tags; `cost_type` "labor" (R), `cost_code_id` (O); with labor evidence `labor_job_cost_id`, `labor_time_entry_id`, `labor_worker_id`, `labor_basis_hash` |
| Revenue recognition | R | — | `wip_snapshot_id`, `wip_inputs_hash`, `wip_as_of` (R); revenue lines add `contract_id` and `cost_code_id` (O). Project tags are not added |
| Adjusting journal | set by the author | set by the author | None from the app (the action accepts no dimensions); services may set them |
| Deposit batch | — | — | None |

Several contracts on one project leave `contract_id` off its lines until
contract-level ownership (B04.1) assigns each document its contract.

## Rules

- **Only the company's own records.** A line naming another company's project,
  company, account or entry is refused (`journal_lines_validate_scope`). Since
  October 6 the ids inside `dimensions` are checked too: `cost_code_id`,
  `contract_id`, `lot_id`, `community_id`, `division_id`, `invoice_id`,
  `bill_id`, `payment_id` must name a record in the line's company, and
  `organization_id` must be the line's company
  (`books_validate_line_dimension_scope`). The refusal names the dimension and
  asks for the source document to be corrected; a projected source records it as
  a finding with that cure. A key present with a null value means none.
- **Never ambiguous.** A tag is set only when the relationship is single: one lot
  per project by constraint, a contract only when the project has one.
- **Entity ownership.** A project with a reviewed legal-entity owner refuses
  legacy facts, entries and lines; its documents post through the entity ledger.
- **Tags stay as posted.** Later changes to a project's division, community or
  lot, or to a community's or account's name, relabel nothing already posted. A
  new document, or a real revision of an old one, posts with today's tags (see
  `books-posting.md`).
- **Reversals inherit.** A reversal line copies its original line's dimensions
  exactly and must match its account, project, company and amounts
  (`books_capture_account_classification`, `books_complete_reversal`), so a
  historical entry can always be reversed as it was posted.
- **Reviewed ownership is append-only.** Legacy and project entity ownership
  proposals and reviews (`books_legacy_entity_*`, `books_project_entity_*`)
  cannot be changed or deleted; a review never relabels posted lines.
