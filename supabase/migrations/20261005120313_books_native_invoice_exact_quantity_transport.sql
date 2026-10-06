-- Pending: canonical JSON number view plus authoritative exact decimal string.
-- Money is calculated from quantity::text, never the rounded JSON number view.
-- This fixes valid large decimal invoices failing after a JSON/JavaScript round trip.
-- Pending: authoritative invoice economics in the same statement snapshot as
-- reviewed native routing. Read only; no official activation or journal writes.
begin;
create or replace function public.read_books_native_invoice_economic_context(p_org uuid,p_project uuid,p_source_type text,p_source_id uuid,p_actor uuid,p_entry_date date)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare c jsonb;settings jsonb;policy jsonb;result jsonb;
begin
 if p_source_type is distinct from 'invoice' then raise exception 'Native invoice economics require an actual invoice';end if;
 c:=public.read_books_native_project_posting_context(p_org,p_project,p_source_type,p_source_id,p_actor,p_entry_date);
 select to_jsonb(s) into settings from public.books_settings s where s.org_id=p_org and s.workspace_enabled;
 select to_jsonb(p) into policy from public.accounting_policies p where p.org_id=p_org and p.version=(settings->>'active_policy_version')::integer and p.status='approved' and p.effective_on<=p_entry_date;
 if settings is null or policy is null then raise exception 'Applicable active approved Books policy is required for native invoice economics';end if;
 result:=jsonb_build_object('native',c,'settings',settings,'policy',policy,
 'project',(select to_jsonb(p) from public.projects p where p.org_id=p_org and p.id=p_project),
 'financialSettings',(select to_jsonb(s) from public.project_financial_settings s where s.org_id=p_org and s.project_id=p_project),
 'contracts',coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from public.contracts r where r.org_id=p_org and r.project_id=p_project),'[]'::jsonb),
 'lines',coalesce((select jsonb_agg(jsonb_build_object('source',to_jsonb(l)||jsonb_build_object('quantity',l.quantity::double precision),'quantity',l.quantity::text,'unitPriceCents',l.unit_price_cents::text,'costCode',(select to_jsonb(k) from public.cost_codes k where k.org_id=p_org and k.id=l.cost_code_id)) order by l.id) from public.invoice_lines l where l.org_id=p_org and l.invoice_id=p_source_id),'[]'::jsonb),
 'retainage',coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from public.retainage r where r.org_id=p_org and (r.invoice_id=p_source_id or r.release_invoice_id=p_source_id)),'[]'::jsonb),
 'originalInvoices',coalesce((select jsonb_agg(to_jsonb(i) order by i.id) from public.invoices i where i.org_id=p_org and exists(select 1 from public.retainage r where r.org_id=p_org and r.release_invoice_id=p_source_id and r.invoice_id=i.id)),'[]'::jsonb),
 'closings',coalesce((select jsonb_agg(to_jsonb(r) order by r.id) from public.closings r where r.org_id=p_org and r.project_id=p_project and r.closing_invoice_id=p_source_id),'[]'::jsonb),
 'postingHold',(select to_jsonb(h) from public.books_native_period_holds h where h.org_id=p_org and h.legal_entity_id=(c->'owner'->>'legal_entity_id')::uuid and h.period_id=(c->'period'->>'id')::uuid order by h.sequence_no desc limit 1));
 if octet_length(result::text)>4194304 or jsonb_array_length(result->'lines')>1000 or jsonb_array_length(result->'retainage')>1000 or jsonb_array_length(result->'contracts')>1000 then raise exception 'Native invoice economic snapshot exceeds its bounded inventory';end if;
 return result;
end $$;
revoke all on function public.read_books_native_invoice_economic_context(uuid,uuid,text,uuid,uuid,date) from public,anon,authenticated;
grant execute on function public.read_books_native_invoice_economic_context(uuid,uuid,text,uuid,uuid,date) to service_role;
commit;
