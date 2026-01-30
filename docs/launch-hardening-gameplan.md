# Launch Hardening Gameplan

## Goals
- Make the system safe for public launch with minimal risk.
- Preserve velocity while closing critical security and reliability gaps.
- Establish baseline monitoring and operational readiness.

---

## Phase 0 — Audit Confirmation (1–2 days)
- Inventory all public endpoints and portal flows.
- Confirm which routes run with service-role access.
- Validate which flows depend on RLS vs server-side permission checks.

Deliverable: a short risk register with owners and priorities.

---

## Phase 1 — Security & Access Control (High Priority)

### 1) Tighten Row-Level Security (RLS)
- Replace broad `FOR ALL` org-member policies with scoped policies:
  - **Read**: org member or project member (per table).
  - **Write**: require explicit role permission (org/project).
- Block direct client-side writes for sensitive tables; funnel through server actions with permission checks.

### 2) Portal PIN Enforcement
- Require PIN verification server-side for all portal actions when `pin_required = true`.
- Set a signed/session cookie after PIN verification.
- Deny any portal action without verified PIN when required.

### 3) Public Endpoint Hardening
- Require secrets for cron endpoints in prod.
- Add rate limiting for public token routes (`/p/*`, `/s/*`, `/proposal/*`, receipts).
- Remove or gate verbose logs that include token fragments.

---

## Phase 2 — Job Processing Reliability (High Priority)

### 4) Outbox Claiming & Idempotency
- Switch to atomic job claiming (RPC/transaction).
- Ensure idempotent handlers (e.g., avoid double inserts).
- Add retry/backoff with clear terminal states.

### 5) Separate Heavy Work from Request Paths
- Ensure drawing/tiling tasks run only in workers.
- Keep API routes lightweight.

---

## Phase 3 — Data Safety & Auditability (Medium Priority)

### 6) Access Logging & Audits
- Fix portal access logging (token vs id mismatch).
- Ensure audit events are written for destructive actions.

### 7) Storage Policies
- Define explicit storage policies for `storage.objects` if any client-side access exists.

---

## Phase 4 — Observability & Ops (Medium Priority)

### 8) Monitoring
- Error monitoring for API routes, server actions, worker jobs.
- Alerts on outbox failures and job backlog.

### 9) Performance Baseline
- Dashboard metrics (DB latency, API p95).
- Track heavy query execution times.

---

## Phase 5 — Launch Readiness (Low/Medium Priority)

### 10) Build Safety
- Turn TypeScript build errors back on.
- Verify production build pipeline.

### 11) Backup & Recovery
- Verify nightly backups and restore procedure.

### 12) Incident Playbook
- Define severity levels and rollback steps.

---

## Suggested Order of Work
1. RLS tightening
2. Portal PIN enforcement
3. Cron security + rate limiting
4. Outbox atomic claiming
5. Logging fixes + audits
6. Observability + performance baselines

---

## “Go Live” Gate
Do not launch publicly until:
- RLS is restricted and validated.
- Portal PIN is enforced server-side.
- Cron endpoints require secrets.
- Outbox processing is atomic and idempotent.
- Basic monitoring is in place.
