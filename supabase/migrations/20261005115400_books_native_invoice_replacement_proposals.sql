-- Pending: explicit v2 replacement intent and complete paired preparation.
-- Existing six-field reversal-only proposals and exact retries retain their meaning.
begin;
alter table public.books_native_invoice_correction_proposals drop constraint books_native_invoice_correction_proposals_request_text_check;
alter table public.books_native_invoice_correction_proposals add constraint books_native_invoice_correction_request_size check(octet_length(request_text)<=16800000);
create or replace function public.books_validate_native_invoice_correction_request(q jsonb,p_org uuid,p_entity uuid,p_project uuid,p_actor uuid)
returns uuid language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare k text;v text;c jsonb:=q->'context';keys text[]:=array['id','expectedOrgId','expectedActorId','context','originalPostingId','notes'];max_bytes integer:=8400000;
begin
 if q ? 'protocolVersion' then
  if q->'protocolVersion' is distinct from '2'::jsonb or q->>'intent' is distinct from 'replace' or jsonb_typeof(q->'baseEconomic') is distinct from 'object' or q->'baseEconomic'->'native' is distinct from c then raise exception 'Explicit replacement intent and identical original economic context are required';end if;
  keys:=keys||array['protocolVersion','intent','baseEconomic','patch'];max_bytes:=16800000;
 end if;
 if jsonb_typeof(q) is distinct from 'object' or octet_length(q::text)>max_bytes or q-keys<>'{}' or (select count(*) from jsonb_object_keys(q))<>cardinality(keys) then raise exception 'Canonical bounded native correction request is required';end if;
 foreach k in array array['id','expectedOrgId','expectedActorId','originalPostingId'] loop v:=q->>k;if jsonb_typeof(q->k) is distinct from 'string' or v::uuid::text is distinct from v then raise exception 'Canonical native correction UUID is required';end if;end loop;
 if (q->>'expectedOrgId',q->>'expectedActorId',c->>'orgId',c->>'actorId',c->'owner'->>'legal_entity_id',c->>'projectId',c->>'sourceType') is distinct from(p_org::text,p_actor::text,p_org::text,p_actor::text,p_entity::text,p_project::text,'invoice') then raise exception 'Native correction request differs from original scope or actor';end if;
 if jsonb_typeof(q->'notes') is distinct from 'string' or length(q->>'notes') not between 10 and 2000 or q->>'notes'<>btrim(q->>'notes') then raise exception 'Native correction explanation is required';end if;
 return (q->>'id')::uuid;
end $$;
create or replace function public.books_native_invoice_correction_proposal_guard()
returns trigger language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare q jsonb:=new.request_text::jsonb;d jsonb;r jsonb;c jsonb;
begin
 if public.books_validate_native_invoice_correction_request(q,new.org_id,new.legal_entity_id,new.project_id,new.prepared_by) is distinct from new.id then raise exception 'Native correction proposal identity differs';end if;
 if q ? 'protocolVersion' then
  d:=public.books_derive_native_invoice_correction_pair(new.org_id,new.legal_entity_id,new.project_id,new.prepared_by,new.id,(q->>'originalPostingId')::uuid,q->'baseEconomic',q->'patch',q->>'notes');r:=d->'reversal';
 else d:=public.books_derive_native_invoice_reversal(new.org_id,new.legal_entity_id,new.project_id,new.prepared_by,new.id,(q->>'originalPostingId')::uuid,q->'context',q->>'notes');r:=d;end if;
 c:=r->'validatedContext';
 new.invoice_id:=(c->>'sourceId')::uuid;new.original_posting_id:=(r->'originalPosting'->>'id')::uuid;new.original_entry_id:=(r->'originalPosting'->>'entry_id')::uuid;
 new.owner_review_id:=(c->'owner'->>'id')::uuid;new.chart_id:=(c->'chart'->>'id')::uuid;new.period_id:=(c->'period'->>'id')::uuid;new.entry_date:=(c->>'entryDate')::date;
 new.request_text:=q::text;new.request_sha256:=encode(sha256(convert_to(new.request_text,'UTF8')),'hex');new.derivation_text:=d::text;new.derivation_sha256:=encode(sha256(convert_to(new.derivation_text,'UTF8')),'hex');new.prepared_at:=clock_timestamp();
 select id into new.prepared_access_event_id from public.books_legal_entity_access_history where org_id=new.org_id and legal_entity_id=new.legal_entity_id and user_id=new.prepared_by order by sequence_no desc limit 1;
 return new;
end $$;
revoke all on function public.books_validate_native_invoice_correction_request(jsonb,uuid,uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function public.books_validate_native_invoice_correction_request(jsonb,uuid,uuid,uuid,uuid) to service_role;
revoke all on function public.books_native_invoice_correction_proposal_guard() from public,anon,authenticated;
grant execute on function public.books_native_invoice_correction_proposal_guard() to service_role;
commit;
