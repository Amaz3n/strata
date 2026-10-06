begin;
-- Preserve the authoritative decimal before JSON crosses a JavaScript boundary.
-- Exact strings restore into numeric columns without an IEEE-754 round trip.
alter function public.capture_books_export_snapshot(uuid) rename to capture_books_export_snapshot_before_exact_invoice_quantity;
create function public.capture_books_export_snapshot(p_org_id uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare s jsonb;rows jsonb;
begin
 s:=public.capture_books_export_snapshot_before_exact_invoice_quantity(p_org_id);
 select coalesce(jsonb_agg(case when to_jsonb(r)?'quantity' then to_jsonb(r)||jsonb_build_object('quantity',to_jsonb(r)->>'quantity') else to_jsonb(r) end order by id),'[]') into rows
 from public.invoice_lines r where org_id=p_org_id;
 return jsonb_set(s,'{tables,invoice_lines}',rows);
end $$;
revoke all on function public.capture_books_export_snapshot(uuid) from public,anon,authenticated;
grant execute on function public.capture_books_export_snapshot(uuid) to service_role;
revoke all on function public.capture_books_export_snapshot_before_exact_invoice_quantity(uuid) from public,anon,authenticated;
grant execute on function public.capture_books_export_snapshot_before_exact_invoice_quantity(uuid) to service_role;
-- Ownership approvals retain their original SQL JSON population protocol.
-- Transport encoding must not invalidate an unchanged frozen review.
alter function public.capture_books_legacy_ownership_evidence(uuid,uuid) rename to capture_books_legacy_ownership_before_exact_invoice_quantity;
create function public.capture_books_legacy_ownership_evidence(p_org uuid,p_actor uuid)
returns jsonb language plpgsql stable security invoker set search_path=pg_catalog,public as $$
declare s jsonb;t jsonb;rows jsonb;
begin
 s:=public.capture_books_legacy_ownership_before_exact_invoice_quantity(p_org,p_actor);
 t:=(s->>'populationText')::jsonb;
 if not(t?'invoice_lines') then return s;end if;
 select coalesce(jsonb_agg(to_jsonb(r) order by id),'[]') into rows from public.invoice_lines r where org_id=p_org;
 t:=jsonb_set(t,'{invoice_lines}',rows);
 return jsonb_set(s,'{populationText}',to_jsonb(t::text));
end $$;
revoke all on function public.capture_books_legacy_ownership_evidence(uuid,uuid) from public,anon,authenticated;
grant execute on function public.capture_books_legacy_ownership_evidence(uuid,uuid) to service_role;
revoke all on function public.capture_books_legacy_ownership_before_exact_invoice_quantity(uuid,uuid) from public,anon,authenticated;
grant execute on function public.capture_books_legacy_ownership_before_exact_invoice_quantity(uuid,uuid) to service_role;
commit;
