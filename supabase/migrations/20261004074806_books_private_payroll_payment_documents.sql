-- Payment/recognition attribution proofs contain payroll details just like the
-- provider source. Preserve every original byte/version while restricting access.
create index books_private_payroll_payment_proofs_idx on public.books_payroll_payment_reviews using gin((evidence->'supporting_documents') jsonb_path_ops);
update public.files f set metadata=f.metadata||'{"books_private_kind":"payroll_register"}'::jsonb,
 visibility='private',share_with_subs=false,share_with_clients=false
where exists(select 1 from public.books_payroll_payment_reviews r where r.org_id=f.org_id
 and r.evidence->'supporting_documents' @> jsonb_build_array(jsonb_build_object('file_id',f.id)));
create function public.mark_books_private_payroll_payment_documents() returns trigger
language plpgsql security invoker set search_path=pg_catalog,public as $$
declare proof jsonb;
begin
 for proof in select value from jsonb_array_elements(new.evidence->'supporting_documents') loop
  update public.files f set metadata=f.metadata||'{"books_private_kind":"payroll_register"}'::jsonb,
   visibility='private',share_with_subs=false,share_with_clients=false
  where f.org_id=new.org_id and f.id=(proof->>'file_id')::uuid
  and exists(select 1 from public.doc_versions v where v.org_id=new.org_id and v.file_id=f.id and v.id=(proof->>'document_version_id')::uuid
   and v.storage_path=proof->>'storage_path');
  if not found then raise exception 'Private payroll payment supporting file/version is unavailable';end if;
 end loop;
 return new;
end $$;
create trigger books_private_payroll_payment_documents after insert on public.books_payroll_payment_reviews for each row execute function public.mark_books_private_payroll_payment_documents();
revoke all on function public.mark_books_private_payroll_payment_documents() from public,anon,authenticated;
create or replace function public.is_books_private_payroll_object(p_org_id uuid,p_path text) returns boolean
language sql stable security invoker set search_path=pg_catalog,public as $$
 select exists(select 1 from public.files f where f.org_id=p_org_id and f.storage_path=p_path and f.metadata->>'books_private_kind'='payroll_register')
 or exists(select 1 from public.doc_versions v join public.files f on f.org_id=v.org_id and f.id=v.file_id where v.org_id=p_org_id and v.storage_path=p_path and f.metadata->>'books_private_kind'='payroll_register')
 or exists(select 1 from public.books_payroll_imports p where p.org_id=p_org_id and p.source_proof->>'storage_path'=p_path)
 or exists(select 1 from public.books_payroll_correction_sources p where p.org_id=p_org_id and p.source_proof->>'storage_path'=p_path)
 or exists(select 1 from public.books_payroll_payment_reviews p where p.org_id=p_org_id
  and p.evidence->'supporting_documents' @> jsonb_build_array(jsonb_build_object('storage_path',p_path)));
$$;
revoke all on function public.is_books_private_payroll_object(uuid,text) from public,anon,authenticated;
grant execute on function public.is_books_private_payroll_object(uuid,text) to service_role;
