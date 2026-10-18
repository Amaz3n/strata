-- EP08 purchasing controls: variance orders, purchasing settings and the
-- completion-to-payment path are decided in the database, not only in the
-- services that sit in front of them.
--
-- 1. Settings, reason codes and PO completions were `for all` to any org member.
--    A sales agent could turn pay-on-PO on, re-point an approval band at any
--    permission, or mark a trade's completion verified. They are read-only to
--    browser roles now; every write is a service-role path after an
--    authorization check.
-- 2. Variance orders (commitment_change_orders carrying a reason code) and their
--    lines are the service's: a member cannot raise, approve, reject, void,
--    reprice, re-reason or delete one through the data API, and cannot rewrite
--    who requested it or the evidence behind it. Linking one to an owner change
--    order and the draft/sent flag stay the member's.
-- 3. Cost evidence: variance orders carry `evidence_file_ids` (separate from
--    field photos) and the org sets the amount from which evidence is required.
-- 4. Completion to payment: a completion claims PO lines AND/OR approved VPOs
--    (`change_order_ids`) so a VPO approved after a completion can still be
--    billed; the person who reported or verified a completion cannot approve the
--    money step; an org can require a passed inspection (or an audited waiver).
-- 5. RBAC: purchasing_settings.write.
-- 6. purchase_order_positions: one row per purchase order (approved incl. VPOs,
--    billed, paid, retainage, completion coverage) for reconciliation.
--
-- Requires 20261013110000_selection_supply_and_propagation (system guards),
-- 20261010110000_po_completion_rollback_keeps_bill (approval RPC).

-- ---------------------------------------------------------------------------
-- 1. Columns.
-- ---------------------------------------------------------------------------

alter table public.commitment_change_orders
  add column if not exists evidence_file_ids uuid[] not null default '{}';

alter table public.purchasing_settings
  add column if not exists vpo_evidence_required_over_cents bigint default 100000
    check (vpo_evidence_required_over_cents is null or vpo_evidence_required_over_cents >= 0),
  add column if not exists po_completion_requires_inspection boolean not null default false;

alter table public.po_completions
  add column if not exists change_order_ids uuid[],
  add column if not exists inspection_id uuid references public.inspections(id),
  add column if not exists inspection_waived_reason text,
  add column if not exists inspection_waived_by uuid references public.app_users(id),
  add column if not exists inspection_waived_at timestamptz;

create index if not exists po_completions_inspection_idx on public.po_completions (inspection_id)
  where inspection_id is not null;
create index if not exists po_completions_inspection_waived_by_idx on public.po_completions (inspection_waived_by)
  where inspection_waived_by is not null;

-- A whole-order completion bills the VPOs that are approved when it is approved;
-- the approval writes the ids it billed back, so every billed completion names
-- the VPOs it paid. Completions approved before this migration get the same.
update public.po_completions pc
set change_order_ids = coalesce((
  select array_agg(cco.id order by cco.created_at, cco.id)
  from public.commitment_change_orders cco
  where cco.org_id = pc.org_id and cco.commitment_id = pc.commitment_id
    and cco.status = 'approved'
    and cco.approved_at <= coalesce(pc.approved_at, now())
), '{}')
where pc.status in ('approved', 'billed') and pc.commitment_line_ids is null and pc.change_order_ids is null;

alter table public.po_completions
  add constraint po_completions_claims_scope check (
    commitment_line_ids is null
    or cardinality(commitment_line_ids) > 0
    or coalesce(cardinality(change_order_ids), 0) > 0
  );

-- ---------------------------------------------------------------------------
-- 2. Browser roles read; services write.
-- ---------------------------------------------------------------------------

drop policy if exists purchasing_settings_org_access on public.purchasing_settings;
drop policy if exists variance_reason_codes_org_access on public.variance_reason_codes;
drop policy if exists po_completions_org_access on public.po_completions;

create policy purchasing_settings_member_read on public.purchasing_settings
  for select to authenticated using (public.is_org_member(org_id));
