-- Two completions may never claim the same purchase-order line.
--
-- `po_completions.commitment_line_ids` supports partial completion, but nothing
-- stopped two completions from covering identical lines. `approve_po_completion`
-- only guarded the aggregate against the revised PO total, so on a $100k PO two
-- $40k completions over the same lines both passed and the trade was paid twice.
--
-- Enforced in two places: a write-time trigger so no path (portal, mobile,
-- office, backfill) can create the overlap, and inside the approval function so
-- an overlap that predates this migration cannot be turned into a vendor bill.

create or replace function public.tg_po_completion_no_line_overlap()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_conflict uuid;
begin
  -- Rejected and void completions release their lines: that is what lets a trade
  -- re-report scope the builder sent back.
  if new.status not in ('reported', 'verified', 'approved', 'billed') then
    return new;
  end if;

  -- Serialize concurrent completion writes against the same purchase order so two
  -- simultaneous reports cannot both read "no overlap" and both insert.
  perform pg_advisory_xact_lock(hashtextextended(new.commitment_id::text, 0));

  select other.id into v_conflict
  from public.po_completions other
  where other.org_id = new.org_id
    and other.commitment_id = new.commitment_id
    and other.id <> new.id
    and other.status in ('reported', 'verified', 'approved', 'billed')
    and (
      other.commitment_line_ids is null
      or new.commitment_line_ids is null
      or other.commitment_line_ids && new.commitment_line_ids
    )
  limit 1;

  if v_conflict is not null then
    raise exception 'Purchase-order lines are already covered by completion %', v_conflict
      using errcode = '23505';
  end if;

  return new;
end;
$$;

revoke all on function public.tg_po_completion_no_line_overlap() from public, anon, authenticated;

drop trigger if exists po_completions_no_line_overlap on public.po_completions;
create trigger po_completions_no_line_overlap
  before insert or update of status, commitment_line_ids, commitment_id on public.po_completions
  for each row execute function public.tg_po_completion_no_line_overlap();

create index if not exists po_completions_open_claim_idx
  on public.po_completions (org_id, commitment_id)
  where status in ('reported', 'verified', 'approved', 'billed');

