-- PENDING HUMAN APPROVAL — destructive. Do not apply without review.
--
-- Finishes what `remove_speculative_payment_schema` started. That migration
-- dropped `vendor_portal_identities.password_hash` and `last_authenticated_at`
-- because authentication belongs to `external_identities`. These two columns are
-- the rest of the same removed mechanism: they only ever meant "failed password
-- attempts against a vendor password", and there is no vendor password to fail
-- against.
--
-- Brute-force protection on the account that controls payout destinations is NOT
-- being removed — it lives where the authentication does. `external_identities`
-- carries its own `password_attempts` / `password_locked_until`, and
-- `recordPasswordFailure` / `isLockedOut` / `nextLockoutState` in
-- `lib/services/external-portal-auth.ts` write and enforce them on every failed
-- sign-in. Leaving a second, permanently-zero lockout counter on the vendor
-- profile advertises a control Arc does not operate there and invites a future
-- reader to trust it.
--
-- `last_step_up_at` is deliberately NOT dropped: vendor-administrator step-up is
-- a gated decision in the fintech gameplan, and that column is its reserved
-- storage.

begin;

alter table public.vendor_portal_identities
  drop column if exists password_attempts,
  drop column if exists password_locked_until;

commit;