create policy variance_reason_codes_member_read on public.variance_reason_codes
  for select to authenticated using (public.is_org_member(org_id));
create policy po_completions_member_read on public.po_completions
  for select to authenticated using (public.is_org_member(org_id));

revoke all on public.purchasing_settings, public.variance_reason_codes, public.po_completions from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.purchasing_settings, public.variance_reason_codes, public.po_completions from authenticated;
grant select on public.purchasing_settings, public.variance_reason_codes, public.po_completions to authenticated;

-- ---------------------------------------------------------------------------
-- 3. Variance orders are the service's.
-- ---------------------------------------------------------------------------

create or replace function public.tg_commitment_change_order_system_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return coalesce(new, old);
  end if;
  -- Linking an office variance order to the owner change order it passes
  -- through stays the member's; only the executed change order's own are kept.
  if tg_op = 'INSERT' then
    if new.origin = 'design_studio_co' then
      raise exception 'A variance order for an executed change order is raised by the change order' using errcode = '42501';
    end if;
    if new.reason_code_id is not null then
      raise exception 'A variance order is raised through purchasing' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.origin = 'design_studio_co' then
      raise exception 'A variance order raised by a change order is kept; void it instead' using errcode = '42501';
    end if;
    if old.reason_code_id is not null then
      raise exception 'A variance order is kept; void it instead' using errcode = '42501';
    end if;
    return old;
  end if;
  if old.origin is distinct from 'design_studio_co' then
    if new.origin = 'design_studio_co' then
      raise exception 'A variance order for an executed change order is raised by the change order' using errcode = '42501';
    end if;
  else
    if (new.org_id, new.project_id, new.commitment_id, new.total_cents, new.origin, new.prime_change_order_id, new.reason_code_id)
       is distinct from (old.org_id, old.project_id, old.commitment_id, old.total_cents, old.origin, old.prime_change_order_id, old.reason_code_id) then
      raise exception 'A variance order raised by a change order is re-priced through purchasing with a reason' using errcode = '42501';
    end if;
  end if;
  if old.reason_code_id is not null or new.reason_code_id is not null then
    if (new.org_id, new.project_id, new.commitment_id, new.company_id, new.total_cents, new.reason_code_id,
        new.requested_by, new.approved_by, new.approved_at, new.evidence_file_ids, new.photo_file_ids, new.currency)
       is distinct from (old.org_id, old.project_id, old.commitment_id, old.company_id, old.total_cents, old.reason_code_id,
        old.requested_by, old.approved_by, old.approved_at, old.evidence_file_ids, old.photo_file_ids, old.currency)
       or (new.status is distinct from old.status
         and (new.status in ('approved', 'rejected', 'voided') or old.status in ('approved', 'rejected', 'voided'))) then
      raise exception 'A variance order is approved, rejected, voided and repriced through purchasing' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.tg_commitment_change_order_system_guard() from public, anon, authenticated;

create or replace function public.tg_commitment_change_order_line_system_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_order uuid := coalesce(new.commitment_change_order_id, old.commitment_change_order_id);
begin
  if current_user <> 'authenticated' then
    return coalesce(new, old);
  end if;
  if tg_op = 'UPDATE' and new.commitment_change_order_id is distinct from old.commitment_change_order_id
     and exists (select 1 from public.commitment_change_orders v where v.id = new.commitment_change_order_id and v.origin = 'design_studio_co') then
    raise exception 'A variance order raised by a change order is re-priced through purchasing with a reason' using errcode = '42501';
  end if;
  if exists (select 1 from public.commitment_change_orders v where v.id = v_order and v.origin = 'design_studio_co') then
    raise exception 'A variance order raised by a change order is re-priced through purchasing with a reason' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and new.commitment_change_order_id is distinct from old.commitment_change_order_id
     and exists (select 1 from public.commitment_change_orders v where v.id = new.commitment_change_order_id and v.reason_code_id is not null) then
    raise exception 'A variance order is re-priced through purchasing' using errcode = '42501';
  end if;
  if exists (select 1 from public.commitment_change_orders v where v.id = v_order and v.reason_code_id is not null) then
    raise exception 'A variance order is re-priced through purchasing' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function public.tg_commitment_change_order_line_system_guard() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 4. RBAC.
