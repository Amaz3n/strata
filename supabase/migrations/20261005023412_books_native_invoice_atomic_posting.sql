-- Pending: one native ledger for source-derived operational invoices and manual adjustments.
-- Explicit actor/scope authorization precedes private writes; no official activation.
begin;
create schema if not exists arc_private;
revoke all on schema arc_private from public,anon;
create table public.books_native_invoice_postings(
 id uuid primary key,org_id uuid not null,legal_entity_id uuid not null,project_id uuid not null,invoice_id uuid not null,entry_id uuid not null unique,
 owner_review_id uuid not null,chart_id uuid not null,period_id uuid not null,entry_date date not null,
 request_text text not null check(octet_length(request_text)<=4194304),request_sha256 text not null check(request_sha256 ~ '^[a-f0-9]{64}$'),
 validated_economic_text text not null check(octet_length(validated_economic_text)<=4194304),validated_economic_sha256 text not null check(validated_economic_sha256 ~ '^[a-f0-9]{64}$'),
 draft_text text not null,draft_sha256 text not null check(draft_sha256 ~ '^[a-f0-9]{64}$'),
 posted_by uuid not null references public.app_users(id),access_event_id uuid not null,posted_at timestamptz not null,notes text not null check(length(notes) between 10 and 2000 and notes=btrim(notes)),
 unique(org_id,legal_entity_id,id),unique(org_id,legal_entity_id,invoice_id),
 foreign key(org_id,project_id) references public.projects(org_id,id),foreign key(org_id,invoice_id) references public.invoices(org_id,id),
 foreign key(org_id,legal_entity_id,project_id,owner_review_id) references public.books_project_entity_reviews(org_id,legal_entity_id,project_id,id),
 foreign key(org_id,legal_entity_id,chart_id) references public.books_entity_chart_versions(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id,period_id) references public.books_entity_fiscal_periods(org_id,legal_entity_id,id),
 foreign key(org_id,legal_entity_id,access_event_id) references public.books_legal_entity_access_history(org_id,legal_entity_id,id)
);
create index books_native_invoice_postings_scope on public.books_native_invoice_postings(org_id,legal_entity_id,project_id,entry_date,id);
create index books_native_invoice_postings_actor on public.books_native_invoice_postings(posted_by);
create index books_native_invoice_postings_access on public.books_native_invoice_postings(org_id,legal_entity_id,access_event_id);
alter table public.books_native_journal_entries alter column fact_id drop not null,alter column review_id drop not null;
alter table public.books_native_journal_entries add column source_posting_id uuid;
alter table public.books_native_journal_entries add foreign key(org_id,legal_entity_id,source_posting_id) references public.books_native_invoice_postings(org_id,legal_entity_id,id);
alter table public.books_native_journal_entries add constraint books_native_journal_origin check((source_posting_id is null and fact_id is not null and review_id is not null) or(source_posting_id is not null and fact_id is null and review_id is null));
create unique index books_native_journal_source_owner on public.books_native_journal_entries(source_posting_id) where source_posting_id is not null;
-- Coordination only: existing source RLS/writer permissions still authorize each
-- mutation. This private trigger grants no source or financial-history authority,
-- returns only the caller's original row, and exposes no evidence. Definer rights
-- allow existing authenticated contract/retainage writers to acquire private
-- owner/fence locks without granting them access to accounting setup tables.
create function arc_private.books_native_economic_fence()
returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare row_data jsonb;old_data jsonb;new_data jsonb;e record;org uuid;project uuid;invoice uuid;
begin
 if tg_table_schema<>'public' or tg_table_name not in('invoices','invoice_lines','retainage','contracts','project_financial_settings','projects','accounting_policies','books_settings','closings','cost_codes') then raise exception 'Unsupported native economic coordination source';end if;
 if current_setting('role',true) in('anon','authenticated') and auth.uid() is null then raise exception 'Authenticated source coordination requires a live identity';end if;
 old_data:=case when tg_op<>'INSERT' then to_jsonb(old) end;new_data:=case when tg_op<>'DELETE' then to_jsonb(new) end;
 if tg_table_name='invoices' and old_data is not null and exists(select 1 from public.books_native_invoice_postings p where p.org_id=(old_data->>'org_id')::uuid and p.invoice_id=(old_data->>'id')::uuid) then
  if new_data is null or (new_data->'org_id',new_data->'project_id',new_data->'issue_date',new_data->'total_cents',new_data->'tax_cents',new_data->'metadata'->'invoice_kind',new_data->'metadata'->'source_closing_id',new_data->'metadata'->'settlement') is distinct from(old_data->'org_id',old_data->'project_id',old_data->'issue_date',old_data->'total_cents',old_data->'tax_cents',old_data->'metadata'->'invoice_kind',old_data->'metadata'->'source_closing_id',old_data->'metadata'->'settlement') or new_data->>'status' not in('sent','partial','paid','overdue') then raise exception 'Posted native invoice economics require governed reversal/replacement';end if;
 end if;
 if tg_table_name='invoice_lines' and exists(select 1 from public.books_native_invoice_postings p where exists(select 1 from jsonb_array_elements(jsonb_build_array(old_data,new_data)) x(r) where p.org_id=(r->>'org_id')::uuid and p.invoice_id=(r->>'invoice_id')::uuid)) then
  if old_data is null or new_data is null or (new_data->'org_id',new_data->'invoice_id',new_data->'quantity',new_data->'unit_price_cents',new_data->'cost_code_id',new_data->'metadata'->'system_generated_kind',new_data->'metadata'->'arc_books_gl_account_id',new_data->'metadata'->'arc_books_entity_account_id',new_data->'metadata'->'arc_books_entity_income_selection_id') is distinct from(old_data->'org_id',old_data->'invoice_id',old_data->'quantity',old_data->'unit_price_cents',old_data->'cost_code_id',old_data->'metadata'->'system_generated_kind',old_data->'metadata'->'arc_books_gl_account_id',old_data->'metadata'->'arc_books_entity_account_id',old_data->'metadata'->'arc_books_entity_income_selection_id') then raise exception 'Posted native invoice lines require governed reversal/replacement';end if;
 end if;
 if tg_table_name='retainage' and exists(select 1 from public.books_native_invoice_postings p where exists(select 1 from jsonb_array_elements(jsonb_build_array(old_data,new_data)) x(r) where p.org_id=(r->>'org_id')::uuid and p.invoice_id=(r->>'invoice_id')::uuid)) then
  if old_data is null or new_data is null or (new_data->'org_id',new_data->'project_id',new_data->'invoice_id',new_data->'amount_cents') is distinct from(old_data->'org_id',old_data->'project_id',old_data->'invoice_id',old_data->'amount_cents') then raise exception 'Posted native original retainage requires governed correction';end if;
 end if;
 if tg_table_name='retainage' and old_data is not null and exists(select 1 from public.books_native_invoice_postings p where p.org_id=(old_data->>'org_id')::uuid and p.invoice_id=(old_data->>'release_invoice_id')::uuid) then
  if new_data is null or (new_data->'org_id',new_data->'project_id',new_data->'invoice_id',new_data->'release_invoice_id',new_data->'amount_cents') is distinct from(old_data->'org_id',old_data->'project_id',old_data->'invoice_id',old_data->'release_invoice_id',old_data->'amount_cents') then raise exception 'Posted native retainage release requires governed correction';end if;
 end if;
 if tg_table_name='closings' and old_data is not null and exists(select 1 from public.books_native_invoice_postings p where p.org_id=(old_data->>'org_id')::uuid and p.invoice_id=(old_data->>'closing_invoice_id')::uuid) then
  if new_data is null or (new_data->'org_id',new_data->'project_id',new_data->'closing_invoice_id',new_data->'status',new_data->'actual_date',new_data->'settlement') is distinct from(old_data->'org_id',old_data->'project_id',old_data->'closing_invoice_id',old_data->'status',old_data->'actual_date',old_data->'settlement') then raise exception 'Posted native closing settlement requires governed correction';end if;
 end if;
 if tg_table_name='accounting_policies' and old_data is not null and exists(select 1 from public.books_native_invoice_postings p where p.org_id=(old_data->>'org_id')::uuid and p.validated_economic_text::jsonb->'policy'->>'id'=old_data->>'id') then
  if new_data is null or (new_data-array['status','updated_at','approval_note']) is distinct from(old_data-array['status','updated_at','approval_note']) or new_data->>'status' not in('approved','superseded') then raise exception 'Used native policy evidence is immutable; approve a new version';end if;
 end if;

 -- Both old and new affiliations participate; lock owners in a total order.
 for e in
  select distinct r.org_id,r.legal_entity_id from public.books_project_entity_reviews r
  where exists(select 1 from jsonb_array_elements(jsonb_build_array(old_data,new_data)) x(body)
   where body<>'null'::jsonb and r.org_id=(body->>'org_id')::uuid and
   (tg_table_name in('accounting_policies','books_settings','cost_codes') or
    r.project_id=case when tg_table_name='projects' then (body->>'id')::uuid when tg_table_name='invoice_lines' then(select i.project_id from public.invoices i where i.org_id=(body->>'org_id')::uuid and i.id=(body->>'invoice_id')::uuid) else (body->>'project_id')::uuid end))
  order by r.org_id,r.legal_entity_id
 loop
  perform 1 from public.books_legal_entities where org_id=e.org_id and id=e.legal_entity_id for update;
  perform public.books_bump_native_entity_fence(e.org_id,e.legal_entity_id);
 end loop;
 if tg_op='DELETE' then return old;end if;return new;
