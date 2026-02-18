# Arc RBAC Gameplan (Production + Enterprise Grade)

## 1. Goals

Build an authorization system that is:

- Secure by default (deny-by-default, least privilege).
- Multi-tenant safe (no cross-org data leakage).
- Flexible (supports org-level and project-level responsibilities).
- Auditable (every privileged action traceable).
- Operable (support and platform access without breaking tenant isolation).

This plan intentionally designs the target state from first principles, not from current implementation constraints.

## 1.1 Live Baseline (Verified via Supabase MCP on February 12, 2026)

Project checked: `gzlfiskfkvqgpzqldnwk` (`Arc`, `us-east-2`).

Current production RBAC baseline:

- Role scopes in DB are `org` and `project`.
- Roles present:
  - org: `owner`, `admin`, `staff`, `readonly`
  - project: `pm`, `field`, `client`
- Permission catalog has 9 keys:
  - `org.admin`, `org.member`, `org.read`
  - `project.manage`, `project.read`
  - `billing.manage`, `audit.read`, `features.manage`, `members.manage`
- Org roles have permission mappings.
- Project roles currently have zero mapped permissions (`pm`, `field`, `client` all empty).
- RLS for most business tables is org-membership based (`is_org_member(org_id)`), not capability-based.
- `roles` and `role_permissions` are service-role only under RLS.
- No dedicated platform authorization tables currently exist:
  - `platform_memberships`
  - `impersonation_sessions`
  - `authorization_audit_log`
  - `user_permission_overrides`
  - `approval_authorities`
  - `policy_rules`

Implication for rollout:

- The system has a solid seed RBAC core, but enterprise controls are not yet modeled in DB.
- The highest-priority functional gap is project-role effectiveness (project roles exist but do not grant capabilities).
- Platform authorization must be introduced as a separate auth plane rather than extending tenant memberships.

## 2. Target Model

Use a **hybrid model**:

- **RBAC** for baseline role-to-permission assignment.
- **ABAC constraints** for contextual rules:
  - project assignment
  - record ownership
  - amount limits
  - workflow state
  - time/expiry
- **Policy guardrails** for segregation of duties (SoD), approval chains, and step-up authentication.

## 3. Role Scopes

### 3.1 Platform Scope (Arc internal operators)

These are not tenant roles. They live in a separate platform authorization plane.

- `platform_super_admin` (break-glass only, heavily restricted)
- `platform_admin` (support + operational admin)
- `platform_billing_ops` (plans/subscriptions/entitlements only)
- `platform_support_readonly` (diagnostics/read-only support)
- `platform_security_auditor` (audit/compliance visibility)

Key rule: platform roles must never be represented as tenant org memberships.

### 3.2 Tenant Org Scope (customer organization)

- `org_owner`
- `org_admin`
- `org_finance_admin`
- `org_ops_admin`
- `org_member`
- `org_readonly`

### 3.3 Project Scope (within a tenant project)

- `project_manager`
- `superintendent`
- `project_engineer`
- `estimator_precon`
- `project_accountant`
- `client_representative`
- `subcontractor_user`
- `consultant_user`

## 4. Permission Taxonomy

Use granular action-based keys. Recommended namespaces:

- `org.*`: org settings, users, compliance policy.
- `team.*`: invite, remove, role assignment, MFA reset.
- `project.*`: create, archive, configure.
- `schedule.*`: read/edit/baseline/publish.
- `docs.*`: upload/read/download/share/delete/version.
- `drawings.*`: upload, markups, issue revisions.
- `rfi.*`, `submittal.*`, `punch.*`, `daily_log.*`.
- `contract.*`, `change_order.*`, `commitment.*`.
- `budget.*`, `forecast.*`.
- `invoice.*`, `bill.*`, `payment.*`, `draw.*`, `retainage.*`.
- `report.*`: financial and operational reports.
- `audit.*`: read/export.
- `billing.*`: subscription/plan/payment methods.
- `feature_flag.*`: manage feature rollout.
- `portal.*`: external access token policies.
- `platform.*`: platform-only operations (never in tenant role mappings).

Guidelines:

- No permission should represent multiple business actions.
- Use verbs and explicit resources: `invoice.approve`, not `invoice.manage`.
- Add `*.read` explicitly; do not assume read if write is granted.

## 5. Enterprise Guardrails (Essential)

### 5.1 Segregation of Duties (SoD)

Examples:

- Creator of an invoice cannot be final approver.
- Creator of a change order cannot be sole approver above threshold.
- Billing role cannot alter audit log retention settings.

### 5.2 Monetary Approval Limits

