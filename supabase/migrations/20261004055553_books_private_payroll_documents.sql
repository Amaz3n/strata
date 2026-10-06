-- Salary documents remain in the existing versioned archive, but outside general
-- project document access. The discriminator lives in exported file metadata.
create index books_private_payroll_file_path_idx on public.files(org_id,storage_path) where metadata->>'books_private_kind'='payroll_register';
create index books_private_payroll_version_path_idx on public.doc_versions(org_id,storage_path,file_id);
create index books_private_payroll_import_path_idx on public.books_payroll_imports(org_id,(source_proof->>'storage_path'));
create index books_private_payroll_correction_path_idx on public.books_payroll_correction_sources(org_id,(source_proof->>'storage_path'));

update public.files f set metadata=f.metadata || '{"books_private_kind":"payroll_register"}'::jsonb,visibility='private',share_with_subs=false,share_with_clients=false
where exists(select 1 from public.books_payroll_imports p where p.org_id=f.org_id and p.source_proof->>'file_id'=f.id::text)
 or exists(select 1 from public.books_payroll_correction_sources p where p.org_id=f.org_id and p.source_proof->>'file_id'=f.id::text);

create policy books_private_payroll_files on public.files as restrictive for all to anon,authenticated
 using (metadata->>'books_private_kind' is distinct from 'payroll_register')
 with check (metadata->>'books_private_kind' is distinct from 'payroll_register');
create policy books_private_payroll_versions on public.doc_versions as restrictive for all to anon,authenticated
 using (exists(select 1 from public.files f where f.org_id=doc_versions.org_id and f.id=doc_versions.file_id))
 with check (exists(select 1 from public.files f where f.org_id=doc_versions.org_id and f.id=doc_versions.file_id));
create policy books_private_payroll_links on public.file_links as restrictive for all to anon,authenticated
 using (exists(select 1 from public.files f where f.org_id=file_links.org_id and f.id=file_links.file_id))
 with check (exists(select 1 from public.files f where f.org_id=file_links.org_id and f.id=file_links.file_id));

create function public.guard_books_private_payroll_file() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if tg_op='UPDATE' and old.metadata->>'books_private_kind'='payroll_register' then
  if new.metadata->>'books_private_kind' is distinct from 'payroll_register' or
     row(new.id,new.org_id,new.storage_path,new.file_name,new.mime_type,new.size_bytes,new.checksum,new.uploaded_by)
     is distinct from row(old.id,old.org_id,old.storage_path,old.file_name,old.mime_type,old.size_bytes,old.checksum,old.uploaded_by)
     or new.project_id is distinct from old.project_id or
     (old.current_version_id is not null and new.current_version_id is distinct from old.current_version_id) then
   raise exception 'Private payroll document identity and original bytes are immutable';
  end if;
 end if;
 if new.metadata->>'books_private_kind'='payroll_register' then
  if current_user not in('postgres','service_role','supabase_admin') then raise exception 'Private payroll documents require accounting service access';end if;
  if new.visibility is distinct from 'private' or new.share_with_subs or new.share_with_clients then raise exception 'Private payroll documents cannot be shared';end if;
 end if;
 return new;
end;
$$;
create trigger books_private_payroll_file_guard before insert or update on public.files for each row execute function public.guard_books_private_payroll_file();
revoke all on function public.guard_books_private_payroll_file() from public,anon,authenticated;

create function public.mark_books_private_payroll_source() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 update public.files set metadata=metadata || '{"books_private_kind":"payroll_register"}'::jsonb,visibility='private',share_with_subs=false,share_with_clients=false
 where org_id=new.org_id and id=(new.source_proof->>'file_id')::uuid;
 if not found then raise exception 'Private payroll source file is unavailable';end if;
 return new;
end;
$$;
create trigger books_private_payroll_import_source after insert on public.books_payroll_imports for each row execute function public.mark_books_private_payroll_source();
create trigger books_private_payroll_correction_source after insert on public.books_payroll_correction_sources for each row execute function public.mark_books_private_payroll_source();
revoke all on function public.mark_books_private_payroll_source() from public,anon,authenticated;