end $$;
revoke all on function arc_private.books_native_economic_fence() from public,anon,authenticated,service_role;
do $$declare t text;begin foreach t in array array['invoices','invoice_lines','retainage','contracts','project_financial_settings','projects','accounting_policies','books_settings','closings','cost_codes'] loop execute format('create trigger books_native_economic_fence before insert or update or delete on public.%I for each row execute function arc_private.books_native_economic_fence()',t);end loop;end $$;
-- Deterministic source economics. Journal legs are derived here, never supplied.
create function public.books_native_invoice_leg(p_context jsonb,p_role text,p_amount bigint,p_side text,p_code text default null,p_dimensions jsonb default null)
returns jsonb language sql immutable security invoker set search_path=pg_catalog,public as $$
 select case when p_amount=0 then '[]'::jsonb else jsonb_build_array(jsonb_build_object('accountCode',coalesce(p_code,(p_context->'chart'->>'definition_text')::jsonb->'controls'->>p_role),'projectId',p_context->>'projectId','debitCents',case when (p_amount>0)=(p_side='debit') then abs(p_amount) else 0 end,'creditCents',case when (p_amount>0)=(p_side='credit') then abs(p_amount) else 0 end) || case when p_code is null then jsonb_build_object('accountRole',p_role) else '{}'::jsonb end || case when p_dimensions is null then '{}'::jsonb else jsonb_build_object('dimensions',p_dimensions) end) end;
