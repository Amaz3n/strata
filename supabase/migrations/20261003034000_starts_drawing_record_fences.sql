-- STAGED, UNAPPLIED. Database drawing/file ownership only: R2 writes and
-- drawing processor fanout still need their own durable ownership protocol.
create function public.fence_starts_drawing_record_write() returns trigger
language plpgsql set search_path=public,pg_catalog as $$
declare v_headers jsonb; v_pkg public.start_packages%rowtype; v_rows jsonb[]; v_row jsonb;
 v_project uuid; v_version uuid; v_source uuid; v_expected_source uuid; v_path text; v_position integer:=0;
begin
 v_headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
 if v_headers->>'x-starts-job-id' is null and v_headers->>'x-starts-claim-token' is null then
   if tg_op='DELETE' then return old; end if; return new;
 end if;
 if current_user in ('anon','authenticated') then raise exception 'Browser cannot use starts worker headers' using errcode='42501'; end if;
 if tg_op='INSERT' then v_rows:=array[to_jsonb(new)];
 elsif tg_op='DELETE' then v_rows:=array[to_jsonb(old)];
 else v_rows:=array[to_jsonb(old),to_jsonb(new)]; end if;
 v_pkg:=public.lock_starts_release_write_scope((v_rows[1]->>'org_id')::uuid);
 foreach v_row in array v_rows loop
   v_position:=v_position+1;
   if (v_row->>'org_id')::uuid is distinct from v_pkg.org_id or v_pkg.project_id is null
     or (v_row->>'project_id')::uuid is distinct from v_pkg.project_id then
     raise exception 'Starts drawing home mismatch' using errcode='42501';
   end if;
   if tg_table_name='files' then
     v_version:=(v_row->'metadata'->>'source_plan_version_id')::uuid;
     v_source:=(v_row->'metadata'->>'source_file_id')::uuid;
     if v_version is distinct from public.starts_release_plan_version(v_pkg) or v_version is null then raise exception 'Starts drawing plan mismatch' using errcode='42501'; end if;
     select (bundle_snapshot->>'drawing_source_file_id')::uuid into v_expected_source from public.house_plan_versions
       where org_id=v_pkg.org_id and id=v_version and status in ('released','superseded') for share;
     if not found or v_expected_source is null or v_source is distinct from v_expected_source then raise exception 'Starts drawing source snapshot mismatch' using errcode='42501'; end if;
     perform 1 from public.files where org_id=v_pkg.org_id and id=v_source for share;
     if not found then raise exception 'Starts drawing source file missing' using errcode='42501'; end if;
     v_path:=v_row->>'storage_path';
     if v_path is null or left(v_path,length(v_pkg.org_id::text||'/projects/'||v_pkg.project_id::text||'/plans/'||v_version::text||'/'))
         <>v_pkg.org_id::text||'/projects/'||v_pkg.project_id::text||'/plans/'||v_version::text||'/'
       or '..'=any(string_to_array(v_path,'/'))
       or v_row->>'source' is distinct from 'generated' or v_row->>'visibility' is distinct from 'private'
       or v_row->>'category' is distinct from 'plans' then raise exception 'Starts drawing file destination mismatch' using errcode='42501'; end if;
   else
     select project_id into v_project from public.files where org_id=v_pkg.org_id and id=(v_row->>'source_file_id')::uuid for share;
     if not found or v_project is distinct from v_pkg.project_id then raise exception 'Starts drawing project file mismatch' using errcode='42501'; end if;
     -- Existing canonical sets may still point to a manually uploaded PDF.
     -- Preserve that old ancestry check while requiring the new source to be
     -- the claimed plan's generated file, rather than any file in the home.
     if tg_op='INSERT' or (tg_op='UPDATE' and v_position=2) then
       perform 1 from public.files f join public.house_plan_versions v on v.org_id=f.org_id and v.id=public.starts_release_plan_version(v_pkg)
         where f.org_id=v_pkg.org_id and f.id=(v_row->>'source_file_id')::uuid
           and f.metadata->>'source_plan_version_id'=v.id::text
           and f.metadata->>'source_file_id'=v.bundle_snapshot->>'drawing_source_file_id'
           and f.source='generated' and f.category='plans' and f.visibility='private' for share of f,v;
       if not found then raise exception 'Starts drawing generated source mismatch' using errcode='42501'; end if;
     end if;
     if tg_table_name='drawing_revisions' then
       select project_id into v_project from public.drawing_sets where org_id=v_pkg.org_id and id=(v_row->>'drawing_set_id')::uuid for share;
       if not found or v_project is distinct from v_pkg.project_id then raise exception 'Starts drawing set mismatch' using errcode='42501'; end if;
     end if;
   end if;
 end loop;
 if tg_op='DELETE' then return old; end if; return new;
end $$;
do $$ declare v_table text; begin
 foreach v_table in array array['files','drawing_sets','drawing_revisions'] loop
   execute format('create trigger starts_drawing_record_worker_fence before insert or update or delete on public.%I for each row execute function public.fence_starts_drawing_record_write()',v_table);
 end loop;
end $$;
revoke all on function public.fence_starts_drawing_record_write() from public,anon,authenticated;