Attach limits per user/role:

- `approval_limit_cents`
- by domain (`change_order`, `bill`, `payment_release`, `draw`)

Require multi-approver chain above thresholds.

### 5.3 Step-Up Authentication

Require fresh auth/WebAuthn for:

- payment release
- plan changes
- destructive role changes
- impersonation initiation

### 5.4 Time-Bound Elevated Access

Support just-in-time elevation:

- expires automatically
- reason required
- auto-audited

### 5.5 Break-Glass Controls

- separate account(s)
- hardware key + MFA
- short-lived sessions
- mandatory incident ticket reference

## 6. Data Model (Target)

Keep current core tables and add/normalize:

- `permissions` (canonical key registry).
- `roles` (`scope`: `platform|org|project|external`).
- `role_permissions`.
- `org_memberships` and `project_memberships` (status + validity window).
- `platform_memberships` (separate table, never mixed with tenant rows).
- `user_permission_overrides` (allow/deny, scoped, expiry).
- `approval_authorities` (type, limits, required approver count).
- `policy_rules` (JSONB constraints by org/project).
- `impersonation_sessions` (actor, target, reason, start/end, approvals).
- `authorization_audit_log` (decision log with policy inputs/outputs).

Important:

- Add uniqueness/indexing for role assignment integrity.
- Add `valid_from`/`valid_to` for memberships and overrides.
- Explicit soft-delete/status fields for forensic trail.

## 7. Enforcement Architecture

### 7.1 Enforcement Layers

1. API/service guards (primary business authorization).
2. Database RLS (tenant boundary + coarse security fence).
3. UI gating (usability only, never trusted for security).

### 7.2 Decision Engine

Implement centralized authorization checks:

- `authorize(subject, action, resource, context)`
- Returns: `allow/deny`, reason code, evaluated policies.

Include:

- role resolution across scopes
- permission union + explicit deny precedence
- ABAC constraint evaluation
- SoD and approval policy checks

### 7.3 Caching Strategy

- Cache resolved permissions in memory/Redis with short TTL.
- Invalidate on membership/role/policy changes.
- Never cache impersonation decisions beyond session token TTL.

## 8. Platform Access and Org Impersonation

### 8.1 Platform Console

Build a dedicated `/platform` application area:

- org directory and health
- billing/plan tooling
- feature operations
- global audit and support tooling

### 8.2 Entering Tenant Context

Two explicit modes:

- `enter_org_context` (as platform actor, no user impersonation)
- `impersonate_user` (simulate specific user)

Both require:

- reason capture
- visible UI banner
- immutable audit event
- explicit exit action

### 8.3 Restrictions

- `platform_support_readonly` cannot mutate tenant data.
- Sensitive tenant mutations require `platform_admin` + step-up auth.
- Break-glass actions require extra controls and notification hooks.

## 9. RLS Strategy (Database)

Use RLS for tenant boundary and critical fences, not full business policy.

- Keep `is_org_member(org_id)` style guards for table access.
- Add project membership checks where appropriate (`is_project_member`).
- Add service-role bypass only for controlled backend operations.
- Prevent direct client reads of role-permission internals if not needed.

Critical: never rely only on RLS for feature permissions like approvals, limits, SoD.

## 10. API and Service Patterns

Standardize all write paths to:

1. Resolve auth context.
2. Resolve tenant/project context.
3. Call centralized `authorize`.
4. Execute business logic.
5. Emit audit event.

No service should directly check hardcoded role keys (`if role === "owner"`), except for bootstrap exceptions documented in one place.

## 11. UI/UX Requirements

- Render capability-driven UI (`can("invoice.approve")`).
- Show disabled state with explainers where appropriate.
- Avoid hidden failures: if action denied server-side, return typed denial reason.
- Include “why denied” messages for supportability.

## 12. Audit and Compliance Requirements

For each privileged action log:

- actor user id
- effective role(s)
- org/project/resource id
- action key
- decision outcome
- policy version/rule ids
- request id, IP, user agent
- impersonation metadata if present

Retention:

- immutable long-term retention for authz audit logs.
- export capability for SOC 2/ISO evidence collection.

## 13. Security Requirements

- MFA required for admin/platform roles.
- Session hardening: rotation, inactivity timeout, absolute max lifetime.
- Signed session claims must include active scope and impersonation metadata.
- CSRF protection for mutating browser actions.
- Rate limits on authz-sensitive endpoints (invites, role changes, impersonation).

## 14. Migration and Rollout Plan

### Phase 0: Design Lock