$$;
create function public.books_derive_native_invoice_draft(p_economic jsonb)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare c jsonb:=p_economic->'native';i jsonb:=c->'source';tax bigint;net bigint;held bigint;released bigint;gross bigint;lines jsonb:='[]';income jsonb:='[]';l jsonb;m jsonb;a jsonb;amount numeric;priced numeric:=0;contract jsonb;is_closing boolean;seen_closing boolean:=false;seen_progress boolean:=false;model text;disposition text;closing jsonb;policy jsonb:=p_economic->'policy';total numeric;
begin
 if c->>'sourceType'<>'invoice' or i->>'status' not in('sent','partial','paid','overdue') or i->>'issue_date' is distinct from c->>'entryDate' then raise exception 'Issued native invoice and original issue date are required';end if;
 if i->'metadata'->>'invoice_kind'='earnest_deposit' then raise exception 'Deposit request has no invoice journal; post its cash receipt separately';end if;
 if policy->>'status'<>'approved' or policy->>'org_id' is distinct from c->>'orgId' or policy->>'version' is distinct from p_economic->'settings'->>'active_policy_version' or policy->>'created_by' is null or policy->>'approved_by' is null or policy->>'created_by'=policy->>'approved_by' or (policy->>'created_at')::timestamptz>(policy->>'approved_at')::timestamptz or (policy->>'approved_at')::timestamptz>(c->>'capturedAt')::timestamptz or policy->>'effective_on'>c->>'entryDate' then raise exception 'Native invoice policy requires applicable independent approval';end if;
 if coalesce(i->>'total_cents','') !~ '^(-?[1-9][0-9]*|0)$' or coalesce(i->>'tax_cents','') !~ '^(-?[1-9][0-9]*|0)$' then raise exception 'Native invoice principal and tax require integer cents';end if;
 net:=(i->>'total_cents')::bigint;tax:=(i->>'tax_cents')::bigint;
 select coalesce(sum((r->>'amount_cents')::numeric),0)::bigint into held from jsonb_array_elements(p_economic->'retainage') r where r->>'invoice_id'=c->>'sourceId';
 select coalesce(sum((r->>'amount_cents')::numeric),0)::bigint into released from jsonb_array_elements(p_economic->'retainage') r where r->>'release_invoice_id'=c->>'sourceId';
 gross:=net+held;if abs(net)>9007199254740991 or abs(tax)>9007199254740991 or held<0 or held>9007199254740991 or abs(gross)>9007199254740991 then raise exception 'Native invoice money exceeds supported exact cents';end if;
 if exists(select 1 from jsonb_array_elements(p_economic->'retainage') r where r->>'release_invoice_id'=c->>'sourceId') then
  if held<>0 or tax<>0 or net<=0 or net<>released or exists(select 1 from jsonb_array_elements(p_economic->'retainage') r where r->>'release_invoice_id'=c->>'sourceId' and not exists(select 1 from jsonb_array_elements(p_economic->'originalInvoices') o where o->>'id'=r->>'invoice_id' and o->>'org_id'=c->>'orgId' and o->>'project_id'=c->>'projectId')) then raise exception 'Native retainage release does not tie to original project principal';end if;
  lines:=public.books_native_invoice_leg(c,'accountsReceivable',net,'debit')||public.books_native_invoice_leg(c,'retainageReceivable',net,'credit');disposition:='retainage_release';
 else
  if gross=0 or abs(tax)>abs(gross) or (tax<>0 and sign(tax)<>sign(gross)) or (held<>0 and gross<0) then raise exception 'Native invoice gross/tax/retainage differs';end if;
  -- Same billing-model and primary-contract policy as the application choke point;
  -- equivalence is tested across model/snapshot/type/effective/status combinations.
  for contract in select r from jsonb_array_elements(p_economic->'contracts') r where r->>'parent_contract_id' is null and r->>'status' in('active','amended','completed','terminated') and (r->>'effective_date' is null or r->>'effective_date'<=c->>'entryDate') loop
   model:=coalesce(case when p_economic->'financialSettings'->>'billing_model' in('fixed_price','cost_plus_fixed_fee','cost_plus_gmp','cost_plus_percent','time_and_materials') then p_economic->'financialSettings'->>'billing_model' end,case when contract->'snapshot'->>'billing_model' in('fixed_price','cost_plus_fixed_fee','cost_plus_gmp','cost_plus_percent','time_and_materials') then contract->'snapshot'->>'billing_model' end,case contract->>'contract_type' when 'time_materials' then 'time_and_materials' when 'cost_plus' then 'cost_plus_percent' else 'fixed_price' end);
   is_closing:=model='fixed_price' and contract->>'contract_type'='purchase_agreement';if coalesce(is_closing,false) then seen_closing:=true;else seen_progress:=true;end if;
  end loop;
  if seen_closing and seen_progress then raise exception 'Conflicting native primary revenue contracts';end if;
  if not seen_closing and not seen_progress and exists(select 1 from jsonb_array_elements(p_economic->'contracts') r where r->>'parent_contract_id' is null and r->>'status'='superseded' and (r->>'effective_date' is null or r->>'effective_date'<=c->>'entryDate')) then raise exception 'Historical native revenue contract evidence is required';end if;
  for l in select value from jsonb_array_elements(p_economic->'lines') loop
   m:=coalesce(l->'source'->'metadata','{}');if m->>'system_generated_kind'='retainage_hold' then continue;end if;
   if m->>'arc_books_gl_account_id' is not null then raise exception 'Legacy income selection requires reviewed native account selection';end if;
   if coalesce(l->>'quantity','') !~ '^-?[0-9]{1,12}(\.[0-9]{1,6})?$' or coalesce(l->>'unitPriceCents','') !~ '^(-?[1-9][0-9]*|0)$' or abs((l->>'unitPriceCents')::numeric)>9007199254740991 then raise exception 'Exact bounded native invoice pricing is required';end if;
   amount:=round((l->>'quantity')::numeric*(l->>'unitPriceCents')::numeric);if abs(amount)>9007199254740991 then raise exception 'Native priced line exceeds safe cents';end if;priced:=priced+amount;
   select r into a from jsonb_array_elements(c->'accounts') r where case when m->>'arc_books_entity_account_id' is not null then r->>'id'=m->>'arc_books_entity_account_id' else r->>'code'=(c->'chart'->>'definition_text')::jsonb->'controls'->>'constructionRevenue' end;
   if a is null or a->'definition'->>'account_type'<>'income' then raise exception 'Native invoice income account is absent from owner chart';end if;
   income:=income||public.books_native_invoice_leg(c,'constructionRevenue',amount::bigint,'credit',a->>'code',case when l->'source'->>'cost_code_id' is not null then jsonb_build_object('cost_code_id',l->'source'->>'cost_code_id') end);
  end loop;
  if jsonb_array_length(p_economic->'lines')=0 or priced<>gross-tax then raise exception 'Native priced lines do not equal gross excluding tax';end if;
  lines:=public.books_native_invoice_leg(c,'accountsReceivable',net,'debit')||public.books_native_invoice_leg(c,'retainageReceivable',held,'debit');
  if seen_closing then
   select r into closing from jsonb_array_elements(p_economic->'closings') r where r->>'status'='closed' and r->>'actual_date'=c->>'entryDate' and r->>'id'=i->'metadata'->>'source_closing_id';
   if i->'metadata'->>'invoice_kind' is distinct from 'closing' or closing is null or gross<=0 or (closing->'settlement'->>'finalPriceCents')::bigint<>gross or closing->'settlement' is distinct from i->'metadata'->'settlement' or closing->'settlement'->'agreement'->>'signed_at' is null or not exists(select 1 from jsonb_array_elements(p_economic->'contracts') r where r->>'id'=closing->'settlement'->>'contractId') then raise exception 'Exact completed native closing settlement is required';end if;
   -- Complete settlement arithmetic is separately validated by the source-native
   -- SQL helper before write, not just by a browser/server preview.
   perform public.books_assert_native_closing_settlement(closing->'settlement');
   lines:=lines||income;disposition:='closing_revenue';
  else
   if i->'metadata'->>'invoice_kind'='closing' or jsonb_array_length(p_economic->'closings')<>0 then raise exception 'Native closing source conflicts with project policy';end if;
   lines:=lines||public.books_native_invoice_leg(c,'contractLiability',gross-tax,'credit');disposition:='progress_billing';
  end if;
  lines:=lines||public.books_native_invoice_leg(c,'salesUseTaxPayable',tax,'credit');
 end if;
 if jsonb_array_length(lines) not between 2 and 1000 then raise exception 'Bounded complete native invoice journal is required';end if;
 select sum((j->>'debitCents')::numeric) into total from jsonb_array_elements(lines) j;
 if total>9007199254740991 or total<>(select sum((j->>'creditCents')::numeric) from jsonb_array_elements(lines) j) then raise exception 'Native invoice journal is unbalanced or exceeds safe cents';end if;
 return jsonb_build_object('entryDate',c->>'entryDate','entryKind','operational','memo','Invoice '||(c->>'sourceId')||' — '||disposition,'postingKey','native-invoice:'||(c->>'sourceId'),'projectionVersion',1,'policyVersion',(policy->>'version')::integer,'sourceType','invoice','sourceId',c->>'sourceId','lines',lines);
