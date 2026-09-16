-- Office documents use files with no project or prospect; empty folders persist independently.
create table public.org_document_folders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  path text not null check (path ~ '^/.+' and right(path, 1) <> '/'),
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (org_id, path)
);
alter table public.org_document_folders enable row level security;
revoke all on public.org_document_folders from anon;
grant select, insert, update, delete on public.org_document_folders to authenticated, service_role;
create policy office_folders_read on public.org_document_folders for select to authenticated
  using (public.has_org_permission(org_id, 'docs.read'));
create policy office_folders_insert on public.org_document_folders for insert to authenticated
  with check (public.has_org_permission(org_id, 'docs.upload'));
create policy office_folders_update on public.org_document_folders for update to authenticated
  using (public.has_org_permission(org_id, 'docs.upload'))
  with check (public.has_org_permission(org_id, 'docs.upload'));
create policy office_folders_delete on public.org_document_folders for delete to authenticated
  using (public.has_org_permission(org_id, 'docs.delete'));

create function public.list_office_document_children(p_org_id uuid, p_parent_path text default null)
returns table(path text, name text, item_count bigint)
language sql stable security invoker set search_path = public as $$
  with sources as (
    select f.folder_path as path, true as is_file from public.files f
    where f.org_id = p_org_id and f.project_id is null and f.prospect_id is null
      and f.archived_at is null and f.folder_path is not null
    union all
    select d.path, false from public.org_document_folders d where d.org_id = p_org_id
  ), children as (
    select coalesce(p_parent_path, '') || '/' || split_part(
      substring(s.path from length(coalesce(p_parent_path, '')) + 2), '/', 1) as child_path, is_file
    from sources s
    where s.path <> coalesce(p_parent_path, '/')
      and starts_with(s.path, coalesce(p_parent_path, '') || '/')
  )
  select child_path, split_part(substring(child_path from length(coalesce(p_parent_path, '')) + 2), '/', 1),
    count(*) filter (where is_file)
  from children group by child_path order by child_path;
$$;

-- Renames and empty-folder deletion are atomic, including descendants and archived files.
create function public.mutate_office_document_folder(p_org_id uuid, p_path text, p_new_path text default null)
returns integer language plpgsql security invoker set search_path = public as $$
declare affected integer := 0;
begin
  if not public.has_org_permission(p_org_id, case when p_new_path is null then 'docs.delete' else 'docs.upload' end) then raise exception 'Forbidden'; end if;
  if p_path is null or p_path !~ '^/.+' or right(p_path, 1) = '/' then raise exception 'Invalid folder path'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':office-folders', 0));
  if p_new_path is null then
    if exists (select 1 from files where org_id = p_org_id and project_id is null and prospect_id is null
      and (folder_path = p_path or starts_with(folder_path, p_path || '/'))) then
      raise exception 'Folder is not empty (including trash)';
    end if;
    delete from org_document_folders where org_id = p_org_id and (path = p_path or starts_with(path, p_path || '/'));
  else
    if p_new_path !~ '^/.+' or right(p_new_path, 1) = '/' or starts_with(p_new_path, p_path || '/') then raise exception 'Invalid destination'; end if;
    if p_new_path = p_path then return 0; end if;
    if exists (select 1 from org_document_folders where org_id = p_org_id and (path = p_new_path or starts_with(path, p_new_path || '/')))
      or exists (select 1 from files where org_id = p_org_id and project_id is null and prospect_id is null
        and (folder_path = p_new_path or starts_with(folder_path, p_new_path || '/'))) then
      raise exception 'A folder with that name already exists';
    end if;
    update files set folder_path = p_new_path || substring(folder_path from length(p_path) + 1)
      where org_id = p_org_id and project_id is null and prospect_id is null
        and (folder_path = p_path or starts_with(folder_path, p_path || '/'));
    get diagnostics affected = row_count;
    update org_document_folders set path = p_new_path || substring(path from length(p_path) + 1)
      where org_id = p_org_id and (path = p_path or starts_with(path, p_path || '/'));
    insert into org_document_folders(org_id, path, created_by) values(p_org_id, p_new_path, auth.uid()) on conflict do nothing;
  end if;
  return affected;
end;
$$;
revoke all on function public.list_office_document_children(uuid, text) from public, anon;
revoke all on function public.mutate_office_document_folder(uuid, text, text) from public, anon;
grant execute on function public.list_office_document_children(uuid, text) to authenticated, service_role;
grant execute on function public.mutate_office_document_folder(uuid, text, text) to authenticated, service_role;

create function public.office_document_counts(p_org_id uuid)
returns table(category text, file_count bigint)
language sql stable security invoker set search_path = public as $$
  with office_files as (
    select coalesce(category, 'other') as category, archived_at, due_at from public.files
    where org_id = p_org_id and project_id is null and prospect_id is null
  )
  select category, count(*) from office_files where archived_at is null group by category
  union all select 'all', count(*) from office_files where archived_at is null
  union all select 'trash', count(*) from office_files where archived_at is not null
  union all select 'expiring', count(*) from office_files where archived_at is null and due_at <= now() + interval '30 days';
$$;
revoke all on function public.office_document_counts(uuid) from public, anon;
grant execute on function public.office_document_counts(uuid) to authenticated, service_role;
