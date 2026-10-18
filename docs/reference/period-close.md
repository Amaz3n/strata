# Period close

Close is a dedicated Books page at `/books/close`, alongside General ledger and Banking. `/books/close/[periodId]` opens a particular period without losing the period navigator. Books activation and existing role permissions still govern access.

The default selection is the oldest unfinished period that has ended, falling back to the current or most recent period. A fresh checklist is required before the close action becomes available. Required controls block closing; advisories remain visible without blocking. The server reruns the checklist when closing, so displayed results are never the final authority.

The review defaults to exceptions. Expand a control to inspect its evidence and open the source workflow. Clearing schedules and live accounting reconciliation findings are available within the relevant control. Reopening requires a substantive reason. Year-end posting remains part of the server close operation, without a separate posting button.

Accounting setup, exports, and tax filing management remain in their dedicated destinations. They are not repeated on Close. External sync checks are inapplicable when the configured external sync posture is disconnected; connected workflows retain the existing sync gate.

Verification: close review rules have coverage in `tests/books-close-review.test.js`. Browser verification covers the empty checklist, live checklist execution, blocked close, control evidence, period navigation, and responsive layout. It does not close or reopen an actual accounting period.
