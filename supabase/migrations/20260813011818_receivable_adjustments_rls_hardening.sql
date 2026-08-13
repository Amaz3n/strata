begin;

-- Service roles bypass RLS and retain explicit write grants. Builder users only
-- need org-scoped read access, so avoid a PUBLIC all-commands policy and the
-- deprecated per-row auth.role() check.
drop policy if exists receivable_adjustments_access on public.receivable_adjustments;
drop policy if exists receivable_adjustments_read on public.receivable_adjustments;
create policy receivable_adjustments_read
  on public.receivable_adjustments
  for select
  to authenticated
  using (public.is_org_member(org_id));

revoke all on table public.receivable_adjustments from anon;
revoke insert, update, delete on table public.receivable_adjustments from authenticated;
grant select on table public.receivable_adjustments to authenticated;
grant select, insert, update on table public.receivable_adjustments to service_role;

commit;
