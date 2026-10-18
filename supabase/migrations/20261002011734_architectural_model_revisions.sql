-- Keep the client-visible snapshot separate from the working document.
alter table public.floorplan_models
  add column if not exists published_model jsonb,
  add column if not exists generation_id uuid,
  add column if not exists generation_stage text,
  add column if not exists source_selection jsonb;
update public.floorplan_models set published_model = model where status = 'published' and published_model is null;

create table public.floorplan_model_revisions (
  id uuid primary key default gen_random_uuid(),
  model_id uuid not null references public.floorplan_models(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  model jsonb not null,
  saved_at timestamptz not null default now(),
  created_by uuid references public.app_users(id) on delete set null
);
create index floorplan_model_revisions_lookup on public.floorplan_model_revisions(model_id, saved_at desc);
alter table public.floorplan_model_revisions enable row level security;
create policy floorplan_model_revisions_read on public.floorplan_model_revisions
for select to authenticated using (public.has_org_permission(org_id, 'plan.read'));
grant select on public.floorplan_model_revisions to authenticated;
grant all on public.floorplan_model_revisions to service_role;

create or replace function public.archive_floorplan_model_revision() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if old.model is not null and old.model is distinct from new.model then
    insert into public.floorplan_model_revisions(model_id, org_id, model, created_by)
    values(old.id, old.org_id, old.model, auth.uid());
  end if;
  return new;
end;
$$;
revoke all on function public.archive_floorplan_model_revision() from public, anon, authenticated;
create trigger archive_floorplan_model_revision before update of model on public.floorplan_models
for each row execute function public.archive_floorplan_model_revision();