end $$;
create function public.books_assert_native_closing_settlement(s jsonb)
returns void language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare k text;arr text;row jsonb;changes numeric;adjustments numeric;deposits numeric;priced numeric;final numeric;
begin
 if jsonb_typeof(s)<>'object' or s->>'contractId' is null or s->'agreement'->>'id' is distinct from s->>'contractId' or coalesce(s->>'agreementEvidenceDigest','') !~ '^[a-f0-9]{64}$' then raise exception 'Original native closing agreement evidence is incomplete';end if;
 foreach arr in array array['changeOrders','adjustments','depositsApplied'] loop
  if jsonb_typeof(s->arr) is distinct from 'array' then raise exception 'Original closing monetary arrays are required';end if;
 end loop;
 foreach arr in array array['structuralOptions','designSelections','incentives'] loop
  if jsonb_typeof(s->'pricing'->arr) is distinct from 'array' then raise exception 'Original closing price inventory is required';end if;
 end loop;
 -- Reject fractional, absent, or unsafe components before summing: opposing
 -- malformed values must not cancel into an apparently valid integer total.
 for row in
  select v from (values
   (s->'finalPriceCents'),(s->'depositsAppliedCents'),(s->'balanceDueCents'),
   (s->'pricing'->'basePriceCents'),(s->'pricing'->'lotPremiumCents'),(s->'pricing'->'totalCents'),
   (s->'pricing'->'structuralOptionsCents'),(s->'pricing'->'designSelectionsCents'),(s->'pricing'->'incentivesCents'),
   (s->'components'->'agreementTotalCents'),(s->'components'->'approvedChangeOrdersCents'),(s->'components'->'adjustmentsCents')) x(v)
  union all select r->'total_cents' from jsonb_array_elements(s->'changeOrders') r
  union all select r->'amountCents' from jsonb_array_elements(s->'adjustments') r
  union all select r->'amountCents' from jsonb_array_elements(s->'depositsApplied') r
  union all select r->'priceCents' from jsonb_array_elements(s->'pricing'->'structuralOptions') r
  union all select r->'priceCents' from jsonb_array_elements(s->'pricing'->'designSelections') r
  union all select r->'valueCents' from jsonb_array_elements(s->'pricing'->'incentives') r
 loop
  if jsonb_typeof(row) is distinct from 'number' or coalesce(row::text,'') !~ '^(-?[1-9][0-9]*|0)$' then raise exception 'Original closing components require exact integer cents';end if;
  if abs(row::text::numeric)>9007199254740991 then raise exception 'Original closing component exceeds safe cents';end if;
 end loop;
 if (s->'pricing'->>'structuralOptionsCents')::numeric is distinct from(select coalesce(sum((r->>'priceCents')::numeric),0) from jsonb_array_elements(s->'pricing'->'structuralOptions') r) or
    (s->'pricing'->>'designSelectionsCents')::numeric is distinct from(select coalesce(sum((r->>'priceCents')::numeric),0) from jsonb_array_elements(s->'pricing'->'designSelections') r) or
    (s->'pricing'->>'incentivesCents')::numeric is distinct from(select coalesce(sum((r->>'valueCents')::numeric),0) from jsonb_array_elements(s->'pricing'->'incentives') r) then raise exception 'Original closing pricing subtotals differ';end if;
 if exists(select 1 from jsonb_array_elements(s->'changeOrders') r group by r->>'id' having count(*)>1) or exists(select 1 from jsonb_array_elements(s->'depositsApplied') r group by r->>'paymentId' having count(*)>1) then raise exception 'Closing contains duplicate source money';end if;
 select coalesce(sum((r->>'total_cents')::numeric),0) into changes from jsonb_array_elements(s->'changeOrders') r;
 select coalesce(sum((r->>'amountCents')::numeric),0) into adjustments from jsonb_array_elements(s->'adjustments') r;
 select coalesce(sum((r->>'amountCents')::numeric),0) into deposits from jsonb_array_elements(s->'depositsApplied') r;
 priced:=(s->'pricing'->>'basePriceCents')::numeric+(s->'pricing'->>'lotPremiumCents')::numeric+(select coalesce(sum((r->>'priceCents')::numeric),0) from jsonb_array_elements(s->'pricing'->'structuralOptions') r)+(select coalesce(sum((r->>'priceCents')::numeric),0) from jsonb_array_elements(s->'pricing'->'designSelections') r)-(select coalesce(sum((r->>'valueCents')::numeric),0) from jsonb_array_elements(s->'pricing'->'incentives') r);
 final:=(s->'components'->>'agreementTotalCents')::numeric+changes+adjustments;
 if priced is null or final is null or final<>trunc(final) or abs(final)>9007199254740991 or priced is distinct from (s->'pricing'->>'totalCents')::numeric or priced is distinct from(s->'components'->>'agreementTotalCents')::numeric or changes is distinct from(s->'components'->>'approvedChangeOrdersCents')::numeric or adjustments is distinct from(s->'components'->>'adjustmentsCents')::numeric or final is distinct from(s->>'finalPriceCents')::numeric or deposits is distinct from(s->>'depositsAppliedCents')::numeric or final-deposits is distinct from(s->>'balanceDueCents')::numeric or deposits<0 or final-deposits<0 or coalesce((select jsonb_agg(r->'id' order by ord) from jsonb_array_elements(s->'changeOrders') with ordinality x(r,ord)),'[]') is distinct from s->'components'->'changeOrderIds' then raise exception 'Original native closing settlement does not reconcile';end if;
