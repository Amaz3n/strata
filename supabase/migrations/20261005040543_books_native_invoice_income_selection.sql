-- Pending: reviewed entity-chart income selections, atomic source coding and exact retries.
begin;
create table public.books_native_invoice_income_selections(
 id uuid primary key,org_id uuid not null references public.orgs(id),legal_entity_id uuid not null,
 project_id uuid not null,invoice_id uuid not null,actor_id uuid not null references public.app_users(id),
 owner_review_id uuid not null,chart_id uuid not null,period_id uuid not null,
 request_text text not null check(octet_length(request_text)<=8400000),request_sha256 text not null check(request_sha256 ~ '^[a-f0-9]{64}$'),
 result_text text not null check(octet_length(result_text)<=8400000),result_sha256 text not null check(result_sha256 ~ '^[a-f0-9]{64}$'),
 selected_at timestamptz not null,access_event_id uuid not null,selection_revision bigint not null check(selection_revision between 1 and 9007199254740991),
 unique(org_id,legal_entity_id,invoice_id,selection_revision),
 unique(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id) references public.books_legal_entities(org_id,id),
 foreign key(org_id,project_id) references public.projects(org_id,id),foreign key(org_id,invoice_id) references public.invoices(org_id,id),
 foreign key(org_id,legal_entity_id,project_id,owner_review_id) references public.books_project_entity_reviews(org_id,legal_entity_id,project_id,id),
 foreign key(org_id,legal_entity_id,chart_id) references public.books_entity_chart_versions(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id,period_id) references public.books_entity_fiscal_periods(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id,access_event_id) references public.books_legal_entity_access_history(org_id,legal_entity_id,id)
);
create index books_native_invoice_income_scope on public.books_native_invoice_income_selections(org_id,legal_entity_id,invoice_id);
create index books_native_invoice_income_owner on public.books_native_invoice_income_selections(org_id,legal_entity_id,project_id,owner_review_id);
create index books_native_invoice_income_chart on public.books_native_invoice_income_selections(org_id,legal_entity_id,chart_id);
create index books_native_invoice_income_period on public.books_native_invoice_income_selections(org_id,legal_entity_id,period_id);
create index books_native_invoice_income_actor on public.books_native_invoice_income_selections(actor_id);
create index books_native_invoice_income_access on public.books_native_invoice_income_selections(org_id,legal_entity_id,access_event_id);
create function public.books_validate_native_invoice_income_request(q jsonb,p_org uuid,p_entity uuid,p_project uuid,p_actor uuid)
returns uuid language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare c jsonb:=q->'economic'->'native';v text;k text;a jsonb;allowed text[]:=array['id','expectedOrgId','expectedActorId','economic','assignments','notes'];
begin
 if jsonb_typeof(q) is distinct from 'object' or octet_length(q::text)>8400000 or q-allowed<>'{}' or (select count(*) from jsonb_object_keys(q))<>6 then raise exception 'Canonical native invoice income request is required';end if;
 foreach k in array array['id','expectedOrgId','expectedActorId'] loop v:=q->>k;if jsonb_typeof(q->k) is distinct from 'string' or v::uuid::text is distinct from v then raise exception 'Canonical native invoice income UUID is required';end if;end loop;
 if jsonb_typeof(q->'economic') is distinct from 'object' or (q->>'expectedOrgId',q->>'expectedActorId',c->>'orgId',c->>'actorId',c->>'projectId',c->'owner'->>'legal_entity_id',c->>'sourceType') is distinct from(p_org::text,p_actor::text,p_org::text,p_actor::text,p_project::text,p_entity::text,'invoice') then raise exception 'Native invoice income request differs from entity/project/actor scope';end if;
 v:=c->>'sourceId';if jsonb_typeof(c->'sourceId') is distinct from 'string' or v::uuid::text is distinct from v then raise exception 'Canonical native invoice source is required';end if;
 v:=q->>'notes';if jsonb_typeof(q->'notes') is distinct from 'string' or v is distinct from btrim(v) or length(v) not between 10 and 2000 then raise exception 'Canonical native income selection explanation is required';end if;
 if jsonb_typeof(q->'assignments') is distinct from 'array' or jsonb_array_length(q->'assignments') not between 1 and 1000 then raise exception 'Complete native income assignment inventory is required';end if;
 for a in select value from jsonb_array_elements(q->'assignments') loop
  if jsonb_typeof(a) is distinct from 'object' or a-array['lineId','accountId']<>'{}' or (select count(*) from jsonb_object_keys(a))<>2 then raise exception 'Canonical income assignment is required';end if;
  v:=a->>'lineId';if jsonb_typeof(a->'lineId') is distinct from 'string' or v::uuid::text is distinct from v then raise exception 'Canonical income line identity is required';end if;
  v:=a->>'accountId';if a->'accountId'<>'null'::jsonb and (jsonb_typeof(a->'accountId') is distinct from 'string' or v::uuid::text is distinct from v) then raise exception 'Canonical income account identity is required';end if;
 end loop;
 if (select count(distinct value->>'lineId') from jsonb_array_elements(q->'assignments'))<>jsonb_array_length(q->'assignments') then raise exception 'Duplicate native income line assignment';end if;
 return(q->>'id')::uuid;
