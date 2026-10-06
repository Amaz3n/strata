-- Immutable native entity chart definitions. Entity account identities remain
-- stable across reviewed versions. Legacy gl_accounts and postings are unchanged.
begin;
create function public.books_validate_entity_chart(p_definition jsonb)
returns boolean language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare accounts jsonb;controls jsonb;
begin
 if jsonb_typeof(p_definition) is distinct from 'object' or p_definition-array['accounts','controls','classification_version']<>'{}' or p_definition->'classification_version' is distinct from '1'::jsonb then raise exception 'A complete entity chart definition is required';end if;
 accounts:=p_definition->'accounts';controls:=p_definition->'controls';
 if jsonb_typeof(accounts) is distinct from 'array' or jsonb_array_length(accounts) not between 1 and 1000 or jsonb_typeof(controls) is distinct from 'object' then raise exception 'Bounded account and control definitions are required';end if;
 if exists(select 1 from jsonb_array_elements(accounts)a where jsonb_typeof(a) is distinct from 'object' or a-array['code','name','account_type','subtype','normal_balance','cash_flow_category','parent_code']<>'{}' or (select count(*) from jsonb_object_keys(a))<>7 or jsonb_typeof(a->'code') is distinct from 'string' or (length(coalesce(a->>'code','')) not between 1 and 32 or a->>'code'<>btrim(a->>'code') or a->>'code' ~ '[[:cntrl:]]') or jsonb_typeof(a->'name') is distinct from 'string' or length(btrim(a->>'name')) not between 2 and 160 or a->>'name'<>btrim(a->>'name') or not exists(select 1 from(values ('cash','asset','debit'),('undeposited_funds','asset','debit'),('accounts_receivable','asset','debit'),('retainage_receivable','asset','debit'),('costs_in_excess','asset','debit'),('work_in_progress','asset','debit'),('prepaid_expenses','asset','debit'),('fixed_assets','asset','debit'),('accumulated_depreciation','asset','credit'),('other_asset','asset','debit'),('accounts_payable','liability','credit'),('retainage_payable','liability','credit'),('credit_card','liability','credit'),('payroll_clearing','liability','credit'),('sales_use_tax','liability','credit'),('customer_deposits','liability','credit'),('billings_in_excess','liability','credit'),('current_debt','liability','credit'),('long_term_debt','liability','credit'),('other_liability','liability','credit'),('expected_contract_loss_reserve','liability','credit'),('owner_equity','equity','credit'),('owner_contributions','equity','credit'),('owner_distributions','equity','debit'),('retained_earnings','equity','credit'),('construction_revenue','income','credit'),('other_revenue','income','credit'),('early_pay_discount','income','credit'),('payment_fee_recovery','income','credit'),('job_costs','cogs','debit'),('subcontractor_costs','cogs','debit'),('material_costs','cogs','debit'),('direct_labor','cogs','debit'),('equipment_costs','cogs','debit'),('warranty_costs','cogs','debit'),('expected_contract_loss_expense','cogs','debit'),('rent','expense','debit'),('insurance','expense','debit'),('software','expense','debit'),('professional_fees','expense','debit'),('utilities','expense','debit'),('bank_fees','expense','debit'),('interest','expense','debit'),('payroll','expense','debit'),('depreciation','expense','debit'),('other_expense','expense','debit'))c(subtype,account_type,normal_balance) where c.subtype=a->>'subtype' and c.account_type=a->>'account_type' and c.normal_balance=a->>'normal_balance') or (jsonb_typeof(a->'cash_flow_category') is distinct from 'null' and (jsonb_typeof(a->'cash_flow_category') is distinct from 'string' or a->>'cash_flow_category' not in('cash','operating','investing','financing'))) or (jsonb_typeof(a->'parent_code') is distinct from 'null' and (jsonb_typeof(a->'parent_code') is distinct from 'string' or (length(coalesce(a->>'parent_code','')) not between 1 and 32 or a->>'parent_code'<>btrim(a->>'parent_code') or a->>'parent_code' ~ '[[:cntrl:]]')))) then raise exception 'Entity account shape, classification or normal balance is invalid';end if;
 if (select count(distinct a->>'code') from jsonb_array_elements(accounts)a)<>jsonb_array_length(accounts) then raise exception 'Entity account codes must be unique';end if;
 if exists(select 1 from jsonb_array_elements(accounts)a where a->>'parent_code' is not null and not exists(select 1 from jsonb_array_elements(accounts)p where p->>'code'=a->>'parent_code' and p->>'account_type'=a->>'account_type')) then raise exception 'Account parent must be in the same entity chart and account type';end if;
 if exists(with recursive walk as(select a->>'code' origin,a->>'parent_code' next,array[a->>'code'] path,false cycle from jsonb_array_elements(accounts)a union all select w.origin,p->>'parent_code',w.path||(p->>'code'),p->>'code'=any(w.path) from walk w join jsonb_array_elements(accounts)p on p->>'code'=w.next where not w.cycle and cardinality(w.path)<=32) select 1 from walk where cycle or cardinality(path)>32) then raise exception 'Entity account hierarchy cannot cycle';end if;
 if (select count(*) from jsonb_object_keys(controls))<>51 or exists(select 1 from(values ('operatingCash','asset','cash','debit'),('undepositedFunds','asset','undeposited_funds','debit'),('accountsReceivable','asset','accounts_receivable','debit'),('retainageReceivable','asset','retainage_receivable','debit'),('contractAsset','asset','costs_in_excess','debit'),('workInProgress','asset','work_in_progress','debit'),('prepaidExpenses','asset','prepaid_expenses','debit'),('fixedAssets','asset','fixed_assets','debit'),('accumulatedDepreciation','asset','accumulated_depreciation','credit'),('accountsPayable','liability','accounts_payable','credit'),('retainagePayable','liability','retainage_payable','credit'),('creditCards','liability','credit_card','credit'),('payrollClearing','liability','payroll_clearing','credit'),('employeeReimbursements','liability','other_liability','credit'),('payrollDeductions','liability','other_liability','credit'),('salesUseTaxPayable','liability','sales_use_tax','credit'),('customerDeposits','liability','customer_deposits','credit'),('contractLiability','liability','billings_in_excess','credit'),('expectedLossReserve','liability','expected_contract_loss_reserve','credit'),('currentDebt','liability','current_debt','credit'),('longTermDebt','liability','long_term_debt','credit'),('ownerEquity','equity','owner_equity','credit'),('ownerContributions','equity','owner_contributions','credit'),('ownerDistributions','equity','owner_distributions','debit'),('retainedEarnings','equity','retained_earnings','credit'),('constructionRevenue','income','construction_revenue','credit'),('otherRevenue','income','other_revenue','credit'),('earlyPayDiscounts','income','early_pay_discount','credit'),('paymentFeeRecovery','income','payment_fee_recovery','credit'),('jobCosts','cogs','job_costs','debit'),('subcontractorCosts','cogs','subcontractor_costs','debit'),('materialCosts','cogs','material_costs','debit'),('laborCosts','cogs','direct_labor','debit'),('equipmentCosts','cogs','equipment_costs','debit'),('warrantyCosts','cogs','warranty_costs','debit'),('expectedLossExpense','cogs','expected_contract_loss_expense','debit'),('rentExpense','expense','rent','debit'),('insuranceExpense','expense','insurance','debit'),('softwareExpense','expense','software','debit'),('professionalFees','expense','professional_fees','debit'),('utilitiesExpense','expense','utilities','debit'),('bankFees','expense','bank_fees','debit'),('interestExpense','expense','interest','debit'),('payrollExpense','expense','payroll','debit'),('depreciationExpense','expense','depreciation','debit'),('badDebtExpense','expense','other_expense','debit'),('otherExpense','expense','other_expense','debit'),('ownedLand','asset','other_asset','debit'),('communityDevelopmentInventory','asset','other_asset','debit'),('completedHomeInventory','asset','work_in_progress','debit'),('warrantyReserve','liability','other_liability','credit'))r(role,account_type,subtype,normal_balance) where jsonb_typeof(controls->r.role) is distinct from 'string' or not exists(select 1 from jsonb_array_elements(accounts)a where a->>'code'=controls->>r.role and a->>'account_type'=r.account_type and a->>'subtype'=r.subtype and a->>'normal_balance'=r.normal_balance)) then raise exception 'Complete compatible construction control roles are required';end if;
 return true;
