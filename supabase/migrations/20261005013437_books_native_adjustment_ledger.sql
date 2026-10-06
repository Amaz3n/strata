-- Pending: independently reviewed native project adjustments. This does not
-- activate the official ledger or automatic operational source projection.
begin;
create unique index books_native_company_identity on public.companies(org_id,id);
create unique index books_native_cost_code_identity on public.cost_codes(org_id,id);
create unique index books_native_fiscal_period_scope on public.books_entity_fiscal_periods(org_id,legal_entity_id,id);
create unique index books_native_owner_review_scope on public.books_project_entity_reviews(org_id,legal_entity_id,project_id,id);
create unique index books_native_invoice_identity on public.invoices(org_id,id);
create unique index books_native_bill_identity on public.vendor_bills(org_id,id);
create unique index books_native_expense_identity on public.project_expenses(org_id,id);
create table public.books_native_entity_fences(org_id uuid not null,legal_entity_id uuid not null,generation bigint not null check(generation>0),primary key(org_id,legal_entity_id),foreign key(org_id,legal_entity_id) references public.books_legal_entities(org_id,id));
create function public.books_bump_native_entity_fence(p_org uuid,p_entity uuid)
returns void language sql volatile security invoker set search_path=pg_catalog,public as $$
 insert into public.books_native_entity_fences values(p_org,p_entity,1) on conflict(org_id,legal_entity_id) do update set generation=public.books_native_entity_fences.generation+1;