end $$;
create function public.books_native_invoice_income_selection_guard()
returns trigger language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare q jsonb:=new.request_text::jsonb;c jsonb:=q->'economic'->'native';fresh jsonb;result jsonb;a jsonb;account jsonb;row_count integer;expected_count integer;
begin
 if public.books_validate_native_invoice_income_request(q,new.org_id,new.legal_entity_id,new.project_id,new.actor_id) is distinct from new.id or (c->>'sourceId')::uuid is distinct from new.invoice_id then raise exception 'Native income receipt differs from request';end if;
 perform public.books_lock_native_invoice_request(new.org_id,new.legal_entity_id,new.project_id,new.actor_id,new.invoice_id,new.id);
 if exists(select 1 from public.books_native_invoice_postings where org_id=new.org_id and invoice_id=new.invoice_id) then raise exception 'Posted native invoice income requires governed reversal/replacement';end if;
 fresh:=public.books_validate_native_invoice_posting(new.org_id,new.legal_entity_id,new.project_id,new.actor_id,q->'economic');c:=fresh->'native';
 select count(*) into expected_count from public.invoice_lines where org_id=new.org_id and invoice_id=new.invoice_id and coalesce(metadata->>'system_generated_kind','')<>'retainage_hold';
 if expected_count<>jsonb_array_length(q->'assignments') then raise exception 'Income selection must cover every priced invoice line';end if;
 for a in select value from jsonb_array_elements(q->'assignments') loop
  if a->'accountId'='null'::jsonb then
   select value into account from jsonb_array_elements(c->'accounts') where value->>'code'=(c->'chart'->>'definition_text')::jsonb->'controls'->>'constructionRevenue';
  else select value into account from jsonb_array_elements(c->'accounts') where value->>'id'=a->>'accountId';end if;
  if account is null or account->'definition'->>'account_type' is distinct from 'income' then raise exception 'Income selection must belong to the reviewed native entity income chart';end if;
  update public.invoice_lines set metadata=(coalesce(metadata,'{}'::jsonb)-array['arc_books_gl_account_id','arc_books_entity_account_id'])||case when a->'accountId'='null'::jsonb then '{}'::jsonb else jsonb_build_object('arc_books_entity_account_id',a->'accountId') end||jsonb_build_object('arc_books_entity_income_selection_id',new.id)
   where org_id=new.org_id and invoice_id=new.invoice_id and id=(a->>'lineId')::uuid and coalesce(metadata->>'system_generated_kind','')<>'retainage_hold';
  get diagnostics row_count=row_count;if row_count<>1 then raise exception 'Income line is missing or belongs to another invoice';end if;
 end loop;
 result:=public.read_books_native_invoice_economic_context(new.org_id,new.project_id,'invoice',new.invoice_id,new.actor_id,(c->>'entryDate')::date);
 select coalesce(max(selection_revision),0)+1 into new.selection_revision from public.books_native_invoice_income_selections where org_id=new.org_id and legal_entity_id=new.legal_entity_id and invoice_id=new.invoice_id;
 new.owner_review_id:=(c->'owner'->>'id')::uuid;new.chart_id:=(c->'chart'->>'id')::uuid;new.period_id:=(c->'period'->>'id')::uuid;
 new.request_text:=q::text;new.request_sha256:=encode(sha256(convert_to(new.request_text,'UTF8')),'hex');new.result_text:=result::text;new.result_sha256:=encode(sha256(convert_to(new.result_text,'UTF8')),'hex');new.selected_at:=clock_timestamp();
 select id into new.access_event_id from public.books_legal_entity_access_history where org_id=new.org_id and legal_entity_id=new.legal_entity_id and user_id=new.actor_id order by sequence_no desc limit 1;
 return new;