end $$;
create table public.books_entity_chart_versions(
 id uuid primary key,org_id uuid not null,legal_entity_id uuid not null,profile_id uuid not null,previous_reviewed_chart_id uuid,
 effective_on date not null check(effective_on between '1900-01-01' and '9997-12-31'),definition_text text not null check(octet_length(definition_text)<=4194304),definition_sha256 text not null check(definition_sha256 ~ '^[a-f0-9]{64}$'),
 prepared_by uuid not null references public.app_users(id),prepared_at timestamptz not null,prepared_access_event_id uuid not null,preparation_notes text not null check(length(btrim(preparation_notes)) between 10 and 2000),
 unique(org_id,legal_entity_id,id),unique(org_id,legal_entity_id,id,effective_on),
 foreign key(org_id,legal_entity_id,profile_id) references public.books_legal_entity_profiles(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id,previous_reviewed_chart_id) references public.books_entity_chart_versions(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id,prepared_access_event_id) references public.books_legal_entity_access_history(org_id,legal_entity_id,id),check(previous_reviewed_chart_id is distinct from id)
);
create table public.books_entity_accounts(
 id uuid primary key default gen_random_uuid(),org_id uuid not null,legal_entity_id uuid not null,code text not null check(length(code) between 1 and 32 and code=btrim(code) and code !~ '[[:cntrl:]]'),first_chart_id uuid not null,
 unique(org_id,legal_entity_id,id),unique(org_id,legal_entity_id,code),
 foreign key(org_id,legal_entity_id,first_chart_id) references public.books_entity_chart_versions(org_id,legal_entity_id,id)
);
create table public.books_entity_account_definitions(
 id uuid primary key default gen_random_uuid(),org_id uuid not null,legal_entity_id uuid not null,chart_id uuid not null,account_id uuid not null,parent_account_id uuid,
 name text not null,account_type text not null,subtype text not null,normal_balance text not null,cash_flow_category text,
 unique(chart_id,account_id),unique(org_id,legal_entity_id,chart_id,account_id),
 foreign key(org_id,legal_entity_id,chart_id) references public.books_entity_chart_versions(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id,account_id) references public.books_entity_accounts(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id,parent_account_id) references public.books_entity_accounts(org_id,legal_entity_id,id),check(parent_account_id is distinct from account_id)
);
create table public.books_entity_control_accounts(
 id uuid primary key default gen_random_uuid(),org_id uuid not null,legal_entity_id uuid not null,chart_id uuid not null,role text not null,account_id uuid not null,
 unique(chart_id,role),foreign key(org_id,legal_entity_id,chart_id,account_id) references public.books_entity_account_definitions(org_id,legal_entity_id,chart_id,account_id)
);
create table public.books_entity_chart_reviews(
 id uuid primary key,org_id uuid not null,legal_entity_id uuid not null,chart_id uuid not null unique,effective_on date not null,
 reviewed_by uuid not null references public.app_users(id),reviewed_at timestamptz not null,reviewed_access_event_id uuid not null,review_notes text not null check(length(btrim(review_notes)) between 10 and 2000),
 unique(org_id,legal_entity_id,effective_on),foreign key(org_id,legal_entity_id,chart_id,effective_on) references public.books_entity_chart_versions(org_id,legal_entity_id,id,effective_on),
 foreign key(org_id,legal_entity_id,reviewed_access_event_id) references public.books_legal_entity_access_history(org_id,legal_entity_id,id)
);
create function public.books_assert_entity_chart_receipt(p_id uuid)
returns boolean language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare p public.books_entity_chart_versions;actual jsonb;expected jsonb;controls jsonb;
begin
 select * into p from public.books_entity_chart_versions where id=p_id;
 if p.id is null then raise exception 'Entity chart not found';end if;
 perform public.books_validate_entity_chart(p.definition_text::jsonb);
 if p.definition_sha256 is distinct from encode(sha256(convert_to(p.definition_text,'UTF8')),'hex') then raise exception 'Original entity chart definition hash differs';end if;
 select jsonb_agg(jsonb_build_object('code',a.code,'name',d.name,'account_type',d.account_type,'subtype',d.subtype,'normal_balance',d.normal_balance,'cash_flow_category',d.cash_flow_category,'parent_code',parent.code) order by a.code) into actual from public.books_entity_account_definitions d join public.books_entity_accounts a on a.org_id=d.org_id and a.legal_entity_id=d.legal_entity_id and a.id=d.account_id left join public.books_entity_accounts parent on parent.org_id=d.org_id and parent.legal_entity_id=d.legal_entity_id and parent.id=d.parent_account_id where d.chart_id=p.id and d.org_id=p.org_id and d.legal_entity_id=p.legal_entity_id;
 select jsonb_agg(a order by a->>'code') into expected from jsonb_array_elements(p.definition_text::jsonb->'accounts')a;
 select jsonb_object_agg(c.role,a.code) into controls from public.books_entity_control_accounts c join public.books_entity_accounts a on a.id=c.account_id and a.org_id=c.org_id and a.legal_entity_id=c.legal_entity_id where c.chart_id=p.id and c.org_id=p.org_id and c.legal_entity_id=p.legal_entity_id;
 if actual is distinct from expected or controls is distinct from p.definition_text::jsonb->'controls' then raise exception 'Entity account/control rows differ from frozen chart';end if;return true;