-- ---------------------------------------------------------------------------

insert into public.permissions (key, description) values
  ('purchasing_settings.write', 'Change approval bands, evidence and inspection policy, reason codes and pay-on-PO defaults')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select r.id, 'purchasing_settings.write'
from public.roles r
where r.key in ('org_owner', 'org_admin', 'org_purchasing_manager')
on conflict (role_id, permission_key) do nothing;

-- ---------------------------------------------------------------------------
-- 5. Completions claim lines and VPOs.
-- ---------------------------------------------------------------------------

-- NULL covers every line, an empty list covers none (a completion that claims
-- only VPOs), and two completions collide when their line sets intersect.
create or replace function public.po_completion_lines_overlap(p_a uuid[], p_b uuid[])
returns boolean
language sql
immutable
set search_path = ''
as $$
  select case
    when (p_a is not null and cardinality(p_a) = 0) or (p_b is not null and cardinality(p_b) = 0) then false
    when p_a is null or p_b is null then true
    else p_a operator(pg_catalog.&&) p_b
  end;
$$;

revoke all on function public.po_completion_lines_overlap(uuid[], uuid[]) from public, anon, authenticated;
grant execute on function public.po_completion_lines_overlap(uuid[], uuid[]) to service_role;

create or replace function public.tg_po_completion_no_line_overlap()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_conflict uuid;
begin
  if new.status not in ('reported', 'verified', 'approved', 'billed') then
    return new;
  end if;

  perform pg_advisory_xact_lock(hashtextextended(new.commitment_id::text, 0));

  select other.id into v_conflict
  from public.po_completions other
  where other.org_id = new.org_id
    and other.commitment_id = new.commitment_id
    and other.id <> new.id
    and other.status in ('reported', 'verified', 'approved', 'billed')
    and (
      public.po_completion_lines_overlap(other.commitment_line_ids, new.commitment_line_ids)
      or other.change_order_ids && new.change_order_ids
    )
  limit 1;

  if v_conflict is not null then
    raise exception 'Purchase-order scope is already covered by completion %', v_conflict
      using errcode = '23505';
  end if;

  return new;
end;
$$;

revoke all on function public.tg_po_completion_no_line_overlap() from public, anon, authenticated;