end $$;
create function public.books_validate_native_invoice_posting(p_org uuid,p_entity uuid,p_project uuid,p_actor uuid,p_economic jsonb)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare c jsonb:=p_economic->'native';fresh jsonb;original jsonb;observed jsonb;
begin
 if (c->>'orgId',c->'owner'->>'legal_entity_id',c->>'projectId',c->>'actorId',c->>'sourceType') is distinct from(p_org::text,p_entity::text,p_project::text,p_actor::text,'invoice') then raise exception 'Native invoice economics belong to another scope or actor';end if;
 perform public.books_lock_native_adjustment_scope(p_org,p_entity,p_project,p_actor,'prepare','invoice',(c->>'sourceId')::uuid);
 fresh:=public.read_books_native_invoice_economic_context(p_org,p_project,'invoice',(c->>'sourceId')::uuid,p_actor,(c->>'entryDate')::date);
 original:=jsonb_set(p_economic,'{native}',c-array['capturedAt','databaseSnapshot']);observed:=jsonb_set(fresh,'{native}',(fresh->'native')-array['capturedAt','databaseSnapshot']);
 if original is distinct from observed or (c->>'capturedAt')::timestamptz>clock_timestamp() then raise exception 'Native invoice economic snapshot changed; capture current original evidence';end if;
 perform public.books_assert_native_period_available(p_org,p_entity,(c->'period'->>'id')::uuid);
 return fresh;