end $$;
create function public.books_entity_chart_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare latest uuid;profile uuid;
begin
 perform 1 from public.books_legal_entities where org_id=new.org_id and id=new.legal_entity_id for update;
 if not found or not public.books_entity_has_access(new.org_id,new.legal_entity_id,new.prepared_by,'prepare') then raise exception 'Entity chart preparation access is required';end if;
 perform 1 from public.memberships where org_id=new.org_id and user_id=new.prepared_by and status='active' for share;if not found then raise exception 'Active chart maker membership is required';end if;
 select p.id into profile from public.books_legal_entity_profiles p join public.books_legal_entity_profile_reviews r on r.profile_id=p.id where p.org_id=new.org_id and p.legal_entity_id=new.legal_entity_id and p.effective_on<=new.effective_on order by p.revision desc limit 1;
 if profile is distinct from new.profile_id then raise exception 'Chart requires the applicable reviewed legal profile';end if;
 select p.id into latest from public.books_entity_chart_versions p join public.books_entity_chart_reviews r on r.chart_id=p.id where p.org_id=new.org_id and p.legal_entity_id=new.legal_entity_id order by p.effective_on desc limit 1;
 if latest is distinct from new.previous_reviewed_chart_id or exists(select 1 from public.books_entity_chart_versions p where p.id=latest and p.effective_on>=new.effective_on) then raise exception 'Chart predecessor or effective date is stale';end if;
 perform public.books_validate_entity_chart(new.definition_text::jsonb);new.definition_text:=(new.definition_text::jsonb)::text;new.definition_sha256:=encode(sha256(convert_to(new.definition_text,'UTF8')),'hex');new.prepared_at:=clock_timestamp();new.preparation_notes:=btrim(new.preparation_notes);
 select h.id into new.prepared_access_event_id from public.books_legal_entity_access_history h where h.org_id=new.org_id and h.legal_entity_id=new.legal_entity_id and h.user_id=new.prepared_by order by h.sequence_no desc limit 1;return new;
