-- Warranty programs, their terms and each home's coverage are readable by the
-- org, and writable only by people who manage warranty.
--
-- The original policies were `for all` on org membership, so any member —
-- a superintendent, a sales consultant — could rewrite a program's terms or a
-- home's coverage straight through PostgREST, past the `warranty.manage` check
-- the service makes. Reads stay on membership (the desk, the portal and
-- request intake all show coverage); writes now need the same permission the
-- service checks. System writers (enrollment from the outbox, first-use
-- seeding) run as service_role, which RLS does not apply to.
--
-- A home's coverage is a snapshot taken at enrollment: the expiry of every term
-- is computed from the effective date and the program as it stood then, and
-- later program edits must never move it. The trigger makes the snapshot and
-- the facts it was computed from immutable for every writer, service_role
-- included — a correction is a new enrollment, not an edit.

drop policy if exists warranty_programs_org_access on public.warranty_programs;
create policy warranty_programs_read on public.warranty_programs
  for select to authenticated
  using (public.is_org_member(org_id));
create policy warranty_programs_insert on public.warranty_programs
  for insert to authenticated
  with check (public.has_org_permission(org_id, 'warranty.manage'));
create policy warranty_programs_update on public.warranty_programs
  for update to authenticated
  using (public.has_org_permission(org_id, 'warranty.manage'))
  with check (public.has_org_permission(org_id, 'warranty.manage'));
create policy warranty_programs_delete on public.warranty_programs
  for delete to authenticated
  using (public.has_org_permission(org_id, 'warranty.manage'));

drop policy if exists warranty_coverage_terms_org_access on public.warranty_coverage_terms;
create policy warranty_coverage_terms_read on public.warranty_coverage_terms
  for select to authenticated
  using (public.is_org_member(org_id));
create policy warranty_coverage_terms_insert on public.warranty_coverage_terms
  for insert to authenticated
  with check (public.has_org_permission(org_id, 'warranty.manage'));
create policy warranty_coverage_terms_update on public.warranty_coverage_terms
  for update to authenticated
  using (public.has_org_permission(org_id, 'warranty.manage'))
  with check (public.has_org_permission(org_id, 'warranty.manage'));
create policy warranty_coverage_terms_delete on public.warranty_coverage_terms
  for delete to authenticated
  using (public.has_org_permission(org_id, 'warranty.manage'));

drop policy if exists project_warranty_coverage_org_access on public.project_warranty_coverage;
create policy project_warranty_coverage_read on public.project_warranty_coverage
  for select to authenticated
  using (public.is_org_member(org_id));
create policy project_warranty_coverage_insert on public.project_warranty_coverage
  for insert to authenticated
  with check (public.has_org_permission(org_id, 'warranty.manage'));
create policy project_warranty_coverage_update on public.project_warranty_coverage
  for update to authenticated
  using (public.has_org_permission(org_id, 'warranty.manage'))
  with check (public.has_org_permission(org_id, 'warranty.manage'));
-- No delete policy: an enrolled home's coverage is a record, not a draft.

revoke delete on table public.project_warranty_coverage from authenticated;

create or replace function public.tg_project_warranty_coverage_snapshot_immutable()
returns trigger
language plpgsql
set search_path = public, pg_catalog
as $$
begin
  if (new.org_id, new.project_id, new.program_id, new.effective_date, new.effective_source, new.terms_snapshot)
     is distinct from
     (old.org_id, old.project_id, old.program_id, old.effective_date, old.effective_source, old.terms_snapshot) then
    raise exception 'Warranty coverage terms are fixed at enrollment and cannot be changed'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

drop trigger if exists project_warranty_coverage_snapshot_immutable on public.project_warranty_coverage;
create trigger project_warranty_coverage_snapshot_immutable
  before update on public.project_warranty_coverage
  for each row execute function public.tg_project_warranty_coverage_snapshot_immutable();
