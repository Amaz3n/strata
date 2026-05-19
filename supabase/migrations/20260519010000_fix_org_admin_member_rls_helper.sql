-- Ensure project-scoped RLS can recognize organization admins.
--
-- Policies for project-scoped tables such as invoices, commitments, and
-- vendor_bills call is_org_admin_member(org_id). The helper joins roles, but
-- role catalog rows are not exposed to regular authenticated sessions, so the
-- helper must run as a definer.

create or replace function public.is_org_admin_member(check_org_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.memberships m
    join public.roles r on r.id = m.role_id
    where m.org_id = check_org_id
      and m.user_id = auth.uid()
      and m.status = 'active'
      and r.scope = 'org'
      and r.key in ('org_owner', 'org_admin', 'org_office_admin')
  );
$$;

comment on function public.is_org_admin_member(uuid)
  is 'Returns true when the current auth user has an active org owner/admin membership.';
