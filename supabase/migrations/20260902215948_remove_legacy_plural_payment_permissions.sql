-- Retire the plural `payments.<verb>` deployment compatibility alias.
--
-- 20260812124629_normalize_payment_permission_domain.sql copied every plural
-- grant onto its singular `payment.<verb>` twin and deliberately left the plural
-- rows standing, because the application running at that moment might still ask
-- for them. That window is closed: no `.ts`, `.tsx`, `.js` or `.swift` source
-- references a plural key, the last read left in a486adf5 (2026-08-12), and
-- production has been serving a descendant of that commit since 2026-08-13.
--
-- Nothing loses access. All nine role grants are shadowed by their singular
-- equivalent on the same role, and there are no membership overrides or start
-- gates on a plural key at all.

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
