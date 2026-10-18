# Arc Books navigation

Arc Books is the optional accounting system behind Arc's operational workflows. It has no overview dashboard. Control Tower remains the business-wide attention surface, and project Overview remains the job-specific surface.

The desktop and mobile Books group share these destinations: Banking, General ledger, Assets & loans, Company budget, and Close. Assets & loans requires accounting adjustment permission. Existing `/books` links redirect to Banking when Arc is the official ledger, or Accounting setup while activation is unfinished. Disabled workspaces still redirect to Settings → Accounting.

## Workflow ownership

| Work | Destination |
| --- | --- |
| Bank feeds, matching and reconciliation | Books → Banking |
| Journals and adjustments | Books → General ledger |
| Loans, fixed assets and land acquisition | Books → Assets & loans |
| Company overhead plan | Books → Company budget |
| Period checks, reconciliation findings and close | Books → Close |
| Financial statements | Reports → Financial statements; shortcut from Close |
| Exports, accountant packages, tax filing records | Linked from Close |
| Unapplied customer deposits | Billing → Billing tools → Customer deposits |
| Owned-home inventory policy, cost allocation and completion | Eligible project → Budget → Inventory accounting; also linked from Closing |
| Warranty cost approval | Warranty → Analytics → Review warranty cost accounting, and individual project Warranty |
| Warranty reserve estimate | Eligible project inventory accounting and project Warranty |
| Activation, migration, chart and calendar | Settings → Accounting |

Embedded accounting links and pages require Books to be enabled and organization-wide Books read/adjust access. They do not appear for external-only workspaces or assigned-division users. Existing server-action accounting authorization remains in place.

The overview's promotional header, summary metrics, partial P&L, operating-posture card, diagnostic rebuild button and duplicate POC CSV shortcut have been removed. Statements, reconciliation controls, migration evidence and ledger data remain available in their dedicated workflows. No accounting records or schema were removed.

Old stored close-check links to `/books` are resolved to Assets & loans when displayed; newly generated checks point directly there. Read-only deposit/register loads do not invalidate the Books layout. Accounting mutations refresh the Books layout and the relocated deposit/warranty destinations.

Validation: focused Books regression tests, TypeScript, targeted ESLint, and local authenticated browser checks. Browser verification navigates and reads existing data; it does not post accounting entries or close periods.