create or replace function public.approve_po_completion(
  p_org_id uuid,
  p_completion_id uuid,
  p_actor_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_completion public.po_completions%rowtype;
  v_commitment public.commitments%rowtype;
  v_settings public.purchasing_settings%rowtype;
  v_bill_id uuid;
  v_amount bigint := 0;
  v_revised_total bigint := 0;
  v_already_billed bigint := 0;
  v_overlap uuid;
  v_line record;
begin
  select * into v_completion from public.po_completions
    where org_id = p_org_id and id = p_completion_id for update;
  if not found then raise exception 'PO completion not found'; end if;
  if v_completion.status = 'billed' and v_completion.vendor_bill_id is not null then
    return jsonb_build_object('completion_id', v_completion.id, 'vendor_bill_id', v_completion.vendor_bill_id, 'amount_cents', v_completion.amount_cents);
  end if;

  select * into v_commitment from public.commitments
    where org_id = p_org_id and id = v_completion.commitment_id for update;
  if not found or v_commitment.commitment_type <> 'purchase_order' or v_commitment.status <> 'approved' then
    raise exception 'Only approved purchase orders can be completed';
  end if;

  -- Per-line guard. The revised-total test below is an aggregate and cannot see
  -- that two completions describe the same work.
  select other.id into v_overlap
  from public.po_completions other
  where other.org_id = p_org_id
    and other.commitment_id = v_commitment.id
    and other.id <> v_completion.id
    and other.status in ('approved', 'billed')
    and (
      other.commitment_line_ids is null
      or v_completion.commitment_line_ids is null
      or other.commitment_line_ids && v_completion.commitment_line_ids
    )
  limit 1;
  if v_overlap is not null then
    raise exception 'These purchase-order lines were already billed by completion %', v_overlap;
  end if;

  select * into v_settings from public.purchasing_settings where org_id = p_org_id;
  if coalesce(v_settings.po_completion_requires_verification, true) and v_completion.status <> 'verified' then
    raise exception 'PO completion must be verified before approval';
  end if;
  if not coalesce(v_settings.po_completion_requires_verification, true)
      and v_completion.status not in ('reported','verified') then
    raise exception 'PO completion is not approval-ready';
  end if;

  select coalesce(sum(round(cl.quantity * cl.unit_cost_cents)), 0)::bigint into v_amount
  from public.commitment_lines cl
  where cl.org_id = p_org_id and cl.commitment_id = v_commitment.id
    and (v_completion.commitment_line_ids is null or cl.id = any(v_completion.commitment_line_ids));

  if v_completion.commitment_line_ids is null then
    select v_amount + coalesce(sum(cco.total_cents), 0)::bigint into v_amount
    from public.commitment_change_orders cco
    where cco.org_id = p_org_id and cco.commitment_id = v_commitment.id and cco.status = 'approved';
  end if;

  select coalesce(sum(cco.total_cents), 0)::bigint into v_revised_total
  from public.commitment_change_orders cco
  where cco.org_id = p_org_id and cco.commitment_id = v_commitment.id and cco.status = 'approved';
  v_revised_total := coalesce(v_commitment.total_cents, 0)::bigint + v_revised_total;
  select coalesce(sum(vb.total_cents), 0)::bigint into v_already_billed
  from public.vendor_bills vb where vb.org_id = p_org_id and vb.commitment_id = v_commitment.id;
  if v_amount <= 0 then raise exception 'PO completion has no positive payable amount'; end if;
  if v_already_billed + v_amount > v_revised_total then
    raise exception 'Completion exceeds the revised PO total; create a VPO first';
  end if;

  insert into public.vendor_bills (
    org_id, project_id, commitment_id, company_id, bill_number, status,
    bill_date, due_date, total_cents, currency, metadata, approved_at, approved_by
  ) values (
    p_org_id, v_completion.project_id, v_commitment.id, v_commitment.company_id,
    concat('PO-', coalesce(v_commitment.contract_number, left(v_commitment.id::text, 8)), '-', left(v_completion.id::text, 8)),
    'approved', current_date, current_date, v_amount::integer, 'usd',
    jsonb_build_object('source', 'pay_on_po', 'po_completion_id', v_completion.id),
    now(), p_actor_id
  ) returning id into v_bill_id;

  for v_line in
    select cl.* from public.commitment_lines cl
    where cl.org_id = p_org_id and cl.commitment_id = v_commitment.id
      and (v_completion.commitment_line_ids is null or cl.id = any(v_completion.commitment_line_ids))
    order by cl.sort_order
  loop
    insert into public.bill_lines (
      org_id, bill_id, project_id, cost_code_id, budget_line_id, description,
      quantity, unit, unit_cost_cents, sort_order, metadata
    ) values (
      p_org_id, v_bill_id, v_completion.project_id, v_line.cost_code_id,
      v_line.budget_line_id, v_line.description, v_line.quantity, v_line.unit,
      v_line.unit_cost_cents, v_line.sort_order,
      jsonb_build_object('source', 'pay_on_po', 'commitment_line_id', v_line.id)
    );
  end loop;

  if v_completion.commitment_line_ids is null then
    for v_line in
      select ccol.* from public.commitment_change_order_lines ccol
      join public.commitment_change_orders cco on cco.id = ccol.commitment_change_order_id and cco.org_id = ccol.org_id
      where ccol.org_id = p_org_id and cco.commitment_id = v_commitment.id and cco.status = 'approved'
      order by cco.created_at, ccol.sort_order
    loop
      insert into public.bill_lines (
        org_id, bill_id, project_id, cost_code_id, budget_line_id, description,
        quantity, unit, unit_cost_cents, sort_order, metadata
      ) values (
        p_org_id, v_bill_id, v_completion.project_id, v_line.cost_code_id,
        v_line.budget_line_id, v_line.description, v_line.quantity, v_line.unit,
        v_line.unit_cost_cents, 10000 + v_line.sort_order,
        jsonb_build_object('source', 'pay_on_po_vpo', 'commitment_change_order_line_id', v_line.id)
      );
    end loop;
  end if;

  update public.po_completions set
    status = 'billed', approved_by = p_actor_id, approved_at = now(),
    vendor_bill_id = v_bill_id, amount_cents = v_amount
  where org_id = p_org_id and id = v_completion.id;

  return jsonb_build_object('completion_id', v_completion.id, 'vendor_bill_id', v_bill_id, 'amount_cents', v_amount);
end;
$$;

revoke all on function public.approve_po_completion(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.approve_po_completion(uuid, uuid, uuid) to service_role;
