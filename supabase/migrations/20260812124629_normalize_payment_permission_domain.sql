-- All payment permissions now use the singular `payment.<verb>` domain. Keep
-- role grants and explicit user overrides intact while replacing the legacy
-- plural keys, then rebuild RLS predicates that embed the old literals.

begin;

insert into public.permissions (key, description)
values
  ('payment.manage_rail', 'Manage payment rail settings, vendor relationships, and funding sources'),
  ('payment.approve_run', 'Approve or reject electronic payment runs'),
  ('payment.override_hold', 'Override a compliance or waiver payment hold')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select role_id,
  case permission_key
    when 'payments.manage_rail' then 'payment.manage_rail'
    when 'payments.approve_run' then 'payment.approve_run'
    when 'payments.override_hold' then 'payment.override_hold'
  end
from public.role_permissions
where permission_key in ('payments.manage_rail','payments.approve_run','payments.override_hold')
on conflict do nothing;

insert into public.membership_permission_overrides (membership_id, permission_key, effect)
select membership_id,
  case permission_key
    when 'payments.manage_rail' then 'payment.manage_rail'
    when 'payments.approve_run' then 'payment.approve_run'
    when 'payments.override_hold' then 'payment.override_hold'
  end,
  effect
from public.membership_permission_overrides
where permission_key in ('payments.manage_rail','payments.approve_run','payments.override_hold')
on conflict (membership_id, permission_key) do update set effect = excluded.effect;

update public.start_gate_definitions
set requires_attestation_permission = case requires_attestation_permission
  when 'payments.manage_rail' then 'payment.manage_rail'
  when 'payments.approve_run' then 'payment.approve_run'
  when 'payments.override_hold' then 'payment.override_hold'
end
where requires_attestation_permission in ('payments.manage_rail','payments.approve_run','payments.override_hold');

-- Keep the plural grants as a deployment compatibility alias. The currently
-- running application may still ask for them between this migration and the
-- application rollout. Their guarded deletion is a destructive pending
-- migration after every runtime is confirmed on `payment.*`.

drop policy if exists vendor_company_claims_read on public.vendor_company_claims;
create policy vendor_company_claims_read on public.vendor_company_claims
  for select to authenticated
  using (public.has_org_permission(org_id, 'payment.manage_rail'));

drop policy if exists payment_run_approvers_write on public.payment_run_approvers;
create policy payment_run_approvers_write on public.payment_run_approvers
  for all to authenticated
  using (public.has_org_permission(org_id, 'payment.manage_rail'))
  with check (public.has_org_permission(org_id, 'payment.manage_rail'));

do $$
declare
  target record;
begin
  for target in
    select * from (values
      ('payment_hold_policies', 'payment_hold_policies_write'),
      ('payment_hold_overrides', 'payment_hold_overrides_write')
    ) as policies(table_name, policy_prefix)
  loop
    execute format('drop policy if exists %I on public.%I', target.policy_prefix, target.table_name);
    execute format('drop policy if exists %I on public.%I', target.policy_prefix || '_insert', target.table_name);
    execute format('drop policy if exists %I on public.%I', target.policy_prefix || '_update', target.table_name);
    execute format('drop policy if exists %I on public.%I', target.policy_prefix || '_delete', target.table_name);
    execute format(
      'create policy %I on public.%I for insert to authenticated with check (public.has_org_permission(org_id, %L))',
      target.policy_prefix || '_insert', target.table_name, 'payment.override_hold'
    );
    execute format(
      'create policy %I on public.%I for update to authenticated using (public.has_org_permission(org_id, %L)) with check (public.has_org_permission(org_id, %L))',
      target.policy_prefix || '_update', target.table_name, 'payment.override_hold', 'payment.override_hold'
    );
    execute format(
      'create policy %I on public.%I for delete to authenticated using (public.has_org_permission(org_id, %L))',
      target.policy_prefix || '_delete', target.table_name, 'payment.override_hold'
    );
  end loop;
end $$;

commit;
