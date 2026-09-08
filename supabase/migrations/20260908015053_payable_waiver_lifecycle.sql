-- Applied through Supabase MCP; ledger version 20260908015053.
-- Original migration name: 20260908005314_payable_waiver_lifecycle.
-- Preserve historical waiver records; new documents use explicit kinds.
begin;
alter table public.lien_waivers drop constraint lien_waivers_waiver_type_check;
alter table public.lien_waivers add constraint lien_waivers_waiver_type_check check (waiver_type in ('conditional','unconditional','final','conditional_progress','unconditional_progress','conditional_final','unconditional_final'));
alter table public.subtier_waiver_requirements drop constraint subtier_waiver_requirements_waiver_type_check;
alter table public.subtier_waiver_requirements add constraint subtier_waiver_requirements_waiver_type_check check (waiver_type in ('conditional','unconditional','final','conditional_progress','unconditional_progress','conditional_final','unconditional_final'));
-- A replacement must never overwrite an executed document.
drop index public.lien_waivers_bill_type_unique_idx;
create index lien_waivers_bill_type_history_idx on public.lien_waivers(org_id,bill_id,waiver_type,created_at desc);
create unique index lien_waivers_request_bill_idx on public.lien_waivers(org_id,(metadata->>'request_id'),bill_id) where metadata ? 'request_id';
create index lien_waivers_document_idx on public.lien_waivers(org_id,(metadata->>'document_id')) where metadata ? 'document_id';
alter table public.subtier_waiver_requirements add column if not exists metadata jsonb not null default '{}'::jsonb;
create or replace function public.release_retainage_atomic(
  p_org_id uuid,
  p_bill_id uuid,
  p_actor_id uuid,
  p_amount_cents bigint,
  -- Compatibility parameter: creating a pending payable does not disburse funds.
  p_require_final_waiver boolean default true,
  p_requested_at timestamptz default now()
)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_bill public.vendor_bills%rowtype;
  v_release public.vendor_bills%rowtype;
  v_held bigint;
begin
  if p_amount_cents <= 0 then raise exception 'Retainage release amount must be positive'; end if;
  select * into v_bill from public.vendor_bills where id=p_bill_id and org_id=p_org_id for update;
  if v_bill.id is null then raise exception 'Vendor bill not found'; end if;
  if v_bill.status not in ('approved','partial','paid') then raise exception 'Only approved retainage can be released'; end if;
  v_held := greatest(coalesce(v_bill.retainage_cents,0)-coalesce(v_bill.retainage_released_cents,0),0);
  if p_amount_cents > v_held then raise exception 'Retainage release exceeds the held amount'; end if;
  insert into public.vendor_bills(org_id,project_id,commitment_id,company_id,bill_number,status,bill_date,due_date,total_cents,currency,
    accounting_coding,metadata,approved_at,approved_by,retainage_percent,retainage_cents,retainage_released_cents)
  values(p_org_id,v_bill.project_id,v_bill.commitment_id,v_bill.company_id,coalesce(v_bill.bill_number,'Bill')||'-RET-'||to_char(coalesce(p_requested_at,now()),'YYYYMMDDHH24MISS'),
    'pending',(coalesce(p_requested_at,now()) at time zone 'UTC')::date,(coalesce(p_requested_at,now()) at time zone 'UTC')::date,
    p_amount_cents,v_bill.currency,v_bill.accounting_coding,jsonb_build_object('source','retainage_release','source_bill_id',v_bill.id,'billing_period_end',coalesce(v_bill.metadata->>'billing_period_end',v_bill.metadata->>'through_date')),null,null,0,0,0)
  returning * into v_release;
  -- Carry the original cost-code distribution onto the release, preserving cents.
  with weights as (
    select id,cost_code_id,budget_line_id,
      greatest(coalesce(quantity,1)*coalesce(unit_cost_cents,0),0)::numeric as weight
    from public.bill_lines where org_id=p_org_id and bill_id=v_bill.id
  ), shares as (
    select *,floor(p_amount_cents*weight/nullif(sum(weight) over (),0))::bigint as share,
      row_number() over(order by weight desc,id) as rank
    from weights where weight>0
  ), amounts as (
    select *,share+case when rank=1 then p_amount_cents-sum(share) over() else 0 end as cents from shares
  )
  insert into public.bill_lines(org_id,bill_id,project_id,cost_code_id,budget_line_id,description,quantity,unit,unit_cost_cents,metadata,sort_order)
  select p_org_id,v_release.id,v_bill.project_id,cost_code_id,budget_line_id,
    'Retainage release for '||coalesce(v_bill.bill_number,v_bill.id::text),1,'ls',cents,
    jsonb_build_object('source_bill_id',v_bill.id,'kind','retainage_release'),rank::integer-1
  from amounts where cents>0;
  if not found then
    insert into public.bill_lines(org_id,bill_id,project_id,description,quantity,unit,unit_cost_cents,metadata,sort_order)
    values(p_org_id,v_release.id,v_bill.project_id,'Retainage release - coding review required',1,'ls',p_amount_cents,
      jsonb_build_object('source_bill_id',v_bill.id,'kind','retainage_release'),0);
  end if;
  update public.vendor_bills set retainage_released_cents=coalesce(retainage_released_cents,0)+p_amount_cents,
    retainage_release_requested_at=coalesce(p_requested_at,now()) where id=v_bill.id;
  insert into public.events(org_id,event_type,entity_type,entity_id,payload)
  values(p_org_id,'vendor_bill_retainage_released','vendor_bill',v_bill.id,
    jsonb_build_object('release_bill_id',v_release.id,'amount_cents',p_amount_cents,'actor_id',p_actor_id));
  return jsonb_build_object('source_bill_id',v_bill.id,'release_bill_id',v_release.id,'amount_cents',p_amount_cents,'held_after_cents',v_held-p_amount_cents);
end;
$$;

-- Prevent simultaneous editors from publishing the same numbered revision.
create unique index company_waiver_revision_idx on public.files(org_id,(metadata->'editable_waiver'->>'familyId'),(metadata->'editable_waiver'->>'revision'))
where folder_path='/Templates/Editable waivers' and (metadata->'editable_waiver') ? 'revision';
commit;