drop trigger if exists po_completions_no_line_overlap on public.po_completions;
create trigger po_completions_no_line_overlap
  before insert or update of status, commitment_line_ids, change_order_ids, commitment_id on public.po_completions
  for each row execute function public.tg_po_completion_no_line_overlap();

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
  v_lines_amount bigint := 0;
  v_vpo_amount bigint := 0;
  v_vpo_ids uuid[];
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

  -- The money step needs a second person: whoever reported or verified the
  -- work does not also release the payment for it.
  if p_actor_id is not distinct from v_completion.reported_by_user_id
     or p_actor_id is not distinct from v_completion.verified_by then
    raise exception 'The person who reported or verified a completion cannot approve it'
      using errcode = '42501';
  end if;

  select other.id into v_overlap
  from public.po_completions other
  where other.org_id = p_org_id
    and other.commitment_id = v_commitment.id
    and other.id <> v_completion.id
    and other.status in ('approved', 'billed')
    and (
      public.po_completion_lines_overlap(other.commitment_line_ids, v_completion.commitment_line_ids)
      or other.change_order_ids && v_completion.change_order_ids
    )
  limit 1;
  if v_overlap is not null then
    raise exception 'This purchase-order scope was already billed by completion %', v_overlap;
  end if;

  select * into v_settings from public.purchasing_settings where org_id = p_org_id;
  if coalesce(v_settings.po_completion_requires_verification, true) and v_completion.status <> 'verified' then
    raise exception 'PO completion must be verified before approval';
  end if;
  if not coalesce(v_settings.po_completion_requires_verification, true)
      and v_completion.status not in ('reported','verified') then
    raise exception 'PO completion is not approval-ready';
  end if;

  if coalesce(v_settings.po_completion_requires_inspection, false)
     and not exists (
       select 1 from public.inspections i
       where i.org_id = p_org_id and i.id = v_completion.inspection_id
         and i.project_id = v_completion.project_id
         and i.status = 'completed' and i.result = 'pass'
     )
     and nullif(btrim(coalesce(v_completion.inspection_waived_reason, '')), '') is null then
    raise exception 'This organization requires a passed inspection or a recorded waiver before a completion is approved';
  end if;

  select coalesce(sum(round(cl.quantity * cl.unit_cost_cents)), 0)::bigint into v_lines_amount
  from public.commitment_lines cl
  where cl.org_id = p_org_id and cl.commitment_id = v_commitment.id
    and (v_completion.commitment_line_ids is null or cl.id = any(v_completion.commitment_line_ids));

  -- A whole-order completion bills the VPOs nobody has billed yet; an explicit
  -- list bills exactly those; a line completion bills no VPO.
  if v_completion.change_order_ids is not null then
    v_vpo_ids := v_completion.change_order_ids;
    if (select count(*) from public.commitment_change_orders cco
        where cco.org_id = p_org_id and cco.commitment_id = v_commitment.id
          and cco.status = 'approved' and cco.id = any(v_vpo_ids)) <> cardinality(v_vpo_ids) then
      raise exception 'A claimed variance order is not approved on this purchase order';
    end if;
  elsif v_completion.commitment_line_ids is null then
    select coalesce(array_agg(cco.id order by cco.created_at, cco.id), '{}') into v_vpo_ids
    from public.commitment_change_orders cco
    where cco.org_id = p_org_id and cco.commitment_id = v_commitment.id and cco.status = 'approved'
      and not exists (
        select 1 from public.po_completions other
        where other.org_id = p_org_id and other.commitment_id = v_commitment.id
          and other.id <> v_completion.id and other.status in ('approved', 'billed')
          and cco.id = any(coalesce(other.change_order_ids, '{}'))
      );
  else
    v_vpo_ids := '{}';
  end if;

  select coalesce(sum(cco.total_cents), 0)::bigint into v_vpo_amount
  from public.commitment_change_orders cco
  where cco.org_id = p_org_id and cco.commitment_id = v_commitment.id and cco.id = any(v_vpo_ids);
  v_amount := v_lines_amount + v_vpo_amount;

  select coalesce(sum(cco.total_cents), 0)::bigint into v_revised_total
  from public.commitment_change_orders cco
  where cco.org_id = p_org_id and cco.commitment_id = v_commitment.id and cco.status = 'approved';
  v_revised_total := coalesce(v_commitment.total_cents, 0)::bigint + v_revised_total;
  select coalesce(sum(vb.total_cents), 0)::bigint into v_already_billed
  from public.vendor_bills vb
  where vb.org_id = p_org_id and vb.commitment_id = v_commitment.id and vb.status <> 'rejected';
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
    'approved', current_date, current_date, v_amount, 'usd',
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

  for v_line in
    select ccol.* from public.commitment_change_order_lines ccol
    join public.commitment_change_orders cco on cco.id = ccol.commitment_change_order_id and cco.org_id = ccol.org_id
    where ccol.org_id = p_org_id and cco.commitment_id = v_commitment.id and cco.id = any(v_vpo_ids)
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

  update public.po_completions set
    status = 'billed', approved_by = p_actor_id, approved_at = now(),
    vendor_bill_id = v_bill_id, amount_cents = v_amount,
    change_order_ids = case when v_completion.change_order_ids is null and cardinality(v_vpo_ids) = 0
      then null else v_vpo_ids end
  where org_id = p_org_id and id = v_completion.id;

  return jsonb_build_object('completion_id', v_completion.id, 'vendor_bill_id', v_bill_id, 'amount_cents', v_amount);