- finalize permission catalog and role matrices
- define SoD rules and monetary approval thresholds
- define platform role policy and impersonation rules

### Phase 1: Schema and Seeds

- add missing authz tables/columns/indexes
- seed canonical permissions and roles
- create migration-safe idempotent seeds

### Phase 2: Central Authorizer

- implement unified `authorize()` service
- add typed denial reasons and decision tracing
- add cache with invalidation hooks

### Phase 3: Service Enforcement

- enforce in highest-risk domains first:
  - billing/payments
  - change orders/commitments
  - team management
  - external portal access

### Phase 4: Platform Console + Impersonation

- platform role enforcement
- org context switch + impersonation session controls
- persistent banners and “exit impersonation”

### Phase 5: RLS Tightening

- refine project-level RLS for project-scoped tables
- remove legacy broad access paths after parity validation

### Phase 6: Cleanup and Hardening

- remove deprecated role checks
- enforce deny-by-default for unknown permissions
- complete runbooks and compliance evidence automation

## 15. Testing Strategy

### 15.1 Unit Tests

- role-to-permission expansion
- allow/deny precedence
- ABAC constraints
- SoD/approval-limit logic

### 15.2 Integration Tests

- end-to-end permission checks on all critical endpoints
- impersonation session behavior
- multi-tenant isolation tests

### 15.3 Regression Matrix

Role x Action x Resource matrix for:

- org roles
- project roles
- platform roles
- external roles

### 15.4 Security Tests

- privilege escalation attempts
- horizontal tenant access attempts
- stale-cache decision mismatch tests

## 16. Observability and Operations

- Authorization decision metrics:
  - deny rate by action
  - top denied actions
  - impersonation frequency
  - policy evaluation latency
- Alerts:
  - sudden spike in denied admin actions
  - unusual impersonation usage
  - break-glass session activation

## 17. Documentation and Governance

- Maintain a single source of truth:
  - permission catalog
  - role-permission mappings
  - SoD matrix
  - approval thresholds
- Require change control for permission model updates:
  - security review
  - migration review
  - release note

## 18. Acceptance Criteria (Production Ready)

RBAC is considered production-ready when all conditions are true:

- 100 percent of mutating server actions use centralized `authorize`.
- Critical reads also authorized (not only writes).
- Platform and tenant auth planes are separated.
- Impersonation is explicit, reasoned, and fully audited.
- Monetary approvals and SoD are enforced for finance workflows.
- Role/permission changes take effect quickly (bounded cache staleness).
- Automated test matrix covers all high-risk permissions.
- Audit logs are exportable and immutable.

## 19. Immediate Next Steps for Arc (Recommended)

1. Expand the permission catalog beyond the current 9 keys and lock naming conventions.
2. Seed project-role permission mappings (`pm`, `field`, `client`) so project roles become operationally meaningful.
3. Introduce platform auth tables and policies (`platform_memberships`, `impersonation_sessions`, `authorization_audit_log`) as a separate scope.
4. Implement centralized authorizer and migrate top 10 highest-risk actions first.
5. Add approval limits + SoD rules for change orders, bills, invoices, and payment release flows.

## 20. Implementation Progress

Last updated: February 12, 2026.

### Phase 1: Schema and Seeds

- Status: Applied and verified.
- Migrations added:
  - `/Users/agustinzenuto/Desktop/Projects/arc/supabase/migrations/20260212021136_rbac_phase1_role_scope_enum.sql`
  - `/Users/agustinzenuto/Desktop/Projects/arc/supabase/migrations/20260212021231_rbac_phase1_foundation.sql`

Progress tracker:

- [x] Expand permission catalog beyond 9 baseline keys.
- [x] Add permission key format guardrail (`permissions_key_format_chk`).
- [x] Seed project role mappings for `pm`, `field`, and `client`.
- [x] Add platform roles (`platform_super_admin`, `platform_admin`, `platform_billing_ops`, `platform_support_readonly`, `platform_security_auditor`).
- [x] Seed platform role permission mappings.
- [x] Add `platform_memberships` table with scope-enforcement trigger.
- [x] Add `impersonation_sessions` ledger table.
- [x] Add `authorization_audit_log` table.
- [x] Add RLS policies for new platform/authz tables (service-role only for now).
- [x] Apply migration to live project and validate on staging/prod data.
- [x] Implement centralized authorizer service wiring to consume new platform tables.

Validation checklist after apply:

- Verify role scope enum now includes `platform` and `external`.
- Verify new permissions are queryable in `public.permissions`.
- Verify `pm`, `field`, `client` have non-zero permission mappings in `public.role_permissions`.
- Verify new tables exist with RLS enabled and indexes present.
- Verify no regression in existing membership and project access flows.

