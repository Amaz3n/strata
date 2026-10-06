-- One statement snapshot for invoice revision, native chart selection and lines.
-- Service-only and invoker rights: this never turns membership into chart access.
create or replace function public.books_invoice_income_evidence(p_org_id uuid,p_invoice_ids uuid[])
returns jsonb language sql stable security invoker set search_path=pg_catalog,public as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',i.id,'updated_at',i.updated_at,
    'lines',coalesce((select jsonb_agg(jsonb_build_object(
      'id',l.id,'quantity',l.quantity::text,'unit_price_cents',l.unit_price_cents,
      'cost_code_id',l.cost_code_id,'metadata',l.metadata,
      'selected_account',case when a.id is null then null else jsonb_build_object('id',a.id,'code',a.code,'account_type',a.account_type,'active',a.active) end
    ) order by l.id) from public.invoice_lines l
    left join public.gl_accounts a on a.org_id=i.org_id and a.id::text=l.metadata->>'arc_books_gl_account_id'
    where l.org_id=i.org_id and l.invoice_id=i.id),'[]'::jsonb)
  ) order by i.id),'[]'::jsonb)
  from public.invoices i where i.org_id=p_org_id and i.id=any(p_invoice_ids);
$$;
revoke all on function public.books_invoice_income_evidence(uuid,uuid[]) from public,anon,authenticated;
grant execute on function public.books_invoice_income_evidence(uuid,uuid[]) to service_role;