create function public.is_books_private_payroll_object(p_org_id uuid,p_path text) returns boolean language sql stable security invoker set search_path=pg_catalog,public as $$
 select exists(select 1 from public.files f where f.org_id=p_org_id and f.storage_path=p_path and f.metadata->>'books_private_kind'='payroll_register')
 or exists(select 1 from public.doc_versions v join public.files f on f.org_id=v.org_id and f.id=v.file_id where v.org_id=p_org_id and v.storage_path=p_path and f.metadata->>'books_private_kind'='payroll_register')
 or exists(select 1 from public.books_payroll_imports p where p.org_id=p_org_id and p.source_proof->>'storage_path'=p_path)
 or exists(select 1 from public.books_payroll_correction_sources p where p.org_id=p_org_id and p.source_proof->>'storage_path'=p_path);
$$;
revoke all on function public.is_books_private_payroll_object(uuid,text) from public,anon,authenticated;
grant execute on function public.is_books_private_payroll_object(uuid,text) to service_role;

create function public.commit_books_private_payroll_document(p_org_id uuid,p_file_id uuid,p_version_id uuid,p_actor_id uuid,p_name text,p_size bigint,p_checksum text,p_path text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare f public.files;v public.doc_versions;
begin
 if p_org_id is null or p_file_id is null or p_version_id is null or p_actor_id is null or p_size is null or p_size not between 1 and 16777216
 or p_checksum is null or p_checksum !~ '^[a-f0-9]{64}$' or p_name is null or length(p_name) not between 1 and 200 or p_name !~* '\.csv$'
 or p_path is distinct from p_org_id::text||'/books/payroll-private/'||p_file_id::text||'/source.csv' then raise exception 'Invalid private payroll document';end if;
 if not exists(select 1 from public.memberships m where m.org_id=p_org_id and m.user_id=p_actor_id and m.status='active') then raise exception 'Private payroll upload requires active organization actor';end if;
 perform pg_advisory_xact_lock(hashtextextended('private-payroll-file:'||p_org_id::text||':'||p_file_id::text,0));
 select * into f from public.files where org_id=p_org_id and id=p_file_id;
 if found then
  select * into v from public.doc_versions where org_id=p_org_id and id=p_version_id and file_id=p_file_id;
  if not found or f.current_version_id is distinct from p_version_id or f.metadata->>'books_private_kind' is distinct from 'payroll_register'
   or row(f.uploaded_by,f.storage_path,f.file_name,f.size_bytes,f.checksum) is distinct from row(p_actor_id,p_path,p_name,p_size,p_checksum)
   or row(v.storage_path,v.file_name,v.size_bytes,v.checksum) is distinct from row(p_path,p_name,p_size,p_checksum) then raise exception 'Private payroll upload identity belongs to different original bytes or actor';end if;
 else
  insert into public.files(id,org_id,project_id,file_name,storage_path,mime_type,size_bytes,checksum,visibility,uploaded_by,category,source,metadata)
  values(p_file_id,p_org_id,null,p_name,p_path,'text/csv',p_size,p_checksum,'private',p_actor_id,'financials','import','{"books_private_kind":"payroll_register"}');
  insert into public.doc_versions(id,org_id,file_id,version_number,storage_path,file_name,mime_type,size_bytes,checksum,created_by)
  values(p_version_id,p_org_id,p_file_id,1,p_path,p_name,'text/csv',p_size,p_checksum,p_actor_id);
  update public.files set current_version_id=p_version_id where org_id=p_org_id and id=p_file_id;
 end if;
 return jsonb_build_object('fileId',p_file_id,'documentVersionId',p_version_id,'fileName',p_name,'sizeBytes',p_size,'checksum',p_checksum);
end;
$$;
revoke all on function public.commit_books_private_payroll_document(uuid,uuid,uuid,uuid,text,bigint,text,text) from public,anon,authenticated;
grant execute on function public.commit_books_private_payroll_document(uuid,uuid,uuid,uuid,text,bigint,text,text) to service_role;
