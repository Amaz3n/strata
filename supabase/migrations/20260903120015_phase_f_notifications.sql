-- Phase F: the bulk approval RPC stops raising its own notification event.
--
-- `approve_vendor_bills_atomic` inserted `vendor_bill_approved` straight into
-- `public.events` while `approveVendorBillsAtomic` also called `recordEvent`
-- for every approved bill, so bulk-approving fifty payables raised a hundred
-- events. Only one of them ran through the TypeScript fan-out with a full
-- payload; the SQL twin carried no `submitted_by_user_id`, so its notification
-- fell back to the permission-derived audience and mailed people who had
-- nothing to do with the invoice.
--
-- Events for a type that has a TypeScript emitter belong to that emitter. SQL
-- can raise an event nothing in TypeScript emits (nothing here does), but it may
-- never shadow one — `tests/payment-notification-coverage.test.js` now fails the
-- build if a migration reintroduces this.
--
-- Everything else about the function is unchanged from
-- `20260805092000_bulk_approval_waiver_parity.sql`: validation, locking, waiver
-- seeding, audit evidence and the durable outbox job all still commit together.

create or replace function public.approve_vendor_bills_atomic(
  p_org_id uuid,
  p_actor_id uuid,
  p_items jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_requested integer;
  v_locked integer;
  v_now timestamptz := now();
  v_bill record;
  v_require_waiver boolean;
begin
  if jsonb_typeof(p_items) <> 'array' then raise exception 'Approval items must be an array'; end if;
  v_requested := jsonb_array_length(p_items);
  if v_requested < 1 or v_requested > 500 then raise exception 'Bulk approval requires between 1 and 500 bills'; end if;
  if (select count(distinct item->>'id') from jsonb_array_elements(p_items) item) <> v_requested then raise exception 'Bulk approval contains duplicate bills'; end if;

  select coalesce((compliance_rules->>'require_lien_waiver')::boolean, false)
    into v_require_waiver from public.orgs where id = p_org_id;

  perform b.id from public.vendor_bills b
  join jsonb_array_elements(p_items) item on item->>'id' = b.id::text
  where b.org_id = p_org_id order by b.id for update;
  get diagnostics v_locked = row_count;
  if v_locked <> v_requested then raise exception 'One or more payables no longer exist'; end if;

  for v_bill in
    select b.*, item->>'expected_updated_at' as expected_updated_at
    from public.vendor_bills b
    join jsonb_array_elements(p_items) item on item->>'id' = b.id::text
    where b.org_id = p_org_id order by b.id
  loop
    if v_bill.status = 'rejected' then raise exception 'Payable % was rejected; reopen it before approving', coalesce(v_bill.bill_number, v_bill.id::text); end if;
    if v_bill.status <> 'pending' then raise exception 'Payable % is no longer pending', coalesce(v_bill.bill_number, v_bill.id::text); end if;
    if v_bill.expected_updated_at is not null and v_bill.updated_at <> v_bill.expected_updated_at::timestamptz then
      raise exception 'Payable % changed since it was selected', coalesce(v_bill.bill_number, v_bill.id::text);
    end if;
    if coalesce(v_bill.metadata->>'source', '') = 'vendor_credit' then raise exception 'Vendor credits cannot be approved for payment'; end if;
    if not exists (select 1 from public.bill_lines l where l.org_id = p_org_id and l.bill_id = v_bill.id) then raise exception 'Payable % has no coding lines', coalesce(v_bill.bill_number, v_bill.id::text); end if;
    if exists (
      select 1 from public.bill_lines l
      left join public.project_financial_settings s on s.org_id = p_org_id and s.project_id = coalesce(l.project_id, v_bill.project_id)
      left join public.org_settings os on os.org_id = p_org_id
      where l.org_id = p_org_id and l.bill_id = v_bill.id
        and coalesce(s.cost_codes_enabled, nullif(os.settings->>'cost_codes_enabled', '')::boolean, true)
        and l.cost_code_id is null
    ) then raise exception 'Payable % is missing required cost-code coding', coalesce(v_bill.bill_number, v_bill.id::text); end if;
    if (select coalesce(sum(round(coalesce(l.quantity, 1) * coalesce(l.unit_cost_cents, 0))), 0) from public.bill_lines l where l.org_id = p_org_id and l.bill_id = v_bill.id) <> coalesce(v_bill.total_cents, 0) then
      raise exception 'Payable % coding does not equal its total', coalesce(v_bill.bill_number, v_bill.id::text);
    end if;
  end loop;

  update public.vendor_bills b
  set status = 'approved', approved_at = coalesce(b.approved_at, v_now), approved_by = p_actor_id,
      -- Mirrors updateVendorBillStatus exactly: a waiver already received is
      -- never downgraded to requested, and an org that does not require waivers
      -- gets an explicit 'not_required' rather than a silent NULL.
      lien_waiver_status = case
        when v_require_waiver and coalesce(b.lien_waiver_status, '') <> 'received' then 'requested'
        when not v_require_waiver and b.lien_waiver_status is null then 'not_required'
        else b.lien_waiver_status
      end,
      lien_waiver_received_at = case
        when v_require_waiver and coalesce(b.lien_waiver_status, '') <> 'received' then null
        when not v_require_waiver and b.lien_waiver_status is null then null
        else b.lien_waiver_received_at
      end,
      qbo_sync_status = case when b.qbo_sync_status = 'synced' then 'pending' else b.qbo_sync_status end,
      qbo_sync_error = case when b.qbo_sync_status = 'synced' then null else b.qbo_sync_error end
  from jsonb_array_elements(p_items) item
  where b.org_id = p_org_id and b.id::text = item->>'id';

  insert into public.audit_log (org_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, source)
  select p_org_id, p_actor_id, 'update', 'vendor_bill', b.id, jsonb_build_object('status', 'pending'), jsonb_build_object('status', 'approved', 'bulk', true, 'lien_waiver_status', b.lien_waiver_status), 'bulk_payables_approval'
  from public.vendor_bills b join jsonb_array_elements(p_items) item on item->>'id' = b.id::text where b.org_id = p_org_id;

  -- No `insert into public.events` here. `approveVendorBillsAtomic` raises
  -- `vendor_bill_approved` per approved bill once the transaction returns, with
  -- the submitter, project, vendor and amount the single-bill path carries — the
  -- payload the notification router needs to reach the person who submitted it.

  insert into public.outbox (org_id, job_type, payload, dedupe_key, priority)
  select p_org_id, 'project_vendor_bill_approval', jsonb_build_object('bill_id', b.id), 'vendor-bill-approval:' || b.id::text, 80
  from public.vendor_bills b join jsonb_array_elements(p_items) item on item->>'id' = b.id::text where b.org_id = p_org_id
  on conflict (org_id, dedupe_key) where status = 'pending' and dedupe_key is not null do update
    set status = 'pending', run_at = now(), last_error = null, updated_at = now(), priority = greatest(public.outbox.priority, excluded.priority);

  return jsonb_build_object('approved_count', v_requested, 'approved_at', v_now);
end;
$$;

revoke all on function public.approve_vendor_bills_atomic(uuid,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.approve_vendor_bills_atomic(uuid,uuid,jsonb) to service_role;