end $$;
create function public.books_native_invoice_posting_guard()
returns trigger language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare economic jsonb;fresh jsonb;c jsonb;draft jsonb;
begin
 economic:=new.request_text::jsonb;fresh:=public.books_validate_native_invoice_posting(new.org_id,new.legal_entity_id,new.project_id,new.posted_by,economic);c:=fresh->'native';draft:=public.books_derive_native_invoice_draft(fresh);
 if new.invoice_id is distinct from(c->>'sourceId')::uuid then raise exception 'Native posting invoice identity differs';end if;
 new.owner_review_id:=(c->'owner'->>'id')::uuid;new.chart_id:=(c->'chart'->>'id')::uuid;new.period_id:=(c->'period'->>'id')::uuid;new.entry_date:=(c->>'entryDate')::date;
 new.request_text:=economic::text;new.request_sha256:=encode(sha256(convert_to(new.request_text,'UTF8')),'hex');new.validated_economic_text:=fresh::text;new.validated_economic_sha256:=encode(sha256(convert_to(new.validated_economic_text,'UTF8')),'hex');new.draft_text:=draft::text;new.draft_sha256:=encode(sha256(convert_to(new.draft_text,'UTF8')),'hex');new.posted_at:=clock_timestamp();new.notes:=btrim(new.notes);
 select id into new.access_event_id from public.books_legal_entity_access_history where org_id=new.org_id and legal_entity_id=new.legal_entity_id and user_id=new.posted_by order by sequence_no desc limit 1;
 return new;
end $$;
create trigger books_native_invoice_posting_guard before insert on public.books_native_invoice_postings for each row execute function public.books_native_invoice_posting_guard();
create trigger books_native_invoice_posting_immutable before update or delete on public.books_native_invoice_postings for each row execute function public.books_entity_immutable();
alter table public.books_native_invoice_postings enable row level security;
revoke all on public.books_native_invoice_postings from public,anon,authenticated,service_role;
grant select,insert on public.books_native_invoice_postings to service_role;

create or replace function public.books_native_journal_entry_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare f public.books_native_adjustment_facts;r public.books_native_adjustment_reviews;d jsonb;s public.books_native_invoice_postings;fresh jsonb;
begin
 if new.source_posting_id is not null then
  select * into s from public.books_native_invoice_postings where org_id=new.org_id and legal_entity_id=new.legal_entity_id and id=new.source_posting_id;
  if s.id is null or s.entry_id is distinct from new.id or new.fact_id is not null or new.review_id is not null then raise exception 'Native invoice journal requires its exact source receipt';end if;
  fresh:=public.books_validate_native_invoice_posting(s.org_id,s.legal_entity_id,s.project_id,s.posted_by,s.validated_economic_text::jsonb);
  d:=public.books_derive_native_invoice_draft(fresh);if d is distinct from s.draft_text::jsonb then raise exception 'Native source-derived draft changed before header';end if;
  new.chart_id:=s.chart_id;new.period_id:=s.period_id;new.project_id:=s.project_id;new.entry_date:=s.entry_date;new.memo:=d->>'memo';new.posted_at:=s.posted_at;
  select sum((l->>'debitCents')::numeric)::bigint into new.total_cents from jsonb_array_elements(d->'lines') l;return new;
 end if;
 select * into r from public.books_native_adjustment_reviews where org_id=new.org_id and legal_entity_id=new.legal_entity_id and id=new.review_id;
 if r.id is null or r.decision<>'approve' or r.entry_id is distinct from new.id or r.fact_id is distinct from new.fact_id then raise exception 'Native journal requires its exact approved adjustment receipt';end if;
 select * into f from public.books_native_adjustment_facts where org_id=new.org_id and legal_entity_id=new.legal_entity_id and id=r.fact_id;
 perform public.books_lock_native_adjustment_scope(new.org_id,new.legal_entity_id,f.project_id,r.reviewed_by,'review',f.source_type,f.source_id);
 perform public.books_validate_native_adjustment_request(new.org_id,new.legal_entity_id,f.project_id,f.prepared_by,f.id,f.request_text::jsonb);
 d:=f.request_text::jsonb->'draft';
 new.chart_id:=f.chart_id;new.period_id:=f.period_id;new.project_id:=f.project_id;new.entry_date:=f.entry_date;new.memo:=d->>'memo';
 select sum((l->>'debitCents')::numeric)::bigint into new.total_cents from jsonb_array_elements(d->'lines') l;new.posted_at:=r.reviewed_at;return new;
