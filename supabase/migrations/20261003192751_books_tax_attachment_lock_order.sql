-- Row triggers execute after a writer may already own the file/version tuple.
-- Never wait for the evidence mutex from this reverse lock order: fail with
-- retryable serialization status instead. The transaction is rolled back, so
-- no partial metadata/history can survive a contended operation. Preparation
-- uses the same nonwaiting lock, including workpapers with multiple files.
create or replace function public.guard_books_tax_attachment_evidence() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare item jsonb; proof jsonb; source public.files; version_id uuid;
begin
 if tg_op='UPDATE' and new.status<>'approved' then return new; end if;
 for item in select value from jsonb_array_elements(new.lines) loop
  proof:=item->'evidence_snapshot';
  if item->>'evidence_file_id' is null then
   if proof is not null and proof<>'null'::jsonb then raise exception 'Tax attachment requires referenced file'; end if;
   continue;
  end if;
  if not exists(select 1 from public.files where org_id=new.org_id and id=(item->>'evidence_file_id')::uuid) then raise exception 'Tax adjustment evidence file is outside organization'; end if;
  if jsonb_typeof(proof) is distinct from 'object' or proof->>'version' is distinct from '1'
   or proof->>'org_id' is distinct from new.org_id::text or proof->>'file_id' is distinct from item->>'evidence_file_id'
   or coalesce(proof->>'checksum','') !~ '^[a-f0-9]{64}$' or coalesce(length(proof->>'file_name'),0)=0
   or jsonb_typeof(proof->'size_bytes') is distinct from 'number'
   or not (proof ? 'document_version_id') or not (proof ? 'mime_type')
   or left(coalesce(proof->>'storage_path',''),length(new.org_id::text)+1)<>new.org_id::text||'/'
   or proof->>'storage_path' ~ '(^|/)\.\.?(/|$)' or strpos(proof->>'storage_path',chr(92))>0 or strpos(proof->>'storage_path','//')>0 then
   raise exception 'Tax attachment requires frozen scoped version, path, exact size and checksum evidence';
  end if;
  if (proof->>'size_bytes')::numeric<0 or (proof->>'size_bytes')::numeric>9007199254740991 or (proof->>'size_bytes')::numeric<>trunc((proof->>'size_bytes')::numeric) then raise exception 'Tax attachment requires exact safe byte size'; end if;
  version_id:=(proof->>'document_version_id')::uuid;
  if tg_op='INSERT' then
   if not pg_try_advisory_xact_lock(hashtextextended('tax-attachment:'||new.org_id::text||':'||(item->>'evidence_file_id'),0)) then raise exception 'Document evidence is changing concurrently; retry the operation' using errcode='40001'; end if;
   select * into source from public.files where org_id=new.org_id and id=(item->>'evidence_file_id')::uuid for share;
   if not found or source.current_version_id is distinct from version_id or source.storage_path is distinct from proof->>'storage_path'
    or source.file_name is distinct from proof->>'file_name' or source.mime_type is distinct from proof->>'mime_type'
    or source.checksum is distinct from proof->>'checksum' or source.size_bytes is distinct from (proof->>'size_bytes')::bigint then
    raise exception 'Tax attachment file metadata changed before preparation';
   end if;
   if version_id is not null then
    perform 1 from public.doc_versions where id=version_id and org_id=new.org_id and file_id=source.id and storage_path=source.storage_path and checksum=source.checksum and size_bytes=source.size_bytes for share;
    if not found then raise exception 'Tax attachment document version mismatch'; end if;
   end if;
  end if;
 end loop;
 return new;
end $$;
revoke all on function public.guard_books_tax_attachment_evidence() from public,anon,authenticated;

create or replace function public.protect_books_tax_document_evidence() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if tg_table_name='files' then
  if not pg_try_advisory_xact_lock(hashtextextended('tax-attachment:'||old.org_id::text||':'||old.id::text,0)) then raise exception 'Document evidence is changing concurrently; retry the operation' using errcode='40001'; end if;
 else
  if not pg_try_advisory_xact_lock(hashtextextended('tax-attachment:'||old.org_id::text||':'||old.file_id::text,0)) then raise exception 'Document evidence is changing concurrently; retry the operation' using errcode='40001'; end if;
 end if;
 if tg_table_name='files' then
  if exists(select 1 from public.books_tax_adjustment_workpapers where org_id=old.org_id and lines @> jsonb_build_array(jsonb_build_object('evidence_file_id',old.id))) then
   if tg_op='DELETE' then raise exception 'Tax workpaper document history cannot be deleted'; end if;
   if new.id is distinct from old.id or new.org_id is distinct from old.org_id then raise exception 'Tax workpaper document history identity is immutable'; end if;
   if new.storage_path is not distinct from old.storage_path and (new.checksum is distinct from old.checksum or new.size_bytes is distinct from old.size_bytes)
    and exists(select 1 from public.books_tax_adjustment_workpapers where org_id=old.org_id and lines @> jsonb_build_array(jsonb_build_object('evidence_file_id',old.id,'evidence_snapshot',jsonb_build_object('storage_path',old.storage_path)))) then
    raise exception 'Tax workpaper original object metadata is immutable';
   end if;
   if new.storage_path is distinct from old.storage_path and not exists(select 1 from public.doc_versions where org_id=old.org_id and file_id=old.id and storage_path=old.storage_path and checksum=old.checksum and size_bytes=old.size_bytes) then raise exception 'Missing retained original tax document version'; end if;
  end if;
 else
  if tg_op='UPDATE' and to_jsonb(new)-array['label','notes'] is not distinct from to_jsonb(old)-array['label','notes'] then return new; end if;
  if exists(select 1 from public.books_tax_adjustment_workpapers where org_id=old.org_id and (lines @> jsonb_build_array(jsonb_build_object('evidence_snapshot',jsonb_build_object('document_version_id',old.id))) or lines @> jsonb_build_array(jsonb_build_object('evidence_file_id',old.file_id,'evidence_snapshot',jsonb_build_object('storage_path',old.storage_path))))) then raise exception 'Tax workpaper document version evidence is immutable'; end if;
 end if;
 if tg_op='DELETE' then return old; end if;
 return new;
end $$;
revoke all on function public.protect_books_tax_document_evidence() from public,anon,authenticated;