end $$;
create function public.books_entity_chart_complete() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin perform public.books_assert_entity_chart_receipt(new.id);return null;end $$;
create function public.books_entity_chart_child_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare chart uuid;p public.books_entity_chart_versions;code text;parent text;original jsonb;actual jsonb;
begin
 chart:=case when tg_table_name='books_entity_accounts' then (to_jsonb(new)->>'first_chart_id')::uuid else (to_jsonb(new)->>'chart_id')::uuid end;
 perform 1 from public.books_legal_entities where org_id=new.org_id and id=new.legal_entity_id for update;
 select * into p from public.books_entity_chart_versions where id=chart and org_id=new.org_id and legal_entity_id=new.legal_entity_id;
 if p.id is null or exists(select 1 from public.books_entity_chart_reviews where chart_id=chart) then raise exception 'Only an unreviewed same-entity chart can receive new account/control rows';end if;
 if tg_table_name='books_entity_accounts' then
 code:=to_jsonb(new)->>'code';if not exists(select 1 from jsonb_array_elements(p.definition_text::jsonb->'accounts')a where a->>'code'=code) then raise exception 'Entity account identity has no frozen original definition';end if;
 else
 select a.code into code from public.books_entity_accounts a where a.id=(to_jsonb(new)->>'account_id')::uuid and a.org_id=new.org_id and a.legal_entity_id=new.legal_entity_id;
 if tg_table_name='books_entity_control_accounts' then
 if (p.definition_text::jsonb->'controls'->>(to_jsonb(new)->>'role')) is distinct from code or code is null then raise exception 'Control binding differs from original chart definition';end if;
 else
 select a into original from jsonb_array_elements(p.definition_text::jsonb->'accounts')a where a->>'code'=code;
 select a.code into parent from public.books_entity_accounts a where a.id=(to_jsonb(new)->>'parent_account_id')::uuid and a.org_id=new.org_id and a.legal_entity_id=new.legal_entity_id;
 actual:=jsonb_build_object('code',code,'name',to_jsonb(new)->>'name','account_type',to_jsonb(new)->>'account_type','subtype',to_jsonb(new)->>'subtype','normal_balance',to_jsonb(new)->>'normal_balance','cash_flow_category',to_jsonb(new)->>'cash_flow_category','parent_code',parent);
 if original is null or original is distinct from actual then raise exception 'Account classification/parent differs from frozen chart';end if;
 end if;end if;return new;
