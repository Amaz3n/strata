# RBAC Phase 4 Validation Matrix

Date: February 12, 2026

## Scope

Validate platform-role behavior for:

- `/platform` entrypoint
- `/admin` surfaces (dashboard, customers, plans, support, features, audit, provision)
- org context entry and exit
- impersonation start and end lifecycle
- persistent banner visibility

## Role Matrix

Use users with each role assignment:

- `platform_super_admin`
- `platform_admin`
- `platform_billing_ops`
- `platform_support_readonly`
- `platform_security_auditor`
- tenant-only `owner/admin` (no platform role)
- non-admin tenant `staff/readonly` (no platform role)

## Expected Outcomes

1. `/platform` access
- Platform roles: allow.
- Tenant-only roles: deny/redirect unauthorized.

2. Sidebar platform item
- Platform roles: visible.
- Non-platform roles: hidden.

3. `/admin` pages with dual permission checks
- Billing pages (`/admin`, `/admin/customers`, `/admin/plans`, `/admin/provision`, `/admin/analytics`):
  allow for `billing.manage` OR `platform.billing.manage`.
- Support page (`/admin/support`): allow for `billing.manage` OR `platform.support.read`.
- Features page (`/admin/features`): allow for `features.manage` OR `platform.feature_flags.manage`.
- Audit page (`/admin/audit`): allow for `audit.read` OR `platform.support.read`.

4. Admin mutations
- Provision customer/org/plan/features:
  enforce matching platform-equivalent permission, deny others.

5. Org context entry
- `Enter Context` on `/platform` requires `platform.org.access`.
- On success:
  - `org_id` cookie updated.
  - platform context cookies set.
  - authorization audit row written for `platform.org.access`.

6. Impersonation lifecycle
- Start requires `impersonation.start`.
- End requires `impersonation.end`.
- On start:
  - `impersonation_sessions` active row created.
  - impersonation cookies set.
  - authorization audit row written for `impersonation.start`.
- On end:
  - session moved to `ended`.
  - impersonation cookies cleared.
  - authorization audit row written for `impersonation.end`.

7. Shell banner
- Visible when platform context or impersonation session is active.
- Includes explicit `End impersonation` and/or `Exit org context` actions.
- Banner absent when no elevated session state exists.

## Command-Level Checks

1. Lint all phase-4 touched files:

```bash
pnpm -s eslint "lib/services/platform-session.ts" "app/(app)/platform/actions.ts" "components/platform/impersonation-panel.tsx" "components/layout/platform-session-banner.tsx" "app/(app)/platform/page.tsx" "app/(app)/layout.tsx" "app/actions/orgs.ts" "lib/auth/context.ts" "middleware.ts"
```

2. Verify new endpoints/components are wired:

```bash
rg -n "PlatformSessionBanner|enterOrgContextAction|startImpersonationAction|endImpersonationAction|platform.org.access|impersonation.start|impersonation.end" app lib components
```