$$;
create function public.books_native_definition_fence()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin perform public.books_bump_native_entity_fence(new.org_id,new.legal_entity_id);return new;end $$;
do $$declare t text;begin foreach t in array array['books_legal_entity_profile_reviews','books_entity_chart_reviews','books_entity_calendar_reviews','books_project_entity_reviews'] loop execute format('create trigger books_native_definition_fence after insert on public.%I for each row execute function public.books_native_definition_fence()',t);end loop;end $$;
create table public.books_native_period_holds(
 id uuid primary key,org_id uuid not null,legal_entity_id uuid not null,period_id uuid not null,
 previous_id uuid,sequence_no bigint not null check(sequence_no between 1 and 9007199254740991),decision text not null check(decision in('hold','release')),
 actor_id uuid not null references public.app_users(id),access_event_id uuid not null,recorded_at timestamptz not null,notes text not null check(length(notes) between 10 and 2000 and notes=btrim(notes)),
 unique(org_id,legal_entity_id,id),unique(org_id,legal_entity_id,period_id,sequence_no),
 foreign key(org_id,legal_entity_id,period_id) references public.books_entity_fiscal_periods(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id,previous_id) references public.books_native_period_holds(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id,access_event_id) references public.books_legal_entity_access_history(org_id,legal_entity_id,id)
);
create table public.books_native_adjustment_facts(
 id uuid primary key,org_id uuid not null,legal_entity_id uuid not null,project_id uuid not null,
 source_type text not null check(source_type in('invoice','vendor_bill','expense')),source_id uuid not null,
 invoice_id uuid,bill_id uuid,expense_id uuid,
 owner_review_id uuid not null,chart_id uuid not null,period_id uuid not null,entry_date date not null,
 request_text text not null check(octet_length(request_text)<=4194304),request_sha256 text not null check(request_sha256 ~ '^[a-f0-9]{64}$'),
 validated_context_text text not null,validated_context_sha256 text not null check(validated_context_sha256 ~ '^[a-f0-9]{64}$'),
 prepared_by uuid not null references public.app_users(id),prepared_access_event_id uuid not null,prepared_at timestamptz not null,notes text not null check(length(notes) between 10 and 2000 and notes=btrim(notes)),
 unique(org_id,legal_entity_id,id),
 foreign key(org_id,project_id) references public.projects(org_id,id),
 foreign key(org_id,legal_entity_id,project_id,owner_review_id) references public.books_project_entity_reviews(org_id,legal_entity_id,project_id,id),
 foreign key(org_id,legal_entity_id,chart_id) references public.books_entity_chart_versions(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id,period_id) references public.books_entity_fiscal_periods(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id,prepared_access_event_id) references public.books_legal_entity_access_history(org_id,legal_entity_id,id),
 foreign key(org_id,invoice_id) references public.invoices(org_id,id),foreign key(org_id,bill_id) references public.vendor_bills(org_id,id),foreign key(org_id,expense_id) references public.project_expenses(org_id,id),
 check((source_type='invoice' and invoice_id is not null and invoice_id=source_id and bill_id is null and expense_id is null) or (source_type='vendor_bill' and bill_id is not null and bill_id=source_id and invoice_id is null and expense_id is null) or (source_type='expense' and expense_id is not null and expense_id=source_id and invoice_id is null and bill_id is null))
);
create table public.books_native_adjustment_reviews(
 id uuid primary key,org_id uuid not null,legal_entity_id uuid not null,fact_id uuid not null,
 decision text not null check(decision in('approve','reject')),entry_id uuid,request_sha256 text not null check(request_sha256 ~ '^[a-f0-9]{64}$'),
 reviewed_by uuid not null references public.app_users(id),reviewed_access_event_id uuid not null,reviewed_at timestamptz not null,notes text not null check(length(notes) between 10 and 2000 and notes=btrim(notes)),
 validated_context_text text,validated_context_sha256 text,
 unique(fact_id),unique(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id,fact_id) references public.books_native_adjustment_facts(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id,reviewed_access_event_id) references public.books_legal_entity_access_history(org_id,legal_entity_id,id),
 check((decision='approve' and entry_id is not null and validated_context_text is not null and validated_context_sha256 ~ '^[a-f0-9]{64}$') or (decision='reject' and entry_id is null and validated_context_text is null and validated_context_sha256 is null))
);
create table public.books_native_journal_entries(
 id uuid primary key,org_id uuid not null,legal_entity_id uuid not null,fact_id uuid not null,review_id uuid not null,
 chart_id uuid not null,period_id uuid not null,project_id uuid not null,entry_date date not null,memo text not null,total_cents bigint not null check(total_cents>0 and total_cents<=9007199254740991),posted_at timestamptz not null,
 unique(fact_id),unique(review_id),unique(org_id,legal_entity_id,id),unique(org_id,legal_entity_id,id,chart_id,project_id),
 foreign key(org_id,legal_entity_id,fact_id) references public.books_native_adjustment_facts(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id,review_id) references public.books_native_adjustment_reviews(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id,chart_id) references public.books_entity_chart_versions(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id,period_id) references public.books_entity_fiscal_periods(org_id,legal_entity_id,id),foreign key(org_id,project_id) references public.projects(org_id,id)
);
create table public.books_native_journal_lines(
 id uuid primary key default gen_random_uuid(),org_id uuid not null,legal_entity_id uuid not null,entry_id uuid not null,chart_id uuid not null,project_id uuid not null,
 position integer not null check(position between 1 and 1000),account_id uuid not null,
 debit_cents bigint not null check(debit_cents between 0 and 9007199254740991),credit_cents bigint not null check(credit_cents between 0 and 9007199254740991),description text,company_id uuid,cost_code_id uuid,dimensions jsonb not null default '{}',
 unique(entry_id,position),
 foreign key(org_id,legal_entity_id,entry_id,chart_id,project_id) references public.books_native_journal_entries(org_id,legal_entity_id,id,chart_id,project_id),
 foreign key(org_id,legal_entity_id,chart_id,account_id) references public.books_entity_account_definitions(org_id,legal_entity_id,chart_id,account_id),
 foreign key(org_id,company_id) references public.companies(org_id,id),foreign key(org_id,cost_code_id) references public.cost_codes(org_id,id),
 check((debit_cents>0 and credit_cents=0) or (credit_cents>0 and debit_cents=0))
);
create function public.books_lock_native_adjustment_scope(p_org uuid,p_entity uuid,p_project uuid,p_actor uuid,p_operation text,p_type text,p_source uuid)
returns void language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
begin
 perform 1 from public.books_legal_entities where org_id=p_org and id=p_entity for update;
 if not found or not public.books_entity_has_access(p_org,p_entity,p_actor,p_operation) then raise exception 'Current native entity operation access is required';end if;
 perform public.books_bump_native_entity_fence(p_org,p_entity);
 perform 1 from public.memberships where org_id=p_org and user_id=p_actor and status='active' for share;if not found then raise exception 'Active native adjustment actor membership is required';end if;
 perform 1 from public.projects where org_id=p_org and id=p_project for update;if not found then raise exception 'Native project is missing or foreign';end if;
 if p_type='invoice' then perform 1 from public.invoices where org_id=p_org and id=p_source and project_id=p_project for update;
 elsif p_type='vendor_bill' then perform 1 from public.vendor_bills where org_id=p_org and id=p_source and project_id=p_project for update;
 elsif p_type='expense' then perform 1 from public.project_expenses where org_id=p_org and id=p_source and project_id=p_project for update;
 else raise exception 'Unsupported native adjustment source';end if;
 if not found then raise exception 'Native adjustment source is missing or foreign';end if;
end $$;
create function public.books_native_period_hold_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare prior public.books_native_period_holds;
begin
 perform 1 from public.books_legal_entities where org_id=new.org_id and id=new.legal_entity_id for update;
 if not found or not public.books_entity_has_access(new.org_id,new.legal_entity_id,new.actor_id,'manage') then raise exception 'Native period hold requires entity management access';end if;
 perform public.books_bump_native_entity_fence(new.org_id,new.legal_entity_id);
 perform 1 from public.memberships where org_id=new.org_id and user_id=new.actor_id and status='active' for share;if not found then raise exception 'Active hold actor is required';end if;
 perform 1 from public.books_entity_fiscal_periods p join public.books_entity_calendar_reviews r on r.org_id=p.org_id and r.legal_entity_id=p.legal_entity_id and r.calendar_year_id=p.calendar_year_id where p.org_id=new.org_id and p.legal_entity_id=new.legal_entity_id and p.id=new.period_id for update of p;if not found then raise exception 'Reviewed native fiscal period is required';end if;
 select * into prior from public.books_native_period_holds where org_id=new.org_id and legal_entity_id=new.legal_entity_id and period_id=new.period_id order by sequence_no desc limit 1;
 if new.previous_id is distinct from prior.id or new.decision=coalesce(prior.decision,'release') then raise exception 'Native hold predecessor or transition changed';end if;
 if new.decision='release' and prior.actor_id=new.actor_id then raise exception 'A separate entity manager must release the posting hold';end if;
 new.sequence_no:=coalesce(prior.sequence_no,0)+1;new.notes:=btrim(new.notes);new.recorded_at:=clock_timestamp();
 select id into new.access_event_id from public.books_legal_entity_access_history where org_id=new.org_id and legal_entity_id=new.legal_entity_id and user_id=new.actor_id order by sequence_no desc limit 1;return new;