end $$;
create function public.books_entity_chart_review_guard() returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare p public.books_entity_chart_versions;latest uuid;profile uuid;
begin
 perform 1 from public.books_legal_entities where org_id=new.org_id and id=new.legal_entity_id for update;
 select * into p from public.books_entity_chart_versions where org_id=new.org_id and legal_entity_id=new.legal_entity_id and id=new.chart_id;
 if p.id is null or not public.books_entity_has_access(new.org_id,new.legal_entity_id,new.reviewed_by,'review') or p.prepared_by=new.reviewed_by or not public.books_entity_has_access(new.org_id,new.legal_entity_id,p.prepared_by,'prepare') then raise exception 'Chart requires independent active maker and reviewer';end if;
 perform 1 from public.memberships where org_id=new.org_id and user_id in(p.prepared_by,new.reviewed_by) and status='active' order by user_id for share;if (select count(*) from public.memberships where org_id=new.org_id and user_id in(p.prepared_by,new.reviewed_by) and status='active')<>2 then raise exception 'Active chart maker and reviewer memberships are required';end if;
 select x.id into latest from public.books_entity_chart_versions x join public.books_entity_chart_reviews r on r.chart_id=x.id where x.org_id=new.org_id and x.legal_entity_id=new.legal_entity_id order by x.effective_on desc limit 1;
 select x.id into profile from public.books_legal_entity_profiles x join public.books_legal_entity_profile_reviews r on r.profile_id=x.id where x.org_id=new.org_id and x.legal_entity_id=new.legal_entity_id and x.effective_on<=p.effective_on order by x.revision desc limit 1;
 if latest is distinct from p.previous_reviewed_chart_id or profile is distinct from p.profile_id then raise exception 'Chart preparation is stale; prepare a fresh version';end if;
 perform public.books_assert_entity_chart_receipt(p.id);new.effective_on:=p.effective_on;new.reviewed_at:=clock_timestamp();new.review_notes:=btrim(new.review_notes);
 select h.id into new.reviewed_access_event_id from public.books_legal_entity_access_history h where h.org_id=new.org_id and h.legal_entity_id=new.legal_entity_id and h.user_id=new.reviewed_by order by h.sequence_no desc limit 1;return new;
