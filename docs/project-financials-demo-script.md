# Project Financials Demo Script

Use this script until the same flow is covered by browser E2E.

## Scenario

Run a single cost-plus GMP project from setup through payment and reconciliation.

## Steps

1. Create a project with billing model `cost_plus_gmp`, a GMP amount, markup/fee settings, and open-book enabled.
2. Complete the financial setup wizard and confirm the project has no blocking setup issues.
3. Submit one time entry, one project expense, and one vendor bill with at least one bill line.
4. PM-approve all three source costs; if client cost approval is enabled, owner-approve the required time/cost batch before invoicing.
5. Confirm each approved source creates both a job-cost entry and an eligible billable-cost ledger row.
6. Generate an owner approval batch for the period and send/share it.
7. Create an approved-cost period invoice from the approved billable costs.
8. Generate and share the owner backup package; confirm proof references and billed cost totals match the invoice.
9. Record owner payment against the invoice and verify AR balance/status updates.
10. Record vendor bill payment and verify AP balance/status updates.
11. Review Budget/WIP, GMP Control, project Trust Center, and Financial Control.
12. Confirm QBO exceptions are empty, or each pending/error item is visible without changing Arc's local AR/AP truth.

## Expected Evidence

- Fixed-price invoice-from-approved-costs is unavailable or blocked.
- Budget actuals include vendor bill, expense, and time costs exactly once.
- Closed or invoiced billing periods block in-place edits.
- Owner portal hides source cost detail when `open_book = false`.
- Trust Center reaches zero exceptions or shows actionable exception rows.
