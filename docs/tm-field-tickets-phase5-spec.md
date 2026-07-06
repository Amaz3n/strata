# T&M Field Tickets — Phase 5 Spec

## Purpose

Time-and-materials projects need an owner-facing daily ticket packet before invoice generation. The ticket proves what was performed, who signed it, and which approved costs can flow into the invoice. It is not a replacement for the Review queue; it sits between approved open costs and approved-cost invoicing.

## Scope

- Applies only to projects whose resolved billing model is `time_and_materials`.
- Groups open billable ledger rows for a single project/work date.
- Supported item sources: `time_entry`, `project_expense`, and `project_expense_line`.
- Excludes vendor bill lines in Phase 5 because they are usually back-office backup rather than same-day field-ticket material.
- Signed tickets generate invoices through the existing approved-cost invoice flow.

## Data Model

`tm_tickets`
- `org_id`, `project_id`, optional `contract_id`.
- `ticket_number`, unique per project while not voided.
- `work_date`, `status`: `draft`, `submitted`, `client_signed`, `billed`, `voided`.
- Client signature fields: signer name/email/IP, signed timestamp, signature JSON payload.
- One-time signature token hash with expiration.
- Optional `invoice_id` once billed.
- Audit metadata and normal created/updated user fields.

`tm_ticket_items`
- One row per ticketed billable cost.
- Copies source type/id, billable cost id, date, description, quantity, cost, billable amount, cost code snapshot metadata.
- Keeps ticket contents stable even if the underlying billable ledger row later changes.

## Rate and Ledger Rules

- T&M time entry billable value is resolved when ledger rows are written:
  1. Project override person rate.
  2. Project override labor-role rate.
  3. Schedule person rate.
  4. Schedule labor-role rate.
  5. Membership `labor_bill_rate_cents` fallback.
- `cost_cents` remains loaded job cost.
- `billable_cents` equals billable quantity times bill rate times OT/DT multiplier.
- `markup_cents` is derived as `billable_cents - cost_cents` so invoice totals still reconcile with existing approved-cost invoice code.
- T&M material/expense rows keep markup behavior, but may use schedule or project override material markup by cost code/category/default.
- Invoice-time markup refresh must preserve T&M rate snapshots and not downgrade time rows back to cost-plus percentage markup.

## Workflow

1. PM/accounting reviews and approves time/expenses in Financials Review.
2. User opens `Financials > T&M Tickets`.
3. User selects a work date; eligible open costs for that date are shown.
4. User creates a draft ticket with selected costs or all eligible costs for the date.
5. Ticket is submitted or sent for signature. Sending creates a single-use public `/t/[token]` link.
6. Client reviews itemized ticket and signs with typed approval.
7. Ticket status becomes `client_signed`, token is cleared, audit/event records are written.
8. User clicks invoice from the signed ticket. The existing `generateInvoiceFromCosts` path creates an invoice for the ticket's billable cost ids and links invoice metadata back to the ticket.
9. Ticket status becomes `billed`. Billed tickets cannot be voided.

## Permissions and Security

- Internal ticket reads require `invoice.read` for the project.
- Create/submit/signature-link/invoice/void require `invoice.write` for the project.
- Rate schedule management requires org admin.
- Project schedule assignment goes through amendment-aware contract saving and requires project management permission.
- Public signing uses service-role lookup by token hash only, validates expiration/status, clears the token on success, and records signer IP/user agent in signature metadata.
- All tables have RLS enabled and org-member policies plus explicit authenticated/service-role grants.

## UI Surfaces

- `/settings/billing-rates`: create/archive schedules, create schedule rates, assign schedules to T&M projects, create/delete project overrides.
- Project financial setup: T&M contract terms can hold `rate_schedule_id`.
- `Financials > T&M Tickets`: create tickets from open costs, submit, copy signature link, generate invoice, void.
- `/t/[token]`: public ticket review and client signature.

## Non-Goals

- PDF ticket packet generation.
- Multi-day tickets.
- Vendor bill line ticketing.
- Offline/mobile capture.
- Draw/AIA export support.

## Acceptance

- T&M time entries create billable ledger rows from bill rates, not cost-plus markup.
- OT and DT are mutually exclusive and both affect loaded cost and billable amount.
- Material/expense markup can come from T&M rate schedules or project overrides.
- Ticket items are stable snapshots and signed tickets invoice exactly their included billable cost ids.
- Voiding a ticket clears display metadata from open billable costs when the ticket owns that metadata.
- `pnpm lint` passes.
- Phase 5 migration is applied to Supabase via MCP and verified by table/column inspection.