end $$;
create trigger books_entity_chart_guard before insert on public.books_entity_chart_versions for each row execute function public.books_entity_chart_guard();
create constraint trigger books_entity_chart_complete after insert on public.books_entity_chart_versions deferrable initially deferred for each row execute function public.books_entity_chart_complete();
create trigger books_entity_chart_review_guard before insert on public.books_entity_chart_reviews for each row execute function public.books_entity_chart_review_guard();
do $$declare t text;begin
 foreach t in array array['books_entity_accounts','books_entity_account_definitions','books_entity_control_accounts'] loop execute format('create trigger books_entity_chart_child_guard before insert on public.%I for each row execute function public.books_entity_chart_child_guard()',t);end loop;
 foreach t in array array['books_entity_chart_versions','books_entity_accounts','books_entity_account_definitions','books_entity_control_accounts','books_entity_chart_reviews'] loop execute format('create trigger books_entity_chart_immutable before update or delete on public.%I for each row execute function public.books_entity_immutable()',t);execute format('alter table public.%I enable row level security',t);execute format('revoke all on public.%I from public,anon,authenticated',t);execute format('grant all on public.%I to service_role',t);end loop;
end $$;
create function public.prepare_books_entity_chart(p_org uuid,p_entity uuid,p_id uuid,p_profile uuid,p_previous uuid,p_actor uuid,p_effective date,p_definition jsonb,p_notes text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare p public.books_entity_chart_versions;
begin
 perform 1 from public.books_legal_entities where org_id=p_org and id=p_entity for update;if not found or not public.books_entity_has_access(p_org,p_entity,p_actor,'prepare') then raise exception 'Entity chart preparation access is required';end if;
 select * into p from public.books_entity_chart_versions where id=p_id;
 if found then
 if (p.org_id,p.legal_entity_id,p.profile_id,p.previous_reviewed_chart_id,p.prepared_by,p.effective_on,p.definition_text::jsonb,p.preparation_notes) is distinct from(p_org,p_entity,p_profile,p_previous,p_actor,p_effective,p_definition,btrim(p_notes)) then raise exception 'Chart retry differs from retained preparation';end if;
 else
 insert into public.books_entity_chart_versions(id,org_id,legal_entity_id,profile_id,previous_reviewed_chart_id,effective_on,definition_text,definition_sha256,prepared_by,prepared_at,prepared_access_event_id,preparation_notes) values(p_id,p_org,p_entity,p_profile,p_previous,p_effective,p_definition::text,repeat('0',64),p_actor,clock_timestamp(),p_id,p_notes) returning * into p;
 insert into public.books_entity_accounts(org_id,legal_entity_id,code,first_chart_id) select p_org,p_entity,a->>'code',p_id from jsonb_array_elements(p_definition->'accounts')a where not exists(select 1 from public.books_entity_accounts x where x.org_id=p_org and x.legal_entity_id=p_entity and x.code=a->>'code');
 insert into public.books_entity_account_definitions(org_id,legal_entity_id,chart_id,account_id,parent_account_id,name,account_type,subtype,normal_balance,cash_flow_category) select p_org,p_entity,p_id,account.id,parent.id,a->>'name',a->>'account_type',a->>'subtype',a->>'normal_balance',a->>'cash_flow_category' from jsonb_array_elements(p_definition->'accounts')a join public.books_entity_accounts account on account.org_id=p_org and account.legal_entity_id=p_entity and account.code=a->>'code' left join public.books_entity_accounts parent on parent.org_id=p_org and parent.legal_entity_id=p_entity and parent.code=a->>'parent_code';
 insert into public.books_entity_control_accounts(org_id,legal_entity_id,chart_id,role,account_id) select p_org,p_entity,p_id,c.key,account.id from jsonb_each_text(p_definition->'controls')c join public.books_entity_accounts account on account.org_id=p_org and account.legal_entity_id=p_entity and account.code=c.value;
 end if;
 perform public.books_assert_entity_chart_receipt(p.id);
 return jsonb_build_object('chart',to_jsonb(p),'ledgerActivated',false);
end $$;
create function public.review_books_entity_chart(p_org uuid,p_entity uuid,p_chart uuid,p_id uuid,p_actor uuid,p_notes text)
returns jsonb language plpgsql security invoker set search_path=pg_catalog,public as $$
declare r public.books_entity_chart_reviews;
begin
 perform 1 from public.books_legal_entities where org_id=p_org and id=p_entity for update;if not found or not public.books_entity_has_access(p_org,p_entity,p_actor,'review') then raise exception 'Entity chart review access is required';end if;
 select * into r from public.books_entity_chart_reviews where chart_id=p_chart;
 if found then if(r.id,r.org_id,r.legal_entity_id,r.reviewed_by,r.review_notes) is distinct from(p_id,p_org,p_entity,p_actor,btrim(p_notes)) then raise exception 'Chart retry differs from retained review';end if;perform public.books_assert_entity_chart_receipt(p_chart);
 else insert into public.books_entity_chart_reviews(id,org_id,legal_entity_id,chart_id,effective_on,reviewed_by,reviewed_at,reviewed_access_event_id,review_notes) values(p_id,p_org,p_entity,p_chart,current_date,p_actor,clock_timestamp(),p_id,p_notes) returning * into r;end if;
 return to_jsonb(r);
end $$;
do $$declare r record;begin
 for r in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in('books_validate_entity_chart','books_assert_entity_chart_receipt','books_entity_chart_guard','books_entity_chart_complete','books_entity_chart_child_guard','books_entity_chart_review_guard','prepare_books_entity_chart','review_books_entity_chart') loop execute format('revoke all on function %s from public,anon,authenticated',r.signature);execute format('grant execute on function %s to service_role',r.signature);end loop;
end $$;
create function public.read_books_entity_chart(p_org uuid,p_entity uuid,p_chart uuid,p_actor uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare c public.books_entity_chart_versions;result jsonb;
begin
 if not public.books_entity_has_access(p_org,p_entity,p_actor,'read') then raise exception 'Entity chart read access is required';end if;
 select * into c from public.books_entity_chart_versions where org_id=p_org and legal_entity_id=p_entity and id=p_chart;
 if not found then raise exception 'Entity chart was not found in this entity';end if;
 perform public.books_assert_entity_chart_receipt(c.id);
 select jsonb_build_object('chart',to_jsonb(c),'accounts',(select coalesce(jsonb_agg(to_jsonb(a) order by a.code),'[]') from public.books_entity_accounts a where a.org_id=p_org and a.legal_entity_id=p_entity and exists(select 1 from public.books_entity_account_definitions d where d.chart_id=c.id and d.account_id=a.id)), 'definitions',(select coalesce(jsonb_agg(to_jsonb(d) order by d.id),'[]') from public.books_entity_account_definitions d where d.chart_id=c.id and d.org_id=p_org and d.legal_entity_id=p_entity), 'controls',(select coalesce(jsonb_agg(to_jsonb(b) order by b.role),'[]') from public.books_entity_control_accounts b where b.chart_id=c.id and b.org_id=p_org and b.legal_entity_id=p_entity), 'review',(select to_jsonb(r) from public.books_entity_chart_reviews r where r.chart_id=c.id and r.org_id=p_org and r.legal_entity_id=p_entity),'ledgerActivated',false) into result;
 return result;
end $$;
create function public.read_books_entity_charts(p_org uuid,p_entity uuid,p_actor uuid,p_before uuid default null,p_limit integer default 50)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare ids uuid[];more boolean;last_id uuid;
begin
 if not public.books_entity_has_access(p_org,p_entity,p_actor,'read') then raise exception 'Entity chart read access is required';end if;
 if p_limit is null or p_limit<1 or p_limit>50 then raise exception 'Chart page limit must be between 1 and 50';end if;
 select array_agg(id order by id) into ids from (select id from public.books_entity_chart_versions where org_id=p_org and legal_entity_id=p_entity and (p_before is null or id>p_before) order by id limit p_limit+1)x;
 more:=coalesce(cardinality(ids),0)>p_limit;ids:=ids[1:p_limit];last_id:=ids[cardinality(ids)];
 return jsonb_build_object('orgId',p_org,'entityId',p_entity,'charts',(select coalesce(jsonb_agg(to_jsonb(c)-'definition_text' order by c.id),'[]') from public.books_entity_chart_versions c where c.id=any(ids) and c.org_id=p_org and c.legal_entity_id=p_entity),'reviews',(select coalesce(jsonb_agg(to_jsonb(r) order by r.id),'[]') from public.books_entity_chart_reviews r where r.chart_id=any(ids) and r.org_id=p_org and r.legal_entity_id=p_entity),'nextCursor',case when more then last_id else null end,'ledgerActivated',false);
end $$;
revoke all on function public.read_books_entity_chart(uuid,uuid,uuid,uuid), public.read_books_entity_charts(uuid,uuid,uuid,uuid,integer) from public,anon,authenticated;
grant execute on function public.read_books_entity_chart(uuid,uuid,uuid,uuid), public.read_books_entity_charts(uuid,uuid,uuid,uuid,integer) to service_role;
create index books_entity_chart_effective_idx on public.books_entity_chart_versions(org_id,legal_entity_id,effective_on,id);
alter function public.capture_books_export_snapshot(uuid) rename to capture_books_export_snapshot_before_entity_charts;
create function public.capture_books_export_snapshot(p_org_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare snapshot jsonb;rows jsonb;t text;
begin
 snapshot:=public.capture_books_export_snapshot_before_entity_charts(p_org_id);
 foreach t in array array['books_entity_chart_versions','books_entity_accounts','books_entity_account_definitions','books_entity_control_accounts','books_entity_chart_reviews'] loop
 execute format('select coalesce(jsonb_agg(to_jsonb(r) order by r.id),''[]'') from public.%I r where org_id=$1',t) into rows using p_org_id;
 snapshot:=jsonb_set(snapshot,array['tables',t],rows);end loop;return snapshot;
end $$;
revoke all on function public.capture_books_export_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.capture_books_export_snapshot(uuid) to service_role;
create or replace function public.capture_books_legacy_ownership_evidence(p_org uuid,p_actor uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_snapshot jsonb;v_tables jsonb;v_rows jsonb;
begin
 v_snapshot:=public.capture_books_entity_authorized_export(p_org,p_actor);
 v_tables:=(v_snapshot->'tables')-'books_legacy_entity_proposals'-'books_legacy_entity_reviews'-'books_journal_request_resolutions'-'books_entity_calendar_years'-'books_entity_fiscal_periods'-'books_entity_calendar_reviews'-'books_entity_chart_versions'-'books_entity_accounts'-'books_entity_account_definitions'-'books_entity_control_accounts'-'books_entity_chart_reviews';
 select coalesce(jsonb_agg(row-'tax_id'-'ein'-'ssn' order by row->>'id'),'[]'::jsonb) into v_rows from jsonb_array_elements(v_tables->'companies') row;
 v_tables:=jsonb_set(v_tables,'{companies}',v_rows);
 select coalesce(jsonb_agg((select jsonb_object_agg(key,value) from jsonb_each(row) where key=any(array['id','org_id','provider','bank_name','account_type','last4','status','books_gl_account_id','created_at','updated_at'])) order by row->>'id'),'[]'::jsonb) into v_rows from jsonb_array_elements(v_tables->'org_funding_sources') row;
 v_tables:=jsonb_set(v_tables,'{org_funding_sources}',v_rows);
 return jsonb_build_object('populationText',v_tables::text,'capturedAt',v_snapshot->'capturedAt','databaseSnapshot',v_snapshot->'databaseSnapshot');
end;
$$;
commit;
