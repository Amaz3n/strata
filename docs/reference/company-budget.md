# Company budget

The Books sidebar opens Company budget at `/books/overhead`. The legacy URL is retained; Company budget is a dedicated workspace within the Books navigation group.

Company budget covers expense accounts without a project. Project budgets remain the home for job costs. Actuals come from posted ledger activity on an accrual basis, using the same operating-entry rules as the P&L. The account activity sheet is filtered to the same account, period, and non-project scope.

The workspace offers fiscal-year and monthly views, cumulative spending through the current month, account search, and an over-budget filter. The annual chart selects months. A missing budget is distinct from a saved zero-dollar plan.

The plan editor saves the full annual budget using the existing atomic action. Users can spread an annual amount exactly across twelve months, adjust monthly amounts, or populate an account from the selected year's actuals. Draft, active, and archived status remain supported. Closing a dirty editor asks whether to discard; unsuccessful saves retain the draft.

Inactive accounts remain visible when they have actuals or budget amounts. Existing SQL allows budget lines only on active accounts, so a plan with a budgeted inactive account cannot be edited until that account is reactivated. This avoids silently deleting historical budget amounts.

Permissions remain `books.read` for viewing and `books.adjust` for editing. No schema changes are required.

Known boundary: an expense without a project may be intentionally company-wide or may still need project coding. The workspace does not infer that intent or allocate company overhead back to projects.

Validation: `node --test tests/company-budget.test.js tests/books-statement-correctness.test.js`; targeted ESLint; browser checks for filtering, period drill-down, exact-cent allocation, and discard protection. Browser checks intentionally do not save test financial plans into the active company.