end $$;
create trigger books_native_invoice_income_selection_guard before insert on public.books_native_invoice_income_selections for each row execute function public.books_native_invoice_income_selection_guard();
create trigger books_native_invoice_income_selection_immutable before update or delete on public.books_native_invoice_income_selections for each row execute function public.books_entity_immutable();
create function public.select_books_native_invoice_income(p_org uuid,p_entity uuid,p_project uuid,p_actor uuid,p_request jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare target uuid;c jsonb:=p_request->'economic'->'native';r public.books_native_invoice_income_selections;created boolean:=false;
begin
 target:=public.books_validate_native_invoice_income_request(p_request,p_org,p_entity,p_project,p_actor);
 perform public.books_lock_native_invoice_request(p_org,p_entity,p_project,p_actor,(c->>'sourceId')::uuid,target);
 select * into r from public.books_native_invoice_income_selections where id=target;
 if r.id is not null then
  if (r.org_id,r.legal_entity_id,r.project_id,r.actor_id,r.invoice_id) is distinct from(p_org,p_entity,p_project,p_actor,(c->>'sourceId')::uuid) or r.request_text::jsonb is distinct from p_request then raise exception 'Income selection identity is bound to its original request';end if;
 else
  insert into public.books_native_invoice_income_selections(id,org_id,legal_entity_id,project_id,invoice_id,actor_id,request_text)
   values(target,p_org,p_entity,p_project,(c->>'sourceId')::uuid,p_actor,p_request::text) returning * into r;created:=true;
 end if;
 return jsonb_build_object('selection',to_jsonb(r),'created',created,'coded',true,'posted',false,'ledgerActivated',false);
end $$;
alter table public.books_native_invoice_income_selections enable row level security;
revoke all on public.books_native_invoice_income_selections from public,anon,authenticated,service_role;
grant select,insert on public.books_native_invoice_income_selections to service_role;
create function public.books_native_invoice_income_posting_guard()
returns trigger language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare e jsonb:=new.request_text::jsonb;l jsonb;r public.books_native_invoice_income_selections;
begin
 select * into r from public.books_native_invoice_income_selections where org_id=new.org_id and legal_entity_id=new.legal_entity_id and invoice_id=new.invoice_id order by selection_revision desc limit 1;
 for l in select value from jsonb_array_elements(e->'lines') loop
  if l->'source'->'metadata'->>'arc_books_entity_account_id' is not null and l->'source'->'metadata'->>'system_generated_kind' is distinct from 'retainage_hold' then
   if r.id is null or not exists(select 1 from jsonb_array_elements(r.result_text::jsonb->'lines') v where v->'source'->>'id'=l->'source'->>'id' and v->'source'->'metadata'->>'arc_books_entity_account_id'=l->'source'->'metadata'->>'arc_books_entity_account_id') then raise exception 'Explicit native income requires its authorized source selection receipt';end if;
  end if;
 end loop;
 return new;
end $$;
create trigger books_native_invoice_income_posting_guard before insert on public.books_native_invoice_postings for each row execute function public.books_native_invoice_income_posting_guard();
do $$declare r record;begin
 for r in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in('books_validate_native_invoice_income_request','books_native_invoice_income_selection_guard','books_native_invoice_income_posting_guard','select_books_native_invoice_income') loop
  execute format('revoke all on function %s from public,anon,authenticated',r.signature);execute format('grant execute on function %s to service_role',r.signature);
 end loop;
end $$;
commit;