end $$;
create or replace function public.books_native_journal_line_guard()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
declare e public.books_native_journal_entries;f public.books_native_adjustment_facts;l jsonb;wanted_code text;account uuid;s public.books_native_invoice_postings;context jsonb;draft jsonb;
begin
 select * into e from public.books_native_journal_entries where org_id=new.org_id and legal_entity_id=new.legal_entity_id and id=new.entry_id;if not found then raise exception 'Native journal entry is missing or foreign';end if;
 if e.source_posting_id is not null then
  select * into s from public.books_native_invoice_postings where org_id=e.org_id and legal_entity_id=e.legal_entity_id and id=e.source_posting_id;draft:=s.draft_text::jsonb;context:=s.validated_economic_text::jsonb->'native';
 else
  select * into f from public.books_native_adjustment_facts where org_id=e.org_id and legal_entity_id=e.legal_entity_id and id=e.fact_id;draft:=f.request_text::jsonb->'draft';context:=f.validated_context_text::jsonb;
 end if;
 l:=draft->'lines'->(new.position-1);if l is null or new.position<1 then raise exception 'Native journal leg is outside original monetary draft';end if;
 if l ? 'accountRole' then wanted_code:=(context->'chart'->>'definition_text')::jsonb->'controls'->>(l->>'accountRole');else wanted_code:=l->>'accountCode';end if;
 select a.id into account from public.books_entity_accounts a join public.books_entity_account_definitions d on d.org_id=a.org_id and d.legal_entity_id=a.legal_entity_id and d.account_id=a.id and d.chart_id=e.chart_id where a.org_id=e.org_id and a.legal_entity_id=e.legal_entity_id and a.code=wanted_code;
 if (new.account_id,new.chart_id,new.project_id,new.debit_cents,new.credit_cents,new.description,new.company_id,new.cost_code_id,new.dimensions) is distinct from(account,e.chart_id,e.project_id,(l->>'debitCents')::bigint,(l->>'creditCents')::bigint,l->>'description',(l->>'companyId')::uuid,(l->'dimensions'->>'cost_code_id')::uuid,coalesce(l->'dimensions','{}'::jsonb)) then raise exception 'Native journal leg differs from original reviewed adjustment';end if;return new;
end $$;
create function public.books_assert_native_invoice_complete(p_org uuid,p_entity uuid,p_id uuid)
returns void language plpgsql security invoker set search_path=pg_catalog,public as $$
declare s public.books_native_invoice_postings;e public.books_native_journal_entries;n integer;debits numeric;credits numeric;
begin
 select * into s from public.books_native_invoice_postings where org_id=p_org and legal_entity_id=p_entity and id=p_id;
 if s.id is null then raise exception 'Native invoice receipt is missing';end if;
 select * into e from public.books_native_journal_entries where org_id=p_org and legal_entity_id=p_entity and source_posting_id=p_id;
 if e.id is null or e.id<>s.entry_id or e.fact_id is not null or e.review_id is not null then raise exception 'Native invoice source receipt requires its complete original journal';end if;
 select count(*),coalesce(sum(debit_cents),0),coalesce(sum(credit_cents),0) into n,debits,credits from public.books_native_journal_lines where org_id=p_org and legal_entity_id=p_entity and entry_id=e.id;
 if n<>jsonb_array_length(s.draft_text::jsonb->'lines') or debits<>credits or debits<>e.total_cents or debits<=0 then raise exception 'Native invoice source journal is incomplete or unbalanced';end if;
end $$;
create function public.books_native_invoice_complete()
returns trigger language plpgsql security invoker set search_path=pg_catalog,public as $$
begin
 if tg_table_name='books_native_invoice_postings' then perform public.books_assert_native_invoice_complete(new.org_id,new.legal_entity_id,new.id);
 elsif new.source_posting_id is not null then perform public.books_assert_native_invoice_complete(new.org_id,new.legal_entity_id,new.source_posting_id);end if;return new;
