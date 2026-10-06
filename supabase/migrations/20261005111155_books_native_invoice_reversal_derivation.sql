-- Pending: independently derive a complete invoice reversal from retained money.
-- Preparation only; reviewed correction persistence follows in a separate protocol.
begin;
create function public.books_derive_native_invoice_reversal(
 p_org uuid,p_entity uuid,p_project uuid,p_actor uuid,p_id uuid,
 p_original uuid,p_context jsonb,p_notes text
)
returns jsonb language plpgsql volatile security invoker set search_path=pg_catalog,public as $$
declare
 s public.books_native_invoice_postings;e public.books_native_journal_entries;
 row public.books_native_journal_lines;c jsonb;old_context jsonb;old_draft jsonb;
 original_request jsonb;validated jsonb;l jsonb;a jsonb;old_a jsonb;
 legs jsonb:='[]';journal text;draft jsonb;original_rows jsonb;code text;
begin
 select * into s from public.books_native_invoice_postings where org_id=p_org and legal_entity_id=p_entity and project_id=p_project and id=p_original;
 if s.id is null then raise exception 'Original native invoice posting is missing or foreign';end if;
 if p_id is null or p_id in(s.id,s.entry_id) then raise exception 'Distinct native correction identity is required';end if;
 if p_notes is null or length(p_notes) not between 10 and 2000 or p_notes<>btrim(p_notes) then raise exception 'Original native correction explanation is required';end if;
 if (p_context->>'orgId',p_context->>'actorId',p_context->>'projectId',p_context->'owner'->>'legal_entity_id',p_context->>'sourceType',p_context->>'sourceId') is distinct from(p_org::text,p_actor::text,p_project::text,p_entity::text,'invoice',s.invoice_id::text) then raise exception 'Native reversal context differs from original scope';end if;
 perform public.books_lock_native_adjustment_scope(p_org,p_entity,p_project,p_actor,'prepare','invoice',s.invoice_id);
 c:=public.read_books_native_project_posting_context(p_org,p_project,'invoice',s.invoice_id,p_actor,(p_context->>'entryDate')::date);
 if (p_context-array['capturedAt','databaseSnapshot']) is distinct from(c-array['capturedAt','databaseSnapshot']) or (p_context->>'capturedAt') is null or (p_context->>'capturedAt')::timestamptz>clock_timestamp() or (p_context->>'capturedAt')::timestamptz<s.posted_at or (c->>'entryDate')::date<s.entry_date then raise exception 'Native reversal snapshot or chronology changed';end if;
 perform public.books_assert_native_period_available(p_org,p_entity,(c->'period'->>'id')::uuid);
 perform public.books_assert_native_invoice_complete(p_org,p_entity,p_original);
 if encode(sha256(convert_to(s.request_text,'UTF8')),'hex') is distinct from s.request_sha256 or encode(sha256(convert_to(s.validated_economic_text,'UTF8')),'hex') is distinct from s.validated_economic_sha256 or encode(sha256(convert_to(s.draft_text,'UTF8')),'hex') is distinct from s.draft_sha256 then raise exception 'Original native invoice retained checksum differs';end if;
 original_request:=s.request_text::jsonb;validated:=s.validated_economic_text::jsonb;old_context:=validated->'native';old_draft:=s.draft_text::jsonb;
 if jsonb_set(original_request,'{native}',(original_request->'native')-array['capturedAt','databaseSnapshot']) is distinct from jsonb_set(validated,'{native}',old_context-array['capturedAt','databaseSnapshot']) or public.books_derive_native_invoice_draft(validated) is distinct from old_draft then raise exception 'Original native invoice economic or draft history differs';end if;
 if (old_context->>'orgId',old_context->'owner'->>'legal_entity_id',old_context->>'projectId',old_context->>'sourceId',old_context->>'sourceType',old_context->>'actorId',old_context->'owner'->>'id',old_context->'chart'->>'id',old_context->'period'->>'id',old_context->>'entryDate') is distinct from(s.org_id::text,s.legal_entity_id::text,s.project_id::text,s.invoice_id::text,'invoice',s.posted_by::text,s.owner_review_id::text,s.chart_id::text,s.period_id::text,s.entry_date::text) or (old_context->>'capturedAt')::timestamptz>s.posted_at then raise exception 'Original native invoice scope or chronology differs';end if;
 select * into e from public.books_native_journal_entries where org_id=p_org and legal_entity_id=p_entity and id=s.entry_id;
 if (e.chart_id,e.period_id,e.project_id,e.entry_date,e.memo,e.posted_at) is distinct from(s.chart_id,s.period_id,s.project_id,s.entry_date,old_draft->>'memo',s.posted_at) then raise exception 'Original native invoice journal header differs';end if;
 for row in select * from public.books_native_journal_lines where org_id=p_org and legal_entity_id=p_entity and entry_id=e.id order by position loop
  l:=old_draft->'lines'->(row.position-1);
  code:=case when l ? 'accountRole' then (old_context->'chart'->>'definition_text')::jsonb->'controls'->>(l->>'accountRole') else l->>'accountCode' end;
  select value into old_a from jsonb_array_elements(old_context->'accounts') where value->>'code'=code;
  if l is null or (row.account_id,row.chart_id,row.project_id,row.debit_cents,row.credit_cents,row.description,row.company_id,row.cost_code_id,row.dimensions) is distinct from((old_a->>'id')::uuid,s.chart_id,s.project_id,(l->>'debitCents')::bigint,(l->>'creditCents')::bigint,l->>'description',(l->>'companyId')::uuid,(l->'dimensions'->>'cost_code_id')::uuid,coalesce(l->'dimensions','{}'::jsonb)) then raise exception 'Original native invoice journal leg differs';end if;
  select value into a from jsonb_array_elements(c->'accounts') where value->>'id'=row.account_id::text;
  if a is null then raise exception 'Original reversal account is absent from applicable entity chart';end if;
  if (a->'definition'->'account_type',a->'definition'->'subtype',a->'definition'->'normal_balance',a->'definition'->'cash_flow_category') is distinct from(old_a->'definition'->'account_type',old_a->'definition'->'subtype',old_a->'definition'->'normal_balance',old_a->'definition'->'cash_flow_category') then raise exception 'Original reversal account classification changed';end if;
  legs:=legs||jsonb_build_array(jsonb_build_object('accountCode',a->>'code','debitCents',row.credit_cents,'creditCents',row.debit_cents,'projectId',row.project_id,'dimensions',row.dimensions)||case when row.company_id is null then '{}'::jsonb else jsonb_build_object('companyId',row.company_id) end||case when row.description is null then '{}'::jsonb else jsonb_build_object('description',row.description) end);
 end loop;
 select coalesce(jsonb_agg(to_jsonb(r) order by position),'[]') into original_rows from public.books_native_journal_lines r where org_id=p_org and legal_entity_id=p_entity and entry_id=e.id;
 journal:=jsonb_build_object('entry',to_jsonb(e),'lines',original_rows)::text;
 draft:=jsonb_build_object('entryDate',c->>'entryDate','entryKind','reversal','memo',p_notes,'postingKey','native-invoice-correction:'||p_id::text||':reversal:'||s.id::text,'projectionVersion',old_draft->'projectionVersion','policyVersion',old_draft->'policyVersion','sourceType','invoice','sourceId',s.invoice_id,'lines',legs);
 return jsonb_build_object('draft',draft,'validatedContext',c,'originalPosting',to_jsonb(s),'originalJournalText',journal,'originalJournalSha256',encode(sha256(convert_to(journal,'UTF8')),'hex'),'posted',false,'reviewed',false,'sourceChanged',false,'ledgerActivated',false);
end $$;
revoke all on function public.books_derive_native_invoice_reversal(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,text) from public,anon,authenticated;
grant execute on function public.books_derive_native_invoice_reversal(uuid,uuid,uuid,uuid,uuid,uuid,jsonb,text) to service_role;
commit;
