-- Wave 2 WS-D: canonical project specifications register and append-only revisions.

create table public.spec_uploads (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  file_id uuid not null references public.files(id),
  status text not null default 'pending' check (status in ('pending', 'processing', 'complete', 'failed')),
  sections_detected integer check (sections_detected is null or sections_detected >= 0),
  error text,
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.spec_sections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  division text not null check (division ~ '^\d{2}$'),
  section_number text not null check (section_number ~ '^\d{2} [0-9]{2} [0-9]{2}$'),
  title text not null check (length(btrim(title)) > 0),
  current_revision_id uuid,
  is_deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, section_number)
);

create table public.spec_revisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  project_id uuid not null references public.projects(id),
  section_id uuid not null references public.spec_sections(id),
  revision_number integer not null check (revision_number > 0),
  source_upload_id uuid references public.spec_uploads(id),
  file_id uuid not null references public.files(id),
  page_start integer check (page_start is null or page_start > 0),
  page_end integer check (page_end is null or page_end > 0),
  extracted_text text,
  issued_date date,
  created_by uuid references public.app_users(id),
  created_at timestamptz not null default now(),
  unique (section_id, revision_number),
  check (page_start is null or page_end is null or page_end >= page_start)
);

alter table public.spec_sections
  add constraint spec_sections_current_revision_id_fkey foreign key (current_revision_id) references public.spec_revisions(id);
alter table public.submittals
  add column spec_section_id uuid references public.spec_sections(id);

create index spec_uploads_org_project_idx on public.spec_uploads (org_id, project_id, created_at desc);
create index spec_uploads_file_idx on public.spec_uploads (file_id);
create index spec_uploads_pending_idx on public.spec_uploads (status, created_at) where status in ('pending', 'processing');
create index spec_sections_org_project_idx on public.spec_sections (org_id, project_id, division, section_number) where is_deleted = false;
create index spec_sections_current_revision_idx on public.spec_sections (current_revision_id) where current_revision_id is not null;
create index spec_revisions_org_project_idx on public.spec_revisions (org_id, project_id, created_at desc);
create index spec_revisions_section_idx on public.spec_revisions (section_id, revision_number desc);
create index spec_revisions_upload_idx on public.spec_revisions (source_upload_id) where source_upload_id is not null;
create unique index spec_revisions_upload_section_unique_idx on public.spec_revisions (source_upload_id, section_id) where source_upload_id is not null;
create index spec_revisions_file_idx on public.spec_revisions (file_id);
create index submittals_spec_section_idx on public.submittals (spec_section_id) where spec_section_id is not null;

create trigger spec_uploads_set_updated_at before update on public.spec_uploads for each row execute function public.tg_set_updated_at();
create trigger spec_sections_set_updated_at before update on public.spec_sections for each row execute function public.tg_set_updated_at();

alter table public.spec_uploads enable row level security;
alter table public.spec_sections enable row level security;
alter table public.spec_revisions enable row level security;
create policy spec_uploads_read on public.spec_uploads for select to authenticated
  using (exists (select 1 from public.memberships m where m.org_id = spec_uploads.org_id and m.user_id = (select auth.uid()) and m.status = 'active'));
create policy spec_uploads_insert on public.spec_uploads for insert to authenticated
  with check (public.has_org_permission(org_id, 'spec.write'));
create policy spec_uploads_update on public.spec_uploads for update to authenticated
  using (public.has_org_permission(org_id, 'spec.write')) with check (public.has_org_permission(org_id, 'spec.write'));
create policy spec_uploads_delete on public.spec_uploads for delete to authenticated
  using (public.has_org_permission(org_id, 'spec.write'));

create policy spec_sections_read on public.spec_sections for select to authenticated
  using (exists (select 1 from public.memberships m where m.org_id = spec_sections.org_id and m.user_id = (select auth.uid()) and m.status = 'active'));
create policy spec_sections_insert on public.spec_sections for insert to authenticated
  with check (public.has_org_permission(org_id, 'spec.write'));
create policy spec_sections_update on public.spec_sections for update to authenticated
  using (public.has_org_permission(org_id, 'spec.write')) with check (public.has_org_permission(org_id, 'spec.write'));
create policy spec_sections_delete on public.spec_sections for delete to authenticated
  using (public.has_org_permission(org_id, 'spec.write'));

