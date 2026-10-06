-- STAGED, UNAPPLIED. Requires generated-artifact release-scope helper.
-- This fences purchasing domain records; ledger/land postings remain separate.
create function public.fence_starts_purchasing_write() returns trigger
language plpgsql set search_path=public,pg_catalog as $$
declare v_headers jsonb; v_pkg public.start_packages%rowtype; v_rows jsonb[]; v_row jsonb;
  v_project uuid; v_lot uuid; v_company uuid; v_type text;
begin
  v_headers:=coalesce(nullif(current_setting('request.headers',true),''),'{}')::jsonb;
  if v_headers->>'x-starts-job-id' is null and v_headers->>'x-starts-claim-token' is null then
    if tg_op='DELETE' then return old; end if; return new;
  end if;
  if current_user in ('anon','authenticated') then raise exception 'Browser cannot use starts worker headers' using errcode='42501'; end if;
  if tg_op='INSERT' then v_rows:=array[to_jsonb(new)];
  elsif tg_op='DELETE' then v_rows:=array[to_jsonb(old)];
  else v_rows:=array[to_jsonb(old),to_jsonb(new)]; end if;
  v_pkg:=public.lock_starts_release_write_scope((v_rows[1]->>'org_id')::uuid);
  if v_pkg.id is null then raise exception 'Starts worker scope unavailable' using errcode='40001'; end if;
  foreach v_row in array v_rows loop
    if (v_row->>'org_id')::uuid is distinct from v_pkg.org_id then raise exception 'Starts worker organization mismatch' using errcode='42501'; end if;
    v_company:=null;
    if tg_table_name='commitment_lines' then
      select project_id,company_id,commitment_type into v_project,v_company,v_type from public.commitments
        where org_id=v_pkg.org_id and id=(v_row->>'commitment_id')::uuid for share;
      if not found or v_project is distinct from v_pkg.project_id or v_type is distinct from 'purchase_order'
        then raise exception 'Starts worker purchase order mismatch' using errcode='42501'; end if;
      if v_row->>'budget_line_id' is not null then
        select b.project_id into v_project from public.budget_lines bl join public.budgets b on b.id=bl.budget_id and b.org_id=bl.org_id
          where bl.org_id=v_pkg.org_id and bl.id=(v_row->>'budget_line_id')::uuid for share of bl,b;
        if not found or v_project is distinct from v_pkg.project_id then raise exception 'Starts worker budget line mismatch' using errcode='42501'; end if;
      end if;
    else
      if (v_row->>'project_id')::uuid is distinct from v_pkg.project_id then raise exception 'Starts worker project mismatch' using errcode='42501'; end if;
      if tg_table_name='po_generation_runs' then
        if (v_row->>'lot_id')::uuid is distinct from v_pkg.lot_id then raise exception 'Starts worker lot mismatch' using errcode='42501'; end if;
      elsif tg_table_name='po_generation_exceptions' then
        select project_id,lot_id into v_project,v_lot from public.po_generation_runs
          where org_id=v_pkg.org_id and id=(v_row->>'run_id')::uuid for share;
        if not found or v_project is distinct from v_pkg.project_id or v_lot is distinct from v_pkg.lot_id
          then raise exception 'Starts worker generation run mismatch' using errcode='42501'; end if;
      elsif tg_table_name='commitments' then
        if v_row->>'commitment_type' is distinct from 'purchase_order' then raise exception 'Starts worker cannot change non-PO commitments' using errcode='42501'; end if;
        v_company:=(v_row->>'company_id')::uuid;
      elsif tg_table_name='project_vendors' then v_company:=(v_row->>'company_id')::uuid;
      else raise exception 'Unsupported purchasing fence table'; end if;
    end if;
    if tg_table_name in ('commitments','commitment_lines','project_vendors') then
      perform 1 from public.companies where org_id=v_pkg.org_id and id=v_company for share;
      if not found then raise exception 'Starts worker vendor mismatch' using errcode='42501'; end if;
    end if;
  end loop;
  if tg_op='DELETE' then return old; end if; return new;
end $$;
do $$ declare v_table text; begin
  foreach v_table in array array['po_generation_runs','po_generation_exceptions','commitments','commitment_lines','project_vendors'] loop
    execute format('create trigger starts_purchasing_worker_fence before insert or update or delete on public.%I for each row execute function public.fence_starts_purchasing_write()',v_table);
  end loop;
end $$;
revoke all on function public.fence_starts_purchasing_write() from public,anon,authenticated;
