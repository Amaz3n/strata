-- DESTRUCTIVE / PENDING HUMAN APPROVAL
-- Apply only after every web, worker, mobile, and rollback artifact uses the
-- singular `payment.<verb>` keys introduced by
-- 20260812124629_normalize_payment_permission_domain.sql.

begin;

do $$
begin
  if exists (
    select 1 from pg_policies
    where schemaname = 'public'
      and (qual like '%payments.manage_rail%' or qual like '%payments.override_hold%'
        or with_check like '%payments.manage_rail%' or with_check like '%payments.override_hold%')
  ) then
    raise exception 'An RLS policy still depends on a legacy plural payment permission';
  end if;
end;
$$;

delete from public.role_permissions
where permission_key in ('payments.manage_rail','payments.approve_run','payments.override_hold');
delete from public.membership_permission_overrides
where permission_key in ('payments.manage_rail','payments.approve_run','payments.override_hold');
delete from public.permissions
where key in ('payments.manage_rail','payments.approve_run','payments.override_hold');

commit;