create policy spec_revisions_read on public.spec_revisions for select to authenticated
  using (exists (select 1 from public.memberships m where m.org_id = spec_revisions.org_id and m.user_id = (select auth.uid()) and m.status = 'active'));
create policy spec_revisions_insert on public.spec_revisions for insert to authenticated
  with check (public.has_org_permission(org_id, 'spec.write'));
create policy spec_revisions_update on public.spec_revisions for update to authenticated
  using (public.has_org_permission(org_id, 'spec.write')) with check (public.has_org_permission(org_id, 'spec.write'));
create policy spec_revisions_delete on public.spec_revisions for delete to authenticated
  using (public.has_org_permission(org_id, 'spec.write'));

grant select, insert, update, delete on public.spec_uploads, public.spec_sections, public.spec_revisions to authenticated;
grant all on public.spec_uploads, public.spec_sections, public.spec_revisions to service_role;

create or replace function public.append_spec_revision(
  p_org_id uuid, p_project_id uuid, p_division text, p_section_number text, p_title text,
  p_source_upload_id uuid, p_file_id uuid, p_page_start integer, p_page_end integer,
  p_extracted_text text, p_issued_date date, p_created_by uuid
) returns table(section_id uuid, revision_id uuid, revision_number integer)
language plpgsql security invoker set search_path = public, pg_catalog as $$
declare v_section_id uuid; v_revision_id uuid; v_revision_number integer;
begin
  if coalesce((select auth.jwt() ->> 'role'), '') <> 'service_role'
     and not public.has_org_permission(p_org_id, 'spec.write') then
    raise exception 'Insufficient permission';
  end if;
  if not exists (select 1 from public.projects p where p.id = p_project_id and p.org_id = p_org_id) then
    raise exception 'Project not found';
  end if;
  if not exists (select 1 from public.files f where f.id = p_file_id and f.org_id = p_org_id and f.project_id = p_project_id) then
    raise exception 'Specification file does not belong to the project';
  end if;
  if p_source_upload_id is not null and not exists (
    select 1 from public.spec_uploads u
    where u.id = p_source_upload_id and u.org_id = p_org_id and u.project_id = p_project_id
  ) then
    raise exception 'Specification upload does not belong to the project';
  end if;

  insert into public.spec_sections (org_id, project_id, division, section_number, title)
  values (p_org_id, p_project_id, p_division, p_section_number, btrim(p_title))
  on conflict (project_id, section_number) do update set title = excluded.title, is_deleted = false
  where spec_sections.org_id = excluded.org_id
  returning id into v_section_id;
  if v_section_id is null then raise exception 'Specification section belongs to another organization'; end if;

  perform 1 from public.spec_sections where id = v_section_id for update;
  if p_source_upload_id is not null then
    select r.id, r.revision_number into v_revision_id, v_revision_number
    from public.spec_revisions r where r.source_upload_id = p_source_upload_id and r.section_id = v_section_id;
    if v_revision_id is not null then
      return query select v_section_id, v_revision_id, v_revision_number;
      return;
    end if;
  end if;

  select coalesce(max(r.revision_number), 0) + 1 into v_revision_number
  from public.spec_revisions r where r.section_id = v_section_id;
  insert into public.spec_revisions (
    org_id, project_id, section_id, revision_number, source_upload_id, file_id,
    page_start, page_end, extracted_text, issued_date, created_by
  ) values (
    p_org_id, p_project_id, v_section_id, v_revision_number, p_source_upload_id, p_file_id,
    p_page_start, p_page_end, p_extracted_text, p_issued_date, p_created_by
  ) returning id into v_revision_id;
  update public.spec_sections set current_revision_id = v_revision_id where id = v_section_id;
  return query select v_section_id, v_revision_id, v_revision_number;
end;
$$;
grant execute on function public.append_spec_revision(uuid,uuid,text,text,text,uuid,uuid,integer,integer,text,date,uuid) to authenticated, service_role;

insert into public.permissions (key, description) values ('spec.write', 'Upload project manuals and manage specification sections')
on conflict (key) do update set description = excluded.description;
insert into public.role_permissions (role_id, permission_key)
select id, 'spec.write' from public.roles
where key in ('org_owner', 'org_admin', 'org_office_admin', 'org_project_lead', 'pm')
on conflict (role_id, permission_key) do nothing;