end;
$$;

revoke all on function public.approve_po_completion(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.approve_po_completion(uuid, uuid, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 6. Purchase-order positions.
-- ---------------------------------------------------------------------------

-- One row per purchase order, read with explicit scope predicates by the
-- service client. Mirrors the rules in approve_po_completion and
-- lib/services/payment-holds.ts: authorized = PO total + approved variance
-- orders; billed counts every bill that is not rejected.
create or replace view public.purchase_order_positions
with (security_invoker = true) as
select
  c.org_id,
  c.project_id,
  c.id as commitment_id,
  c.title,
  c.contract_number,
  c.company_id,
  c.status,
  coalesce(l.division_id, p.division_id) as division_id,
  l.community_id,
  coalesce(cm.pay_on_po_enabled, ps.pay_on_po_enabled, false) as pay_on_po,
  coalesce(c.total_cents, 0)::bigint as original_cents,
  coalesce(vpo.approved_cents, 0)::bigint as approved_vpo_cents,
  coalesce(vpo.pending_count, 0)::bigint as pending_vpo_count,
  coalesce(bills.billed_cents, 0)::bigint as billed_cents,
  coalesce(bills.paid_cents, 0)::bigint as paid_cents,
  coalesce(bills.retainage_held_cents, 0)::bigint as retainage_held_cents,
  coalesce(comp.billed_cents, 0)::bigint as completion_billed_cents,
  coalesce(comp.open_count, 0)::bigint as open_completion_count,
  coalesce(vpo.approved_cents, 0)::bigint - coalesce(claimed.claimed_vpo_cents, 0)::bigint as unclaimed_vpo_cents
from public.commitments c
join public.projects p on p.id = c.project_id and p.org_id = c.org_id
left join public.lots l on l.project_id = p.id and l.org_id = p.org_id
left join public.communities cm on cm.id = l.community_id and cm.org_id = l.org_id
left join public.purchasing_settings ps on ps.org_id = c.org_id
left join lateral (
  select
    sum(cco.total_cents) filter (where cco.status in ('approved', 'executed')) as approved_cents,
    count(*) filter (where cco.status in ('draft', 'sent')) as pending_count
  from public.commitment_change_orders cco
  where cco.org_id = c.org_id and cco.commitment_id = c.id
) vpo on true
left join lateral (
  select
    sum(vb.total_cents) as billed_cents,
    sum(vb.paid_cents) as paid_cents,
    sum(greatest(coalesce(vb.retainage_cents, 0) - coalesce(vb.retainage_released_cents, 0), 0)) as retainage_held_cents
  from public.vendor_bills vb
  where vb.org_id = c.org_id and vb.commitment_id = c.id and vb.status <> 'rejected'
) bills on true
left join lateral (
  select
    sum(pc.amount_cents) filter (where pc.status in ('approved', 'billed')) as billed_cents,
    count(*) filter (where pc.status in ('reported', 'verified')) as open_count
  from public.po_completions pc
  where pc.org_id = c.org_id and pc.commitment_id = c.id
) comp on true
left join lateral (
  select sum(cco.total_cents) as claimed_vpo_cents
  from public.commitment_change_orders cco
  where cco.org_id = c.org_id and cco.commitment_id = c.id and cco.status in ('approved', 'executed')
    and exists (
      select 1 from public.po_completions pc
      where pc.org_id = c.org_id and pc.commitment_id = c.id
        and pc.status in ('approved', 'billed') and cco.id = any(coalesce(pc.change_order_ids, '{}'))
    )
) claimed on true
where c.commitment_type = 'purchase_order'
  and c.status in ('approved', 'active', 'complete', 'completed');

revoke all on public.purchase_order_positions from public, anon, authenticated;
grant select on public.purchase_order_positions to service_role;
