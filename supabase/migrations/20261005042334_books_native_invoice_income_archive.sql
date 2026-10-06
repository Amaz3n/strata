-- Pending: selection provenance and complete schema28 capture; no activation.
begin;
alter table public.books_native_invoice_postings add column income_selection_id uuid;
alter table public.books_native_invoice_postings add foreign key(org_id,legal_entity_id,income_selection_id) references public.books_native_invoice_income_selections(org_id,legal_entity_id,id);
create index books_native_invoice_posting_income on public.books_native_invoice_postings(org_id,legal_entity_id,income_selection_id);
create or replace function public.books_native_invoice_income_posting_guard()
returns trigger language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare e jsonb:=new.request_text::jsonb;l jsonb;chosen text;recorded text;r public.books_native_invoice_income_selections;
begin
 select * into r from public.books_native_invoice_income_selections where org_id=new.org_id and legal_entity_id=new.legal_entity_id and invoice_id=new.invoice_id order by selection_revision desc limit 1;
 for l in select value from jsonb_array_elements(e->'lines') loop
  if l->'source'->'metadata'->>'system_generated_kind'='retainage_hold' then continue;end if;
  if l->'source'->'metadata'->>'arc_books_entity_income_selection_id' is distinct from r.id::text then raise exception 'Native income source lost its authorized selection identity';end if;
  chosen:=l->'source'->'metadata'->>'arc_books_entity_account_id';
  select v->'source'->'metadata'->>'arc_books_entity_account_id' into recorded from jsonb_array_elements(coalesce(r.result_text::jsonb->'lines','[]'::jsonb)) v where v->'source'->>'id'=l->'source'->>'id';
  if chosen is distinct from recorded then raise exception 'Native income requires its authorized source selection receipt';end if;
 end loop;
 new.income_selection_id:=r.id;
 return new;
end $$;
alter function public.capture_books_export_snapshot(uuid) rename to capture_books_export_snapshot_before_native_invoice_income;
create function public.capture_books_export_snapshot(p_org_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare s jsonb;rows jsonb;
begin s:=public.capture_books_export_snapshot_before_native_invoice_income(p_org_id);select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') into rows from public.books_native_invoice_income_selections r where org_id=p_org_id;return jsonb_set(s,'{tables}',s->'tables'||jsonb_build_object('books_native_invoice_income_selections',rows));end $$;
revoke all on function public.capture_books_export_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.capture_books_export_snapshot(uuid) to service_role;
create or replace function public.capture_books_legacy_ownership_evidence(p_org uuid,p_actor uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare v_snapshot jsonb;v_tables jsonb;v_rows jsonb;
begin
 v_snapshot:=public.capture_books_entity_authorized_export(p_org,p_actor);
 v_tables:=(v_snapshot->'tables')-'books_legacy_entity_proposals'-'books_legacy_entity_reviews'-'books_journal_request_resolutions'-'books_project_owner_request_resolutions'-'books_native_period_holds'-'books_native_invoice_income_selections'-'books_native_invoice_request_resolutions'-'books_native_invoice_postings'-'books_native_adjustment_facts'-'books_native_adjustment_reviews'-'books_native_journal_entries'-'books_native_journal_lines'-'books_entity_calendar_years'-'books_entity_fiscal_periods'-'books_entity_calendar_reviews'-'books_entity_chart_versions'-'books_entity_accounts'-'books_entity_account_definitions'-'books_entity_control_accounts'-'books_entity_chart_reviews';
 select coalesce(jsonb_agg(row-'tax_id'-'ein'-'ssn' order by row->>'id'),'[]'::jsonb) into v_rows from jsonb_array_elements(v_tables->'companies') row;
 v_tables:=jsonb_set(v_tables,'{companies}',v_rows);
 select coalesce(jsonb_agg((select jsonb_object_agg(key,value) from jsonb_each(row) where key=any(array['id','org_id','provider','bank_name','account_type','last4','status','books_gl_account_id','created_at','updated_at'])) order by row->>'id'),'[]'::jsonb) into v_rows from jsonb_array_elements(v_tables->'org_funding_sources') row;
 v_tables:=jsonb_set(v_tables,'{org_funding_sources}',v_rows);
 return jsonb_build_object('populationText',v_tables::text,'capturedAt',v_snapshot->'capturedAt','databaseSnapshot',v_snapshot->'databaseSnapshot');
end;
$$;

commit;
