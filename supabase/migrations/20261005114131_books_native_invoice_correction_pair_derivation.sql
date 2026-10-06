-- Pending: paired invoice correction derivation; no money or source changes.
-- Replacement uses the effective posting period while source policy and signed
-- closing eligibility retain the actual invoice date. Initial posting stays strict.
begin;
create function public.books_derive_native_invoice_replacement_draft(p_economic jsonb,p_id uuid)
returns jsonb language plpgsql immutable security invoker set search_path=pg_catalog,public as $$
declare c jsonb:=p_economic->'native';i jsonb:=c->'source';tax bigint;net bigint;held bigint;released bigint;gross bigint;lines jsonb:='[]';income jsonb:='[]';l jsonb;m jsonb;a jsonb;amount numeric;priced numeric:=0;contract jsonb;is_closing boolean;seen_closing boolean:=false;seen_progress boolean:=false;model text;disposition text;closing jsonb;policy jsonb:=p_economic->'policy';total numeric;
begin
 if c->>'sourceType'<>'invoice' or i->>'status' not in('sent','partial','paid','overdue') or (i->>'issue_date')::date>(c->>'entryDate')::date or p_id is null then raise exception 'Issued native invoice and available correction effective date are required';end if;
 if i->'metadata'->>'invoice_kind'='earnest_deposit' then raise exception 'Deposit request has no invoice journal; post its cash receipt separately';end if;
 if policy->>'status'<>'approved' or policy->>'org_id' is distinct from c->>'orgId' or policy->>'version' is distinct from p_economic->'settings'->>'active_policy_version' or policy->>'created_by' is null or policy->>'approved_by' is null or policy->>'created_by'=policy->>'approved_by' or (policy->>'created_at')::timestamptz>(policy->>'approved_at')::timestamptz or (policy->>'approved_at')::timestamptz>(c->>'capturedAt')::timestamptz or policy->>'effective_on'>i->>'issue_date' then raise exception 'Native invoice policy requires applicable independent approval';end if;
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
  for contract in select r from jsonb_array_elements(p_economic->'contracts') r where r->>'parent_contract_id' is null and r->>'status' in('active','amended','completed','terminated') and (r->>'effective_date' is null or r->>'effective_date'<=i->>'issue_date') loop
   model:=coalesce(case when p_economic->'financialSettings'->>'billing_model' in('fixed_price','cost_plus_fixed_fee','cost_plus_gmp','cost_plus_percent','time_and_materials') then p_economic->'financialSettings'->>'billing_model' end,case when contract->'snapshot'->>'billing_model' in('fixed_price','cost_plus_fixed_fee','cost_plus_gmp','cost_plus_percent','time_and_materials') then contract->'snapshot'->>'billing_model' end,case contract->>'contract_type' when 'time_materials' then 'time_and_materials' when 'cost_plus' then 'cost_plus_percent' else 'fixed_price' end);
   is_closing:=model='fixed_price' and contract->>'contract_type'='purchase_agreement';if coalesce(is_closing,false) then seen_closing:=true;else seen_progress:=true;end if;
  end loop;
  if seen_closing and seen_progress then raise exception 'Conflicting native primary revenue contracts';end if;
  if not seen_closing and not seen_progress and exists(select 1 from jsonb_array_elements(p_economic->'contracts') r where r->>'parent_contract_id' is null and r->>'status'='superseded' and (r->>'effective_date' is null or r->>'effective_date'<=i->>'issue_date')) then raise exception 'Historical native revenue contract evidence is required';end if;
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
   select r into closing from jsonb_array_elements(p_economic->'closings') r where r->>'status'='closed' and r->>'actual_date'=i->>'issue_date' and r->>'id'=i->'metadata'->>'source_closing_id';
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
 return jsonb_build_object('entryDate',c->>'entryDate','entryKind','adjusting','memo','Invoice '||(c->>'sourceId')||' — '||disposition,'postingKey','native-invoice-correction:'||p_id::text||':replacement:'||(c->>'sourceId'),'projectionVersion',1,'policyVersion',(policy->>'version')::integer,'sourceType','invoice','sourceId',c->>'sourceId','lines',lines);
