# RBAC Phase 6 Runbook

Date: February 12, 2026

## Scope

Phase 6 cleanup/hardening controls:

1. Deny unknown permission keys by default.
2. Replace direct role-key bypass checks with permission checks.
3. Document evidence and operational checks for RBAC change control.

## Hardening Controls Implemented

### 1) Unknown Permission Deny

Authorizer behavior:

- If a permission key is not present in `public.permissions`, authorization denies with `deny_unknown_permission`.
- This applies before role expansion, including platform super-admin paths.

Code:

- `/Users/agustinzenuto/Desktop/Projects/arc/lib/services/authorization.ts`

Operational impact:

- Typos in permission keys fail closed.
- New permissions must be seeded in DB before app code references them.

### 2) Deprecated Role Bypass Removal

Replaced owner role-key billing bypass with permission-based check:

- old: `membership.role_key === "owner"`
- new: `hasPermission("billing.manage", { orgId, userId })`

Code:

- `/Users/agustinzenuto/Desktop/Projects/arc/lib/services/access.ts`

### 3) Platform Access Fallback Tightening

Removed UI fallback that inferred platform create access from a synthetic role label.
Creation visibility now follows API-provided `canCreateOrganization`.

Code:

- `/Users/agustinzenuto/Desktop/Projects/arc/components/layout/org-switcher.tsx`

### 4) Evidence Automation Job

Added cron-safe RBAC evidence snapshot job:

- Endpoint: `POST /api/jobs/rbac-evidence`
- Auth: `CRON_SECRET` bearer or Vercel cron header in production
- Schedule: daily via `/Users/agustinzenuto/Desktop/Projects/arc/vercel.json`

Artifacts written:

- A snapshot row into `public.authorization_audit_log` with:
  - `action_key = 'authz.evidence.snapshot'`
  - digest over `role_permissions`
  - latest migration versions
  - deny-rate counters (`24h`)

## Release Checklist (RBAC Changes)

1. Add/modify permission catalog in migration.
2. Add/modify role mappings in migration.
3. Apply migration in development/staging.
4. Verify authorizer deny/allow behavior for:
   - known permission + granted role
   - known permission + missing role
   - unknown permission key
5. Verify audit log writes for authorization decisions.
6. Verify platform elevated session flows still function.
7. Update `/Users/agustinzenuto/Desktop/Projects/arc/docs/rbac-plan.md`.

## Evidence Collection Checklist

Collect and store:

1. Migration versions applied (`supabase_migrations.schema_migrations` / MCP list).
2. Policy snapshot (`pg_policies`) for changed tables.
3. Authorization audit sample rows for:
   - allow decision
   - deny missing permission
   - deny unknown permission
4. Platform membership grants/revocations relevant to release window.

## SQL Snippets

List latest migration versions:

```sql
select * from supabase_migrations.schema_migrations order by version desc limit 20;
```

Inspect changed policies:

```sql
select tablename, policyname, qual, with_check
from pg_policies
where schemaname='public'
order by tablename, policyname;
```

Inspect unknown-permission denials:

```sql
select occurred_at, actor_user_id, action_key, decision, reason_code
from public.authorization_audit_log
where reason_code = 'deny_unknown_permission'
order by occurred_at desc
limit 50;
```