### Phase 2: Central Authorizer

- Status: Completed.
- Code added:
  - `/Users/agustinzenuto/Desktop/Projects/arc/lib/services/authorization.ts`
- Code updated:
  - `/Users/agustinzenuto/Desktop/Projects/arc/lib/services/permissions.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/lib/services/commitments.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/lib/services/vendor-bills.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/lib/services/draws.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/lib/services/retainage.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/companies/[id]/actions.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/projects/[id]/commitments/actions.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/projects/[id]/payables/actions.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/projects/[id]/actions.ts`

Phase 2 tracker:

- [x] Introduce centralized `authorize()` decision function.
- [x] Add `requireAuthorization()` guard helper.
- [x] Resolve permission union across org/project/platform scopes.
- [x] Add optional authorization decision audit logging (`authorization_audit_log`).
- [x] Wire existing permission helpers to centralized authorizer.
- [x] Migrate highest-risk services to explicit resource-aware authorization context.
- [x] Add typed deny reasons to API responses for client UX.

### Phase 3: Service Enforcement

- Status: Completed.
- Code updated:
  - `/Users/agustinzenuto/Desktop/Projects/arc/lib/services/team.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/lib/services/change-orders.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/lib/services/payments.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/lib/services/commitments.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/lib/services/vendor-bills.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/lib/services/draws.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/lib/services/retainage.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/api/webhooks/stripe/route.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/team/actions.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/change-orders/actions.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/payments/actions.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/companies/[id]/actions.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/projects/[id]/commitments/actions.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/projects/[id]/payables/actions.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/projects/[id]/actions.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/lib/services/authorization.ts`
- Docs added:
  - `/Users/agustinzenuto/Desktop/Projects/arc/docs/rbac-phase3-financial-integration-harness.md`

Phase 3 tracker:

- [x] Team management mutation flows now use `requireAuthorization(...)` with resource context.
- [x] Change-order create/publish/approve flows now use explicit scoped authorization checks.
- [x] Payments management flows now enforce scoped permissions for internal actions.
- [x] Added typed auth denial signaling in server actions (`AUTH_FORBIDDEN:<reason_code>`).
- [x] Add resource-aware checks to remaining financial flows (vendor bills, commitments, draws, retainage).
- [x] Add explicit authorization checks for webhook-triggered financial side effects where actor context is available.
- [x] Add integration tests for deny/allow behavior on updated high-risk flows.

### Phase 4: Platform Console + Admin Surface

