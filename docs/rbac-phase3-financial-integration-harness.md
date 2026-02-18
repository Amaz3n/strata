# RBAC Phase 3 Financial Integration Harness

Date: February 12, 2026

## Scope

Validate deny/allow behavior and resource-aware checks for:

- commitments
- vendor bills
- draw invoice generation
- retainage mutations
- Stripe webhook payment side-effects when actor metadata is present

## Files Covered

- `/Users/agustinzenuto/Desktop/Projects/arc/lib/services/commitments.ts`
- `/Users/agustinzenuto/Desktop/Projects/arc/lib/services/vendor-bills.ts`
- `/Users/agustinzenuto/Desktop/Projects/arc/lib/services/draws.ts`
- `/Users/agustinzenuto/Desktop/Projects/arc/lib/services/retainage.ts`
- `/Users/agustinzenuto/Desktop/Projects/arc/app/api/webhooks/stripe/route.ts`
- `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/companies/[id]/actions.ts`
- `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/projects/[id]/commitments/actions.ts`
- `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/projects/[id]/payables/actions.ts`
- `/Users/agustinzenuto/Desktop/Projects/arc/app/(app)/projects/[id]/actions.ts`

## Permission Matrix

1. Commitments
- `commitment.read`: list commitments/lines
- `commitment.write`: create/update commitments and commitment lines

2. Vendor bills
- `bill.read`: list bills
- `bill.write`: non-approval edits
- `bill.approve`: status transition to `approved`
- `payment.release`: status transition to `partial`/`paid`

3. Draws
- `draw.read`: list due draws
- `draw.approve`: generate invoice from draw schedule
- `payment.release`: mark draw paid

4. Retainage
- `retainage.manage`: create/release/mark paid/apply and release-for-contract flows

## Typed Deny Signal Contract

All touched server actions must bubble auth denials as:

- `AUTH_FORBIDDEN:<reason_code>`

Expected `reason_code` values include:

- `deny_missing_permission`
- `deny_no_org_membership`
- `deny_no_project_membership`
- `deny_unknown_permission`

## Test Steps

1. Run lint checks for touched files:

```bash
pnpm -s eslint 'lib/services/commitments.ts' 'lib/services/vendor-bills.ts' 'lib/services/draws.ts' 'lib/services/retainage.ts' 'app/api/webhooks/stripe/route.ts' 'app/(app)/companies/[id]/actions.ts' 'app/(app)/projects/[id]/commitments/actions.ts' 'app/(app)/projects/[id]/payables/actions.ts' 'app/(app)/projects/[id]/actions.ts'
```

2. Run deny path tests with a user lacking each required permission:
- Call each action/service path and assert thrown error contains `AUTH_FORBIDDEN:` prefix in server actions.
- Confirm no financial mutation row is written on deny.

3. Run allow path tests with a fully privileged role:
- Execute each action/service path and confirm successful mutation.

4. Verify authorization audit evidence:

```sql
select occurred_at, actor_user_id, org_id, project_id, action_key, resource_type, resource_id, decision, reason_code
from public.authorization_audit_log
where action_key in (
  'commitment.read', 'commitment.write',
  'bill.read', 'bill.write', 'bill.approve',
  'draw.read', 'draw.approve',
  'retainage.manage',
  'payment.release'
)
order by occurred_at desc
limit 200;
```

5. Webhook actor-context test:
- Send a Stripe `payment_intent.succeeded` payload with metadata including `actor_user_id`, `org_id`, and `invoice_id`.
- Assert route records an authorization decision for `payment.release` with `policy_version = 'phase3-webhook-v1'`.
- For denied actor, assert response is `{ received: true, skipped: true }` and no payment/outbox write is created.

## Exit Criteria

- All deny cases return typed denial reason from server actions.
- All allow cases succeed with expected DB side-effects.
- Authorization audit log contains scoped resource-aware decision rows for all covered flows.
