# Cost-Plus Phase 1 Demo Checklist

Use this as the manual acceptance run until Playwright is configured in the repo.

## Setup

1. Create or pick a project with contract type `cost_plus`.
2. Set contract markup, GMP, labor burden, open-book, and client cost approval as desired.
3. Add at least one cost code with reimbursable enabled and optional default markup.
4. Add one allowance with `used_cents` greater than `budget_cents`.
5. Add one commitment and code one vendor bill line to a cost code.

## Run

1. Submit internal crew time from `/projects/[id]/time` with two or more crew lines and an attachment.
2. PM-approve the time entry. If client approval is required, copy the approval link and approve through the token route.
3. Submit an internal expense from `/projects/[id]/expenses` with a receipt/photo.
4. Approve the expense from the Review Queue at `/projects/[id]/cost-inbox`.
5. Approve the coded vendor bill from Review Queue or Payables.
6. Open Receivables at `/projects/[id]/financials/receivables` and create a new invoice.
7. Use the invoice sheet's source menu to link `Approved costs`.
8. Verify the preview includes:
   - Approved labor
   - Approved expense
   - Approved vendor bill line
   - Allowance overage
   - Markup applied by cost-code/contract/org fallback
9. Generate the invoice.
10. Open the client portal invoice view and verify open-book detail shows underlying billable costs.

## Pass Criteria

- No duplicate billable-cost rows for the same source.
- Unapproved time/expenses/vendor bills do not invoice.
- Generated invoice lines point back to `billable_costs`.
- Billed costs are no longer open.
- Allowance overage appears once and updates while still open.