end $$;
create function public.books_assert_native_period_available(p_org uuid,p_entity uuid,p_period uuid)
returns void language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare decision text;
begin
 perform 1 from public.books_entity_fiscal_periods where org_id=p_org and legal_entity_id=p_entity and id=p_period for update;if not found then raise exception 'Native fiscal period is missing';end if;
 select h.decision into decision from public.books_native_period_holds h where org_id=p_org and legal_entity_id=p_entity and period_id=p_period order by sequence_no desc limit 1;
 if decision='hold' then raise exception 'Native fiscal period is held against posting';end if;
end $$;
create function public.books_validate_native_adjustment_request(p_org uuid,p_entity uuid,p_project uuid,p_actor uuid,p_id uuid,p_request jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare c jsonb;d jsonb;fresh jsonb;l jsonb;wanted_code text;debits numeric:=0;credits numeric:=0;v text;dimensions jsonb;
begin
 if jsonb_typeof(p_request) is distinct from 'object' or p_request-array['context','draft']<>'{}' or (select count(*) from jsonb_object_keys(p_request))<>2 or octet_length(p_request::text)>4194304 then raise exception 'Complete bounded native adjustment request is required';end if;
 c:=p_request->'context';d:=p_request->'draft';
 if (c->>'orgId',c->>'actorId',c->>'projectId',c->'owner'->>'legal_entity_id') is distinct from(p_org::text,p_actor::text,p_project::text,p_entity::text) then raise exception 'Native adjustment context belongs to another scope or actor';end if;
 if jsonb_typeof(d) is distinct from 'object' or d-array['entryDate','entryKind','memo','postingKey','projectionVersion','policyVersion','sourceType','sourceId','lines']<>'{}' or (select count(*) from jsonb_object_keys(d))<>9 or d->>'entryKind' is distinct from 'adjusting' or d->'projectionVersion' is distinct from '1'::jsonb or d->'policyVersion' is distinct from '1'::jsonb or d->>'postingKey' is distinct from 'native-adjustment:'||p_id::text or jsonb_typeof(d->'memo') is distinct from 'string' or length(d->>'memo') not between 10 and 2000 or (d->>'entryDate',d->>'sourceType',d->>'sourceId') is distinct from(c->>'entryDate',c->>'sourceType',c->>'sourceId') or jsonb_typeof(d->'lines') is distinct from 'array' then raise exception 'Explicit native adjusting entry policy and source are required';end if;
 fresh:=public.read_books_native_project_posting_context(p_org,p_project,c->>'sourceType',(c->>'sourceId')::uuid,p_actor,(c->>'entryDate')::date);
 if (c-array['capturedAt','databaseSnapshot']) is distinct from (fresh-array['capturedAt','databaseSnapshot']) or (c->>'capturedAt')::timestamptz>clock_timestamp() then raise exception 'Native source, ownership, chart or calendar snapshot changed';end if;
 perform public.books_assert_native_period_available(p_org,p_entity,(fresh->'period'->>'id')::uuid);
 if jsonb_array_length(d->'lines') not between 2 and 1000 then raise exception 'Bounded native journal legs are required';end if;
 for l in select value from jsonb_array_elements(d->'lines') loop
  if jsonb_typeof(l) is distinct from 'object' or l-array['accountCode','accountRole','debitCents','creditCents','description','projectId','companyId','dimensions']<>'{}' or jsonb_typeof(l->'accountCode') is distinct from 'string' or length(l->>'accountCode') not between 1 and 32 or coalesce(l->>'debitCents','') !~ '^(0|[1-9][0-9]*)$' or coalesce(l->>'creditCents','') !~ '^(0|[1-9][0-9]*)$' or jsonb_typeof(l->'debitCents') is distinct from 'number' or jsonb_typeof(l->'creditCents') is distinct from 'number' or (l->>'debitCents')::numeric>9007199254740991 or (l->>'creditCents')::numeric>9007199254740991 or not (((l->>'debitCents')::numeric>0 and (l->>'creditCents')::numeric=0) or ((l->>'creditCents')::numeric>0 and (l->>'debitCents')::numeric=0)) then raise exception 'Native journal legs require exact positive debit or credit cents';end if;
  if l ? 'accountRole' then if jsonb_typeof(l->'accountRole') is distinct from 'string' then raise exception 'Native account role is invalid';end if;wanted_code:=(fresh->'chart'->>'definition_text')::jsonb->'controls'->>(l->>'accountRole');else wanted_code:=l->>'accountCode';end if;
  if wanted_code is null or not exists(select 1 from jsonb_array_elements(fresh->'accounts') a where a->>'code'=wanted_code) then raise exception 'Account is absent from reviewed native chart';end if;
  if l ? 'projectId' and l->>'projectId' is distinct from p_project::text then raise exception 'Native journal leg belongs to another project';end if;
  if l ? 'description' and (jsonb_typeof(l->'description') is distinct from 'string' or length(l->>'description')>2000) then raise exception 'Native journal description is invalid';end if;
  if l ? 'companyId' and not exists(select 1 from public.companies where org_id=p_org and id=(l->>'companyId')::uuid) then raise exception 'Native counterparty is missing or foreign';end if;
  dimensions:=coalesce(l->'dimensions','{}');
  if jsonb_typeof(dimensions) is distinct from 'object' or dimensions-array['project_id','cost_code_id']<>'{}' or (dimensions ? 'project_id' and dimensions->>'project_id' is distinct from p_project::text) then raise exception 'Native adjustment dimensions require explicit supported ownership';end if;
  if dimensions ? 'cost_code_id' and not exists(select 1 from public.cost_codes where org_id=p_org and id=(dimensions->>'cost_code_id')::uuid) then raise exception 'Native cost code is missing or foreign';end if;
  debits:=debits+(l->>'debitCents')::numeric;credits:=credits+(l->>'creditCents')::numeric;
 end loop;
 if debits<>credits or debits<=0 or debits>9007199254740991 then raise exception 'Native journal is unbalanced or outside exact aggregate cents';end if;
 return fresh;
end $$;
create function public.books_native_adjustment_fact_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare r jsonb;c jsonb;
begin
 r:=new.request_text::jsonb;c:=r->'context';
 perform public.books_lock_native_adjustment_scope(new.org_id,new.legal_entity_id,new.project_id,new.prepared_by,'prepare',c->>'sourceType',(c->>'sourceId')::uuid);
 c:=public.books_validate_native_adjustment_request(new.org_id,new.legal_entity_id,new.project_id,new.prepared_by,new.id,r);
 new.source_type:=c->>'sourceType';new.source_id:=(c->>'sourceId')::uuid;
 new.invoice_id:=case when new.source_type='invoice' then new.source_id end;new.bill_id:=case when new.source_type='vendor_bill' then new.source_id end;new.expense_id:=case when new.source_type='expense' then new.source_id end;
 new.owner_review_id:=(c->'owner'->>'id')::uuid;new.chart_id:=(c->'chart'->>'id')::uuid;new.period_id:=(c->'period'->>'id')::uuid;new.entry_date:=(c->>'entryDate')::date;
 new.request_text:=r::text;new.request_sha256:=encode(sha256(convert_to(new.request_text,'UTF8')),'hex');new.validated_context_text:=c::text;new.validated_context_sha256:=encode(sha256(convert_to(new.validated_context_text,'UTF8')),'hex');
 new.prepared_at:=clock_timestamp();new.notes:=btrim(new.notes);
 select id into new.prepared_access_event_id from public.books_legal_entity_access_history where org_id=new.org_id and legal_entity_id=new.legal_entity_id and user_id=new.prepared_by order by sequence_no desc limit 1;return new;
end $$;
create function public.books_native_adjustment_review_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare f public.books_native_adjustment_facts;c jsonb;
begin
 select * into f from public.books_native_adjustment_facts where org_id=new.org_id and legal_entity_id=new.legal_entity_id and id=new.fact_id;if not found then raise exception 'Native adjustment fact is missing or foreign';end if;
 perform public.books_lock_native_adjustment_scope(new.org_id,new.legal_entity_id,f.project_id,new.reviewed_by,'review',f.source_type,f.source_id);
 if f.prepared_by=new.reviewed_by then raise exception 'Native adjustment requires an independent reviewer';end if;
 new.request_sha256:=f.request_sha256;new.validated_context_text:=null;new.validated_context_sha256:=null;
 if new.decision='approve' then
  perform 1 from public.memberships where org_id=new.org_id and user_id in(f.prepared_by,new.reviewed_by) and status='active' order by user_id for share;
  if not public.books_entity_has_access(new.org_id,new.legal_entity_id,f.prepared_by,'prepare') then raise exception 'Native adjustment maker must retain preparation access';end if;
  c:=public.books_validate_native_adjustment_request(new.org_id,new.legal_entity_id,f.project_id,f.prepared_by,f.id,f.request_text::jsonb);
  new.validated_context_text:=c::text;new.validated_context_sha256:=encode(sha256(convert_to(new.validated_context_text,'UTF8')),'hex');
 end if;
 new.reviewed_at:=clock_timestamp();new.notes:=btrim(new.notes);
 select id into new.reviewed_access_event_id from public.books_legal_entity_access_history where org_id=new.org_id and legal_entity_id=new.legal_entity_id and user_id=new.reviewed_by order by sequence_no desc limit 1;return new;
end $$;
create function public.books_native_journal_entry_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare f public.books_native_adjustment_facts;r public.books_native_adjustment_reviews;d jsonb;
begin
 select * into r from public.books_native_adjustment_reviews where org_id=new.org_id and legal_entity_id=new.legal_entity_id and id=new.review_id;
 if r.id is null or r.decision<>'approve' or r.entry_id is distinct from new.id or r.fact_id is distinct from new.fact_id then raise exception 'Native journal requires its exact approved adjustment receipt';end if;
 select * into f from public.books_native_adjustment_facts where org_id=new.org_id and legal_entity_id=new.legal_entity_id and id=r.fact_id;
 perform public.books_lock_native_adjustment_scope(new.org_id,new.legal_entity_id,f.project_id,r.reviewed_by,'review',f.source_type,f.source_id);
 perform public.books_validate_native_adjustment_request(new.org_id,new.legal_entity_id,f.project_id,f.prepared_by,f.id,f.request_text::jsonb);
 d:=f.request_text::jsonb->'draft';
 new.chart_id:=f.chart_id;new.period_id:=f.period_id;new.project_id:=f.project_id;new.entry_date:=f.entry_date;new.memo:=d->>'memo';
 select sum((l->>'debitCents')::numeric)::bigint into new.total_cents from jsonb_array_elements(d->'lines') l;new.posted_at:=r.reviewed_at;return new;
end $$;
create function public.books_native_journal_line_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare e public.books_native_journal_entries;f public.books_native_adjustment_facts;l jsonb;wanted_code text;account uuid;
begin
 select * into e from public.books_native_journal_entries where org_id=new.org_id and legal_entity_id=new.legal_entity_id and id=new.entry_id;if not found then raise exception 'Native journal entry is missing or foreign';end if;
 select * into f from public.books_native_adjustment_facts where org_id=e.org_id and legal_entity_id=e.legal_entity_id and id=e.fact_id;
 l:=f.request_text::jsonb->'draft'->'lines'->(new.position-1);if l is null or new.position<1 then raise exception 'Native journal leg is outside original adjustment';end if;
 if l ? 'accountRole' then wanted_code:=(f.validated_context_text::jsonb->'chart'->>'definition_text')::jsonb->'controls'->>(l->>'accountRole');else wanted_code:=l->>'accountCode';end if;
 select a.id into account from public.books_entity_accounts a join public.books_entity_account_definitions d on d.org_id=a.org_id and d.legal_entity_id=a.legal_entity_id and d.account_id=a.id and d.chart_id=e.chart_id where a.org_id=e.org_id and a.legal_entity_id=e.legal_entity_id and a.code=wanted_code;
 if (new.account_id,new.chart_id,new.project_id,new.debit_cents,new.credit_cents,new.description,new.company_id,new.cost_code_id,new.dimensions) is distinct from(account,e.chart_id,e.project_id,(l->>'debitCents')::bigint,(l->>'creditCents')::bigint,l->>'description',(l->>'companyId')::uuid,(l->'dimensions'->>'cost_code_id')::uuid,coalesce(l->'dimensions','{}'::jsonb)) then raise exception 'Native journal leg differs from original reviewed adjustment';end if;return new;
end $$;
create function public.books_assert_native_adjustment_complete(p_org uuid,p_entity uuid,p_fact uuid)
returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
declare f public.books_native_adjustment_facts;r public.books_native_adjustment_reviews;e public.books_native_journal_entries;n integer;debits numeric;credits numeric;
begin
 select * into f from public.books_native_adjustment_facts where org_id=p_org and legal_entity_id=p_entity and id=p_fact;
 select * into r from public.books_native_adjustment_reviews where org_id=p_org and legal_entity_id=p_entity and fact_id=p_fact;
 if r.id is null then return;end if;
 select * into e from public.books_native_journal_entries where org_id=p_org and legal_entity_id=p_entity and fact_id=p_fact;
 if r.decision='reject' then if e.id is not null then raise exception 'Rejected native adjustment cannot have journal money';end if;return;end if;
 if e.id is null or e.id is distinct from r.entry_id or e.review_id is distinct from r.id then raise exception 'Approved native adjustment requires its original journal';end if;
 select count(*),coalesce(sum(debit_cents),0),coalesce(sum(credit_cents),0) into n,debits,credits from public.books_native_journal_lines where org_id=p_org and legal_entity_id=p_entity and entry_id=e.id;
 if n<>jsonb_array_length(f.request_text::jsonb->'draft'->'lines') or debits<>credits or debits<>e.total_cents or debits<=0 then raise exception 'Native adjustment journal is incomplete or unbalanced';end if;
end $$;
create function public.books_native_adjustment_complete()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare fact uuid;
begin
 fact:=case when tg_table_name='books_native_adjustment_reviews' then new.fact_id else new.fact_id end;
 perform public.books_assert_native_adjustment_complete(new.org_id,new.legal_entity_id,fact);return new;
end $$;
create trigger books_native_period_hold_guard before insert on public.books_native_period_holds for each row execute function public.books_native_period_hold_guard();
create trigger books_native_adjustment_fact_guard before insert on public.books_native_adjustment_facts for each row execute function public.books_native_adjustment_fact_guard();
create trigger books_native_adjustment_review_guard before insert on public.books_native_adjustment_reviews for each row execute function public.books_native_adjustment_review_guard();
create trigger books_native_journal_entry_guard before insert on public.books_native_journal_entries for each row execute function public.books_native_journal_entry_guard();
create trigger books_native_journal_line_guard before insert on public.books_native_journal_lines for each row execute function public.books_native_journal_line_guard();
create constraint trigger books_native_review_complete after insert on public.books_native_adjustment_reviews deferrable initially deferred for each row execute function public.books_native_adjustment_complete();
create constraint trigger books_native_journal_complete after insert on public.books_native_journal_entries deferrable initially deferred for each row execute function public.books_native_adjustment_complete();
create function public.prepare_books_native_adjustment(p_org uuid,p_entity uuid,p_project uuid,p_actor uuid,p_id uuid,p_request jsonb,p_notes text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare f public.books_native_adjustment_facts;
begin
 perform 1 from public.books_legal_entities where org_id=p_org and id=p_entity for update;if not found or not public.books_entity_has_access(p_org,p_entity,p_actor,'prepare') then raise exception 'Current native adjustment preparation access is required';end if;
 select * into f from public.books_native_adjustment_facts where id=p_id;
 if found then
  if (f.org_id,f.legal_entity_id,f.project_id,f.prepared_by,f.request_text::jsonb,f.notes) is distinct from(p_org,p_entity,p_project,p_actor,p_request,btrim(p_notes)) then raise exception 'Native preparation retry differs from original request';end if;
 else
  insert into public.books_native_adjustment_facts(id,org_id,legal_entity_id,project_id,source_type,source_id,owner_review_id,chart_id,period_id,entry_date,request_text,request_sha256,validated_context_text,validated_context_sha256,prepared_by,prepared_access_event_id,prepared_at,notes)
  values(p_id,p_org,p_entity,p_project,'invoice',p_id,p_id,p_id,p_id,current_date,p_request::text,repeat('0',64),'{}',repeat('0',64),p_actor,p_id,clock_timestamp(),p_notes) returning * into f;
 end if;
 return jsonb_build_object('fact',to_jsonb(f),'posted',false,'ledgerActivated',false);
end $$;
create function public.review_books_native_adjustment(p_org uuid,p_entity uuid,p_project uuid,p_fact uuid,p_id uuid,p_actor uuid,p_decision text,p_entry uuid,p_notes text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare f public.books_native_adjustment_facts;r public.books_native_adjustment_reviews;e public.books_native_journal_entries;lines jsonb;created boolean:=false;
begin
 perform 1 from public.books_legal_entities where org_id=p_org and id=p_entity for update;if not found or not public.books_entity_has_access(p_org,p_entity,p_actor,'review') then raise exception 'Current native adjustment review access is required';end if;
 select * into f from public.books_native_adjustment_facts where org_id=p_org and legal_entity_id=p_entity and project_id=p_project and id=p_fact;if not found then raise exception 'Native adjustment fact is missing or foreign';end if;
 select * into r from public.books_native_adjustment_reviews where fact_id=p_fact;
 if found then if(r.id,r.reviewed_by,r.decision,r.entry_id,r.notes) is distinct from(p_id,p_actor,p_decision,p_entry,btrim(p_notes)) then raise exception 'Native review retry differs from original receipt';end if;
 else
  insert into public.books_native_adjustment_reviews(id,org_id,legal_entity_id,fact_id,decision,entry_id,request_sha256,reviewed_by,reviewed_access_event_id,reviewed_at,notes)
  values(p_id,p_org,p_entity,p_fact,p_decision,p_entry,repeat('0',64),p_actor,p_id,clock_timestamp(),p_notes) returning * into r;created:=true;
  if p_decision='approve' then
   insert into public.books_native_journal_entries(id,org_id,legal_entity_id,fact_id,review_id,chart_id,period_id,project_id,entry_date,memo,total_cents,posted_at)
   values(p_entry,p_org,p_entity,p_fact,p_id,f.chart_id,f.period_id,f.project_id,f.entry_date,'pending',1,clock_timestamp()) returning * into e;
   insert into public.books_native_journal_lines(org_id,legal_entity_id,entry_id,chart_id,project_id,position,account_id,debit_cents,credit_cents,description,company_id,cost_code_id,dimensions)
   select p_org,p_entity,p_entry,f.chart_id,f.project_id,l.position::integer,a.id,(l.body->>'debitCents')::bigint,(l.body->>'creditCents')::bigint,l.body->>'description',(l.body->>'companyId')::uuid,(l.body->'dimensions'->>'cost_code_id')::uuid,coalesce(l.body->'dimensions','{}'::jsonb)
   from jsonb_array_elements(f.request_text::jsonb->'draft'->'lines') with ordinality l(body,position)
   join public.books_entity_accounts a on a.org_id=p_org and a.legal_entity_id=p_entity and a.code=case when l.body ? 'accountRole' then (f.validated_context_text::jsonb->'chart'->>'definition_text')::jsonb->'controls'->>(l.body->>'accountRole') else l.body->>'accountCode' end;
  end if;
 end if;
 perform public.books_assert_native_adjustment_complete(p_org,p_entity,p_fact);
 select * into e from public.books_native_journal_entries where org_id=p_org and legal_entity_id=p_entity and fact_id=p_fact;
 select coalesce(jsonb_agg(to_jsonb(l) order by position),'[]') into lines from public.books_native_journal_lines l where org_id=p_org and legal_entity_id=p_entity and entry_id=e.id;
 return jsonb_build_object('fact',to_jsonb(f),'review',to_jsonb(r),'entry',case when e.id is null then null else to_jsonb(e) end,'lines',lines,'posted',r.decision='approve','created',created,'ledgerActivated',false);
end $$;
create function public.set_books_native_period_hold(p_org uuid,p_entity uuid,p_period uuid,p_actor uuid,p_id uuid,p_previous uuid,p_decision text,p_notes text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare h public.books_native_period_holds;
begin
 perform 1 from public.books_legal_entities where org_id=p_org and id=p_entity for update;if not found or not public.books_entity_has_access(p_org,p_entity,p_actor,'manage') then raise exception 'Native period hold requires management access';end if;
 select * into h from public.books_native_period_holds where id=p_id;
 if found then if(h.org_id,h.legal_entity_id,h.period_id,h.actor_id,h.previous_id,h.decision,h.notes) is distinct from(p_org,p_entity,p_period,p_actor,p_previous,p_decision,btrim(p_notes)) then raise exception 'Native hold retry differs from original';end if;
 else insert into public.books_native_period_holds(id,org_id,legal_entity_id,period_id,actor_id,previous_id,decision,sequence_no,access_event_id,recorded_at,notes) values(p_id,p_org,p_entity,p_period,p_actor,p_previous,p_decision,1,p_id,clock_timestamp(),p_notes) returning * into h;end if;
 return to_jsonb(h);
end $$;
create function public.read_books_native_adjustment(p_org uuid,p_entity uuid,p_project uuid,p_fact uuid,p_actor uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare f public.books_native_adjustment_facts;r public.books_native_adjustment_reviews;e public.books_native_journal_entries;lines jsonb;
begin
 if not public.books_entity_has_access(p_org,p_entity,p_actor,'read') then raise exception 'Current native entity read access is required';end if;
 select * into f from public.books_native_adjustment_facts where org_id=p_org and legal_entity_id=p_entity and project_id=p_project and id=p_fact;
 if f.id is not null then
  select * into r from public.books_native_adjustment_reviews where org_id=p_org and legal_entity_id=p_entity and fact_id=f.id;
  select * into e from public.books_native_journal_entries where org_id=p_org and legal_entity_id=p_entity and fact_id=f.id;
 end if;
 select coalesce(jsonb_agg(to_jsonb(l) order by position),'[]') into lines from public.books_native_journal_lines l where org_id=p_org and legal_entity_id=p_entity and entry_id=e.id;
 return jsonb_build_object('orgId',p_org,'entityId',p_entity,'projectId',p_project,'factId',p_fact,'actorId',p_actor,'fact',case when f.id is null then null else to_jsonb(f) end,'review',case when r.id is null then null else to_jsonb(r) end,'entry',case when e.id is null then null else to_jsonb(e) end,'lines',lines);
end $$;
-- Histories are exported; mutable coordination generations are rebuilt lazily.
do $$declare t text;begin
 foreach t in array array['books_native_period_holds','books_native_adjustment_facts','books_native_adjustment_reviews','books_native_journal_entries','books_native_journal_lines'] loop
  execute format('create trigger books_native_immutable before update or delete on public.%I for each row execute function public.books_entity_immutable()',t);
  execute format('create index %I on public.%I(org_id,legal_entity_id)',t||'_entity_idx',t);
 end loop;
 foreach t in array array['books_native_entity_fences','books_native_period_holds','books_native_adjustment_facts','books_native_adjustment_reviews','books_native_journal_entries','books_native_journal_lines'] loop execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated',t);execute format('grant all on public.%I to service_role',t);end loop;
end $$;
create index books_native_fact_project_idx on public.books_native_adjustment_facts(org_id,project_id);
create index books_native_fact_source_idx on public.books_native_adjustment_facts(org_id,source_type,source_id);
create index books_native_fact_chart_idx on public.books_native_adjustment_facts(org_id,legal_entity_id,chart_id);
create index books_native_fact_period_idx on public.books_native_adjustment_facts(org_id,legal_entity_id,period_id);
create index books_native_entry_period_idx on public.books_native_journal_entries(org_id,legal_entity_id,period_id,entry_date);
create index books_native_line_account_idx on public.books_native_journal_lines(org_id,legal_entity_id,chart_id,account_id);
create index books_native_hold_previous_idx on public.books_native_period_holds(org_id,legal_entity_id,previous_id);
create index books_native_review_fact_idx on public.books_native_adjustment_reviews(org_id,legal_entity_id,fact_id);
create index books_native_entry_fact_idx on public.books_native_journal_entries(org_id,legal_entity_id,fact_id);
create index books_native_entry_review_idx on public.books_native_journal_entries(org_id,legal_entity_id,review_id);
create index books_native_fact_owner_idx on public.books_native_adjustment_facts(org_id,legal_entity_id,project_id,owner_review_id);
create index books_native_line_company_idx on public.books_native_journal_lines(org_id,company_id);
create index books_native_line_cost_idx on public.books_native_journal_lines(org_id,cost_code_id);
create index books_native_fact_actor_idx on public.books_native_adjustment_facts(prepared_by);
create index books_native_review_actor_idx on public.books_native_adjustment_reviews(reviewed_by);
create index books_native_hold_actor_idx on public.books_native_period_holds(actor_id);
create index books_native_fact_access_idx on public.books_native_adjustment_facts(org_id,legal_entity_id,prepared_access_event_id);
create index books_native_review_access_idx on public.books_native_adjustment_reviews(org_id,legal_entity_id,reviewed_access_event_id);
create index books_native_hold_access_idx on public.books_native_period_holds(org_id,legal_entity_id,access_event_id);
create index books_native_fact_invoice_idx on public.books_native_adjustment_facts(org_id,invoice_id);
create index books_native_fact_bill_idx on public.books_native_adjustment_facts(org_id,bill_id);
create index books_native_fact_expense_idx on public.books_native_adjustment_facts(org_id,expense_id);
alter function public.capture_books_export_snapshot(uuid) rename to capture_books_export_snapshot_before_native_adjustments;
create function public.capture_books_export_snapshot(p_org_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare snapshot jsonb;rows jsonb;t text;
begin
 snapshot:=public.capture_books_export_snapshot_before_native_adjustments(p_org_id);
 foreach t in array array['books_native_period_holds','books_native_adjustment_facts','books_native_adjustment_reviews','books_native_journal_entries','books_native_journal_lines'] loop execute format('select coalesce(jsonb_agg(to_jsonb(r) order by r.id),''[]'') from public.%I r where org_id=$1',t) into rows using p_org_id;snapshot:=jsonb_set(snapshot,array['tables',t],rows);end loop;return snapshot;
end $$;
revoke all on function public.capture_books_export_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.capture_books_export_snapshot(uuid) to service_role;
create or replace function public.capture_books_legacy_ownership_evidence(p_org uuid,p_actor uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_snapshot jsonb;v_tables jsonb;v_rows jsonb;
begin
 v_snapshot:=public.capture_books_entity_authorized_export(p_org,p_actor);
 v_tables:=(v_snapshot->'tables')-'books_legacy_entity_proposals'-'books_legacy_entity_reviews'-'books_journal_request_resolutions'-'books_project_owner_request_resolutions'-'books_native_period_holds'-'books_native_adjustment_facts'-'books_native_adjustment_reviews'-'books_native_journal_entries'-'books_native_journal_lines'-'books_entity_calendar_years'-'books_entity_fiscal_periods'-'books_entity_calendar_reviews'-'books_entity_chart_versions'-'books_entity_accounts'-'books_entity_account_definitions'-'books_entity_control_accounts'-'books_entity_chart_reviews';
 select coalesce(jsonb_agg(row-'tax_id'-'ein'-'ssn' order by row->>'id'),'[]'::jsonb) into v_rows from jsonb_array_elements(v_tables->'companies') row;
 v_tables:=jsonb_set(v_tables,'{companies}',v_rows);
 select coalesce(jsonb_agg((select jsonb_object_agg(key,value) from jsonb_each(row) where key=any(array['id','org_id','provider','bank_name','account_type','last4','status','books_gl_account_id','created_at','updated_at'])) order by row->>'id'),'[]'::jsonb) into v_rows from jsonb_array_elements(v_tables->'org_funding_sources') row;
 v_tables:=jsonb_set(v_tables,'{org_funding_sources}',v_rows);
 return jsonb_build_object('populationText',v_tables::text,'capturedAt',v_snapshot->'capturedAt','databaseSnapshot',v_snapshot->'databaseSnapshot');
end;
$$;
do $$declare r record;begin
 for r in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and (proname like 'books_native_%' or proname in('books_bump_native_entity_fence','books_lock_native_adjustment_scope','books_assert_native_period_available','books_validate_native_adjustment_request','books_assert_native_adjustment_complete','prepare_books_native_adjustment','read_books_native_adjustment','review_books_native_adjustment','set_books_native_period_hold','capture_books_export_snapshot_before_native_adjustments')) loop execute format('revoke all on function %s from public,anon,authenticated',r.signature);execute format('grant execute on function %s to service_role',r.signature);end loop;
end $$;
commit;