- Status: Completed.
- Code added:
  - `/Users/agustinzenuto/Desktop/Projects/arc/lib/services/platform-access.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/lib/services/platform-session.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/platform/page.tsx`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/platform/actions.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/components/platform/impersonation-panel.tsx`
  - `/Users/agustinzenuto/Desktop/Projects/arc/components/layout/platform-session-banner.tsx`
  - `/Users/agustinzenuto/Desktop/Projects/arc/docs/rbac-phase4-validation.md`
- Code updated:
  - `/Users/agustinzenuto/Desktop/Projects/arc/lib/auth/guards.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/lib/services/authorization.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/lib/services/permissions.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/lib/auth/context.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/middleware.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/components/layout/app-sidebar.tsx`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/layout.tsx`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/actions/orgs.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/api/orgs/route.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/admin/page.tsx`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/admin/analytics/page.tsx`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/admin/customers/page.tsx`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/admin/plans/page.tsx`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/admin/support/page.tsx`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/admin/features/page.tsx`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/admin/audit/page.tsx`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/admin/provision/page.tsx`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/admin/provision/actions.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/admin/customers/actions.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/admin/plans/actions.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/admin/features/actions.ts`

Phase 4 tracker:

- [x] Add dedicated `/platform` console page guarded by platform membership.
- [x] Surface platform entry in app navigation when user has platform access.
- [x] Allow platform operators to list and navigate tenant org inventory.
- [x] Update admin pages to allow either tenant permissions or platform-equivalent permissions.
- [x] Update admin server actions to accept platform-equivalent permissions (billing/features/provisioning).
- [x] Implement explicit org context entry flow (`platform.org.access`) with scoped session metadata.
- [x] Implement user impersonation session lifecycle UI and controls (`impersonation.start` / `impersonation.end`).
- [x] Add persistent impersonation banner + explicit exit affordance across app shell.
- [x] Add platform-role allow/deny validation matrix for `/platform` and `/admin` (`/Users/agustinzenuto/Desktop/Projects/arc/docs/rbac-phase4-validation.md`).

### Phase 5: RLS Tightening

- Status: Completed rollout waves 1-3 in production with regression harness.
- Migration added and applied:
  - `/Users/agustinzenuto/Desktop/Projects/arc/supabase/migrations/20260212024648_phase5_rls_project_scope_wave1.sql`
  - `/Users/agustinzenuto/Desktop/Projects/arc/supabase/migrations/20260212025001_phase5_rls_project_scope_wave2_indirect.sql`
  - `/Users/agustinzenuto/Desktop/Projects/arc/supabase/migrations/20260212025305_phase5_rls_project_scope_wave3_modules.sql`
- Docs added:
  - `/Users/agustinzenuto/Desktop/Projects/arc/docs/rbac-phase5-regression-harness.md`

Phase 5 tracker:

- [x] Add org-admin helper function for RLS (`public.is_org_admin_member(uuid)`).
- [x] Tighten project-scoped RLS policies for wave-1 tables:
  - `tasks`, `schedule_items`, `schedule_dependencies`, `daily_logs`, `daily_log_entries`
  - `photos`, `punch_items`, `rfis`, `submittals`
  - `change_orders`, `commitments`, `vendor_bills`, `invoices`, `payments`, `conversations`
- [x] Preserve org-scoped access for rows with `project_id is null`.
- [x] Preserve service-role bypass for backend jobs.
- [x] Preserve owner/admin cross-project visibility during rollout.
- [x] Tighten indirect project-scoped tables without `project_id` via parent-join RLS (`*_lines`, `messages`, `mentions`, `receipts`, `rfi_responses`, `task_assignments`).
- [x] Expand RLS tightening to the remaining project-bound modules (`drawings`, `documents`, `closeout`, `selections`, `warranty`, including e-sign child tables).
- [x] Add regression test harness for user-role x project-membership x table access matrix.

### Phase 6: Cleanup and Hardening

- Status: In progress (core hardening controls implemented, org role cutover started).
- Code updated:
  - `/Users/agustinzenuto/Desktop/Projects/arc/lib/services/authorization.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/lib/services/permissions.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/lib/services/access.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/components/layout/org-switcher.tsx`
  - `/Users/agustinzenuto/Desktop/Projects/arc/lib/services/team.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/lib/validation/team.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/lib/types.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/team/actions.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/team/page.tsx`
  - `/Users/agustinzenuto/Desktop/Projects/arc/components/team/invite-member-dialog.tsx`
  - `/Users/agustinzenuto/Desktop/Projects/arc/components/team/edit-member-dialog.tsx`
  - `/Users/agustinzenuto/Desktop/Projects/arc/components/team/team-table.tsx`
  - `/Users/agustinzenuto/Desktop/Projects/arc/components/team/member-role-badge.tsx`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/settings/actions.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/settings/page.tsx`
  - `/Users/agustinzenuto/Desktop/Projects/arc/components/settings/settings-window.tsx`
  - `/Users/agustinzenuto/Desktop/Projects/arc/app/(auth)/auth/actions.ts`
  - `/Users/agustinzenuto/Desktop/Projects/arc/lib/services/provisioning.ts`
- Migration added:
  - `/Users/agustinzenuto/Desktop/Projects/arc/supabase/migrations/20260214123000_rbac_org_role_cutover.sql`
  - `/Users/agustinzenuto/Desktop/Projects/arc/supabase/migrations/20260214131500_remove_legacy_org_roles.sql`
- Docs added:
  - `/Users/agustinzenuto/Desktop/Projects/arc/docs/rbac-phase6-runbook.md`

Phase 6 tracker:

- [x] Enforce deny-by-default for unknown permission keys (`deny_unknown_permission`).
- [x] Remove direct owner role-key bypass from org access checks; use permission-based gating.
- [x] Remove UI fallback relying on synthetic role labels for platform create access.
- [x] Add Phase 6 runbook and evidence collection checklist.
- [x] Remove remaining deprecated role checks across long-tail modules (`lib/services/context.ts` locked-org bypass now permission-based).
- [x] Add compliance evidence automation job (scheduled export/report) via `/api/jobs/rbac-evidence`.
- [x] Shift Team/Settings invite + role-edit flows to DB-driven org role options (remove hardcoded legacy role keys from UI/forms).
- [x] Add org role key cutover migration (`org_*` role seeds, role_permissions mappings, membership backfill from legacy keys).
- [x] Remove legacy org role keys from database after backfill (`owner`, `admin`, `staff`, `readonly`), with safety guard.