end $$;
create function public.books_derive_native_invoice_correction_pair(p_org uuid,p_entity uuid,p_project uuid,p_actor uuid,p_id uuid,p_original uuid,p_economic jsonb,p_patch jsonb,p_notes text)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare fresh jsonb;r jsonb;candidate jsonb;rows jsonb:='[]';l jsonb;p jsonb;m jsonb;k text;v text;n integer;draft jsonb;
begin
 fresh:=public.books_validate_native_invoice_posting(p_org,p_entity,p_project,p_actor,p_economic);
 r:=public.books_derive_native_invoice_reversal(p_org,p_entity,p_project,p_actor,p_id,p_original,fresh->'native',p_notes);
 if jsonb_typeof(p_patch) is distinct from 'object' or p_patch-array['totalCents','taxCents','lines']<>'{}' or (select count(*) from jsonb_object_keys(p_patch))<>3 or octet_length(p_patch::text)>8400000 then raise exception 'Canonical bounded native replacement patch is required';end if;
 foreach k in array array['totalCents','taxCents'] loop v:=p_patch->>k;if jsonb_typeof(p_patch->k) is distinct from 'number' or v !~ '^(-?[1-9][0-9]*|0)$' or abs(v::numeric)>9007199254740991 then raise exception 'Native replacement requires exact integer cents';end if;end loop;
 if jsonb_typeof(p_patch->'lines') is distinct from 'array' or jsonb_array_length(p_patch->'lines') not between 0 and 1000 or (select count(distinct value->>'id') from jsonb_array_elements(p_patch->'lines'))<>jsonb_array_length(p_patch->'lines') then raise exception 'Complete unique priced replacement lines are required';end if;
 select count(*) into n from jsonb_array_elements(fresh->'lines') x where coalesce(x->'source'->'metadata'->>'system_generated_kind','')<>'retainage_hold';
 if n<>jsonb_array_length(p_patch->'lines') then raise exception 'Native replacement must cover every existing priced line';end if;
 for p in select value from jsonb_array_elements(p_patch->'lines') loop
  if jsonb_typeof(p) is distinct from 'object' or p-array['id','quantity','unitPriceCents','incomeAccountId']<>'{}' or (select count(*) from jsonb_object_keys(p))<>4 or jsonb_typeof(p->'id') is distinct from 'string' or (p->>'id')::uuid::text is distinct from p->>'id' or jsonb_typeof(p->'quantity') is distinct from 'string' or coalesce(p->>'quantity','') !~ '^-?[0-9]{1,12}(\.[0-9]{1,6})?$' or jsonb_typeof(p->'unitPriceCents') is distinct from 'number' or coalesce(p->>'unitPriceCents','') !~ '^(-?[1-9][0-9]*|0)$' or abs((p->>'unitPriceCents')::numeric)>9007199254740991 then raise exception 'Native replacement priced line is invalid';end if;
  if not exists(select 1 from jsonb_array_elements(fresh->'lines') x where x->'source'->>'id'=p->>'id' and coalesce(x->'source'->'metadata'->>'system_generated_kind','')<>'retainage_hold') then raise exception 'Native replacement line is missing or generated';end if;
  if p->'incomeAccountId' is distinct from 'null'::jsonb then
   if jsonb_typeof(p->'incomeAccountId') is distinct from 'string' or (p->>'incomeAccountId')::uuid::text is distinct from p->>'incomeAccountId' or not exists(select 1 from jsonb_array_elements(fresh->'native'->'accounts') a where a->>'id'=p->>'incomeAccountId' and a->'definition'->>'account_type'='income') then raise exception 'Native replacement income account is absent from reviewed entity chart';end if;
  end if;
 end loop;
 for l in select value from jsonb_array_elements(fresh->'lines') loop
  if coalesce(l->'source'->'metadata'->>'system_generated_kind','')<>'retainage_hold' then
   select value into p from jsonb_array_elements(p_patch->'lines') where value->>'id'=l->'source'->>'id';
   m:=(coalesce(nullif(l->'source'->'metadata','null'::jsonb),'{}'::jsonb)-array['arc_books_gl_account_id','arc_books_entity_account_id','arc_books_entity_income_selection_id'])||jsonb_build_object('arc_books_entity_correction_id',p_id);
   if p->'incomeAccountId'<>'null'::jsonb then m:=m||jsonb_build_object('arc_books_entity_account_id',p->'incomeAccountId');end if;
   l:=jsonb_set(jsonb_set(jsonb_set(jsonb_set(jsonb_set(l,'{quantity}',p->'quantity'),'{unitPriceCents}',to_jsonb(p->>'unitPriceCents')),'{source,quantity}',to_jsonb((p->>'quantity')::double precision)),'{source,unit_price_cents}',p->'unitPriceCents'),'{source,metadata}',m);
  end if;
  rows:=rows||jsonb_build_array(l);
 end loop;
 candidate:=jsonb_set(jsonb_set(jsonb_set(fresh,'{lines}',rows),'{native,source,total_cents}',p_patch->'totalCents'),'{native,source,tax_cents}',p_patch->'taxCents');
 draft:=public.books_derive_native_invoice_replacement_draft(candidate,p_id);
 return jsonb_build_object('reversal',r,'validatedEconomic',fresh,'patch',p_patch,'replacementEconomic',candidate,'replacementDraft',draft,'posted',false,'reviewed',false,'sourceChanged',false,'ledgerActivated',false);
end $$;
revoke all on function public.books_derive_native_invoice_replacement_draft(jsonb,uuid) from public,anon,authenticated;
grant execute on function public.books_derive_native_invoice_replacement_draft(jsonb,uuid) to service_role;
revoke all on function public.books_derive_native_invoice_correction_pair(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,text) from public,anon,authenticated;
grant execute on function public.books_derive_native_invoice_correction_pair(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,jsonb,text) to service_role;
commit;