end $$;
create constraint trigger books_native_invoice_receipt_complete after insert on public.books_native_invoice_postings deferrable initially deferred for each row execute function public.books_native_invoice_complete();
create constraint trigger books_native_invoice_journal_complete after insert on public.books_native_journal_entries deferrable initially deferred for each row execute function public.books_native_invoice_complete();
create function public.post_books_native_invoice(p_org uuid,p_entity uuid,p_project uuid,p_actor uuid,p_id uuid,p_entry uuid,p_economic jsonb,p_notes text)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare s public.books_native_invoice_postings;e public.books_native_journal_entries;lines jsonb;created boolean:=false;
begin
 perform 1 from public.books_legal_entities where org_id=p_org and id=p_entity for update;
 if not found or not public.books_entity_has_access(p_org,p_entity,p_actor,'prepare') then raise exception 'Current native invoice preparation access is required';end if;
 select * into s from public.books_native_invoice_postings where id=p_id;
 if found then
  if(s.org_id,s.legal_entity_id,s.project_id,s.posted_by,s.entry_id,s.request_text::jsonb,s.notes) is distinct from(p_org,p_entity,p_project,p_actor,p_entry,p_economic,btrim(p_notes)) then raise exception 'Native invoice posting retry differs from original request';end if;
 else
  insert into public.books_native_invoice_postings(id,org_id,legal_entity_id,project_id,invoice_id,entry_id,owner_review_id,chart_id,period_id,entry_date,request_text,request_sha256,validated_economic_text,validated_economic_sha256,draft_text,draft_sha256,posted_by,access_event_id,posted_at,notes)
  values(p_id,p_org,p_entity,p_project,(p_economic->'native'->>'sourceId')::uuid,p_entry,p_id,p_id,p_id,current_date,p_economic::text,repeat('0',64),'{}',repeat('0',64),'{}',repeat('0',64),p_actor,p_id,clock_timestamp(),p_notes) returning * into s;
  insert into public.books_native_journal_entries(id,org_id,legal_entity_id,source_posting_id,chart_id,period_id,project_id,entry_date,memo,total_cents,posted_at)
  values(p_entry,p_org,p_entity,p_id,s.chart_id,s.period_id,s.project_id,s.entry_date,'pending',1,clock_timestamp()) returning * into e;
  insert into public.books_native_journal_lines(org_id,legal_entity_id,entry_id,chart_id,project_id,position,account_id,debit_cents,credit_cents,description,company_id,cost_code_id,dimensions)
  select p_org,p_entity,p_entry,s.chart_id,s.project_id,l.position::integer,a.id,(l.body->>'debitCents')::bigint,(l.body->>'creditCents')::bigint,null,null,(l.body->'dimensions'->>'cost_code_id')::uuid,coalesce(l.body->'dimensions','{}'::jsonb)
  from jsonb_array_elements(s.draft_text::jsonb->'lines') with ordinality l(body,position)
  join public.books_entity_accounts a on a.org_id=p_org and a.legal_entity_id=p_entity and a.code=l.body->>'accountCode';created:=true;
 end if;
 perform public.books_assert_native_invoice_complete(p_org,p_entity,p_id);
 select * into e from public.books_native_journal_entries where org_id=p_org and legal_entity_id=p_entity and source_posting_id=p_id;
 select coalesce(jsonb_agg(to_jsonb(l) order by position),'[]') into lines from public.books_native_journal_lines l where org_id=p_org and legal_entity_id=p_entity and entry_id=e.id;
 return jsonb_build_object('posting',to_jsonb(s),'entry',to_jsonb(e),'lines',lines,'created',created,'posted',true,'ledgerActivated',false);
end $$;
create function public.read_books_native_invoice_posting(p_org uuid,p_entity uuid,p_project uuid,p_id uuid,p_actor uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare s public.books_native_invoice_postings;e public.books_native_journal_entries;lines jsonb;
begin
 if not public.books_entity_has_access(p_org,p_entity,p_actor,'read') then raise exception 'Current native invoice read access is required';end if;
 select * into s from public.books_native_invoice_postings where org_id=p_org and legal_entity_id=p_entity and project_id=p_project and id=p_id;
 select * into e from public.books_native_journal_entries where org_id=p_org and legal_entity_id=p_entity and source_posting_id=s.id;
 select coalesce(jsonb_agg(to_jsonb(l) order by position),'[]') into lines from public.books_native_journal_lines l where org_id=p_org and legal_entity_id=p_entity and entry_id=e.id;
 return jsonb_build_object('orgId',p_org,'entityId',p_entity,'projectId',p_project,'id',p_id,'actorId',p_actor,'posting',case when s.id is null then null else to_jsonb(s) end,'entry',case when e.id is null then null else to_jsonb(e) end,'lines',lines);
end $$;
alter function public.capture_books_export_snapshot(uuid) rename to capture_books_export_snapshot_before_native_invoices;
create function public.capture_books_export_snapshot(p_org_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare s jsonb;rows jsonb;
begin s:=public.capture_books_export_snapshot_before_native_invoices(p_org_id);select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') into rows from public.books_native_invoice_postings r where org_id=p_org_id;return jsonb_set(s,'{tables}',s->'tables'||jsonb_build_object('books_native_invoice_postings',rows));end $$;
revoke all on function public.capture_books_export_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.capture_books_export_snapshot(uuid) to service_role;
do $$declare r record;begin
 for r in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and (proname like 'books_native_invoice_%' or proname in('books_assert_native_closing_settlement','books_derive_native_invoice_draft','books_validate_native_invoice_posting','books_assert_native_invoice_complete','post_books_native_invoice','read_books_native_invoice_posting','capture_books_export_snapshot_before_native_invoices')) loop execute format('revoke all on function %s from public,anon,authenticated',r.signature);execute format('grant execute on function %s to service_role',r.signature);end loop;
end $$;
create or replace function public.capture_books_legacy_ownership_evidence(p_org uuid,p_actor uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_snapshot jsonb;v_tables jsonb;v_rows jsonb;
begin
 v_snapshot:=public.capture_books_entity_authorized_export(p_org,p_actor);
 v_tables:=(v_snapshot->'tables')-'books_legacy_entity_proposals'-'books_legacy_entity_reviews'-'books_journal_request_resolutions'-'books_project_owner_request_resolutions'-'books_native_period_holds'-'books_native_invoice_postings'-'books_native_adjustment_facts'-'books_native_adjustment_reviews'-'books_native_journal_entries'-'books_native_journal_lines'-'books_entity_calendar_years'-'books_entity_fiscal_periods'-'books_entity_calendar_reviews'-'books_entity_chart_versions'-'books_entity_accounts'-'books_entity_account_definitions'-'books_entity_control_accounts'-'books_entity_chart_reviews';
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
