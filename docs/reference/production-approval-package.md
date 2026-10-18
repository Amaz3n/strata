# Production approval package (EP14-11)

**For the launch owner to approve or amend.** Nothing here is adopted until the
owner signs below. Arc's engineering targets (`loadTargets` in
`docs/enterprise-production/completion-checklist.json`) are national-builder
numbers, frozen as an engineering baseline. They stay unchanged. This package
asks the owner to accept the **first-builder** numbers below as the release's
acceptance targets, or to amend them through scope control (an entry in
`scopeChanges`, approved by the owner).

## 1. Sizing

| Measure | Proposed first-builder target | Engineering baseline (unchanged) | Demonstrated so far |
|---|---|---|---|
| Divisions | 3 | 100 | 3 (SCALE-01 dataset) |
| Communities | 30 | 2,000 | 30 |
| Lots | 1,500 | — | 1,500 |
| Active homes | 500 | 100,000 | 500 |
| Installed homes (warranty history) | 2,500 | 1,000,000 | 2,500 |
| Users | 50 named, 50 concurrent sessions | 5,000 sessions | 50-session mixed-role load (SCALE-01) |
| Desk p95 (Home, Starts, Purchasing, Sales, Warranty) | ≤ 2,000 ms | 2,000 ms | **Not yet proven.** The acceptance app runs `next dev`; the page subcases are blocked until they run against a production build |
| Mutation p95 (server-action services) | ≤ 1,500 ms | 1,500 ms | Passed at 50 sessions (SCALE-01 `mixed-role-load`, service time in process) |
| Availability | 99.95% monthly (proposed) | 99.95% | Not measurable before launch |
| Recovery point / time | 15 min / 60 min (proposed) | 15 / 60 | Restore drill timed (RESTORE-02); RPO relies on point-in-time recovery being on |

Owner decision on sizing: **accept as written** / **amend** (state the
numbers): ______________________________________________

## 2. Operating assumptions

Each assumption is something Arc's release depends on and cannot verify itself.
Mark each one: agree, or change it.

| # | Assumption | Agree / change |
|---|---|---|
| A1 | One shared deployment and one shared database serve this builder alongside existing tenants; no dedicated infrastructure | |
| A2 | Desktop browsers only for office roles; mobile web is out of scope, and field use is the iOS app (its production endpoints follow later) | |
| A3 | Working hours are US Eastern business days. Alerts reach the operator in-app and by email; nobody is paged outside hours (`arc-operations.md`, Service levels) | |
| A4 | Arc Books runs in `shadow` mode, so the connected accounting system stays authoritative until the CPA sign-off in `books-revenue-recognition.md` | |
| A5 | Live payment execution stays off (`FINTECH_PAYMENTS_*`); deposits and draws are recorded, not moved, by Arc | |
| A6 | Point-in-time recovery is enabled on the production database project | |
| A7 | The builder's existing homes, agreements, selections and warranty base arrive through Arc's importers (the Open-WIP cutover and the installed-home import), each reconciled before it may complete | |
| A8 | Roles follow `docs/production-org-playbook.md`: who works which desk and what they change. ROLE-01 holds the role matrix to that | |
| A9 | Acceptance runs in the dedicated QA org; there is no staging environment and no acceptance in a customer org | |
| A10 | Storage budget per builder per year, and HEIC originals kept beside previews: _(owner to state)_ | |
| A11 | Vercel plan cron limit: 37 of 40 jobs used; the next job shares a route rather than adding a cron | |
| A12 | Production activation follows `reference/production-activation.md`, in one owner-run window | |

## 3. Integration inventory

The builder fills this in: one row per system Arc must talk to at launch. Arc
uses it to decide what is in launch scope, and to plan a sandbox scenario for
each integration that is in.

| Area | Arc supports today | Builder's system (name, version) | Needed at launch? (yes / later / no) | Direction (into Arc / out of Arc / both) | Sandbox or test account available? | Builder contact |
|---|---|---|---|---|---|---|
| Accounting / general ledger | QuickBooks Online (adapter behind the accounting abstraction); Arc Books in shadow | | | | | |
| Bank feeds | Plaid | | | | | |
| Customer payments | Stripe (record and reconcile; execution off) | | | | | |
| E-signature | Arc native signing | | | | | |
| Outbound and inbound email | Resend (sending, inbound forwarding to project and bills addresses) | | | | | |
| Lead sources / CRM | Lead intake API (`/api/leads/intake`), milestone feeds | | | | | |
| Payroll | Summary import at month end (provider runs payroll) | | | | | |
| Permitting | Permit records and reminders in Arc; no municipal portal integration | | | | | |
| Scheduling / trade portals | Arc trade portal and notices | | | | | |
| Mortgage / lender | None | | | | | |
| Design studio / options catalog | Arc option catalog and import | | | | | |
| Land / entitlement | Arc land deals | | | | | |
| Document storage | Arc files (Supabase Storage) | | | | | |
| Single sign-on | Email and password, MFA (no SSO) | | | | | |
| Data warehouse / BI | Report exports (`report-export-api.md`) | | | | | |
| Other | | | | | | |

An integration the builder marks "needed at launch" that Arc does not support
today is a scope change. It goes through `scopeChanges` with the owner's
approval and is never added silently.

## 4. Sign-off

| Role | Name | Decision (approve / amend) | Date |
|---|---|---|---|
| Launch owner | | | |
| Builder's operations lead | | | |
| Arc operator | | | |

When signed:

1. Record the decision on EP14-11 in `completion-checklist.json`, with owner
   evidence.
2. Record any amendment as a `scopeChanges` entry.
3. Re-run SCALE-01 against a production build at the approved sizing, so the
   desk p95 rows can pass.
