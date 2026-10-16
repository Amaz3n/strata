-- Material delivery: what was received against a purchase order, and what is short.
--
-- A purchase order says what a vendor owes a home; until now nothing recorded
-- what arrived. The daily report's delivery rows stay free text for deliveries
-- that have no order; this is the ledger for the ones that do.
--
-- 1. commitment_lines.needed_by: the date the home needs the line. A line with a
--    need-by date is RECEIVABLE and tracked on the Deliveries desk; labour and
--    lump-sum lines are simply never given one. Nothing infers it.
-- 2. po_receipts / po_receipt_lines: one delivery ticket and its lines, written
--    only by record_po_receipt (service role), retry-safe on an idempotency key,
--    immutable except void. Over-receipt is allowed with a reason. Quantity that
--    arrived damaged or as the wrong item is recorded but does not count as
--    received, and opens a shortage.
-- 3. po_shortages: a line that is behind, one row per line while it is active
--    (open or backordered). Opened by a receiver ("close short"), by a damaged
--    or wrong-item receipt, or by the nightly sweep when a line's expected date
--    has passed with quantity outstanding. Closed by receiving the rest, or by
--    purchasing: back-order with a new date (restarts the clock), raise a VPO,
--    accept short, or cancel. Internal only; the vendor is not told.
--    Outstanding quantity is never stored: it is the line's quantity less the
--    accepted, non-void receipts, derived in list_po_delivery_queue.
-- 4. RBAC: po_receipt.record, held by the roles that run a house or buy for it.
--    Resolving a shortage reuses po_exception.resolve.
--
-- Members read through row security (permission plus the division wall) and
-- write nothing: every write is a definer function that audits and records an
-- event in the same transaction. Every auth.uid() is written (select auth.uid()).

-- ---------------------------------------------------------------------------
-- 1. The need-by date.
-- ---------------------------------------------------------------------------

alter table public.commitment_lines add column if not exists needed_by date;

create index if not exists commitment_lines_needed_by_idx
  on public.commitment_lines (org_id, needed_by) where needed_by is not null;

comment on column public.commitment_lines.needed_by is
  'The date the home needs this line. A line with one is receivable and tracked on the Deliveries desk (lib/services/po-receipts.ts).';

-- ---------------------------------------------------------------------------
-- 2. Receipts.
-- ---------------------------------------------------------------------------

create table if not exists public.po_receipts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  commitment_id uuid not null references public.commitments(id) on delete cascade,
  received_at timestamptz not null default now(),
  received_by uuid references public.app_users(id),
  ticket_number text,
  note text,
  photo_file_ids uuid[] not null default '{}',
  idempotency_key text not null,
  status text not null default 'recorded',
  voided_by uuid references public.app_users(id),
  voided_at timestamptz,
  void_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint po_receipts_status_check check (status in ('recorded', 'void')),
  constraint po_receipts_key_check check (length(btrim(idempotency_key)) between 1 and 200),
  constraint po_receipts_text_check check (
    (ticket_number is null or length(ticket_number) <= 120)
    and (note is null or length(note) <= 2000)
    and (void_reason is null or length(void_reason) <= 2000)
  ),
  constraint po_receipts_photos_check check (cardinality(photo_file_ids) <= 20),
  constraint po_receipts_void_check check (
    (status = 'void') = (voided_at is not null and voided_by is not null and length(btrim(coalesce(void_reason, ''))) >= 3)
  )
);

-- Capture is retry-safe: the same key is the same delivery.
create unique index if not exists po_receipts_key_uidx on public.po_receipts (org_id, idempotency_key);
create index if not exists po_receipts_org_project_idx on public.po_receipts (org_id, project_id);
create index if not exists po_receipts_commitment_idx on public.po_receipts (commitment_id, received_at desc);
create index if not exists po_receipts_project_idx on public.po_receipts (project_id);
create index if not exists po_receipts_received_by_idx on public.po_receipts (received_by) where received_by is not null;
create index if not exists po_receipts_voided_by_idx on public.po_receipts (voided_by) where voided_by is not null;

comment on table public.po_receipts is
  'One delivery ticket against a purchase order. Written by record_po_receipt, immutable except void (lib/services/po-receipts.ts).';

create table if not exists public.po_receipt_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  receipt_id uuid not null references public.po_receipts(id) on delete cascade,
  commitment_id uuid not null references public.commitments(id) on delete cascade,
  commitment_line_id uuid not null references public.commitment_lines(id),
  quantity_received numeric not null,
  condition text not null default 'ok',
  note text,
  over_receipt_reason text,
  created_at timestamptz not null default now(),
  constraint po_receipt_lines_quantity_check check (quantity_received > 0),
  constraint po_receipt_lines_condition_check check (condition in ('ok', 'damaged', 'wrong_item')),
  constraint po_receipt_lines_text_check check (
    (note is null or length(note) <= 2000) and (over_receipt_reason is null or length(over_receipt_reason) <= 2000)
  ),
  constraint po_receipt_lines_line_key unique (receipt_id, commitment_line_id)
);

create index if not exists po_receipt_lines_org_project_idx on public.po_receipt_lines (org_id, project_id);
create index if not exists po_receipt_lines_line_idx on public.po_receipt_lines (commitment_line_id);
create index if not exists po_receipt_lines_commitment_idx on public.po_receipt_lines (commitment_id);
create index if not exists po_receipt_lines_project_idx on public.po_receipt_lines (project_id);

comment on table public.po_receipt_lines is
  'The quantity of one purchase-order line on a delivery ticket. Only condition ok counts as received.';

-- ---------------------------------------------------------------------------
-- 3. Shortages.
-- ---------------------------------------------------------------------------

create table if not exists public.po_shortages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete cascade,
  commitment_id uuid not null references public.commitments(id) on delete cascade,
  commitment_line_id uuid not null references public.commitment_lines(id) on delete cascade,
  short_quantity numeric not null,
  reason text not null,
  status text not null default 'open',
  note text,
  opened_by uuid references public.app_users(id),
  opened_at timestamptz not null default now(),
  backorder_date date,
  vpo_id uuid references public.commitment_change_orders(id) on delete set null,
  resolved_by uuid references public.app_users(id),
  resolved_at timestamptz,
  resolution_note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint po_shortages_quantity_check check (short_quantity > 0),
  constraint po_shortages_reason_check check (reason in ('vendor_short', 'damaged', 'wrong_item', 'late', 'not_delivered')),
  constraint po_shortages_status_check check (status in ('open', 'backordered', 'received', 'vpo', 'accepted_short', 'cancelled')),
  constraint po_shortages_text_check check (
    (note is null or length(note) <= 2000) and (resolution_note is null or length(resolution_note) <= 2000)
  ),
  -- Active while open or backordered; every closing says who and when.
  constraint po_shortages_resolved_check check (
    (status in ('open', 'backordered')) = (resolved_at is null)
    and (resolved_at is null) = (resolved_by is null)
  ),
  constraint po_shortages_backorder_check check ((status = 'backordered') = (backorder_date is not null)),
  constraint po_shortages_vpo_check check (vpo_id is null or status = 'vpo'),
  constraint po_shortages_close_note_check check (
    status not in ('accepted_short', 'cancelled') or length(btrim(coalesce(resolution_note, ''))) >= 3
  )
);

-- One active shortage per line: the sweep and a receiver cannot both open one.
create unique index if not exists po_shortages_active_line_uidx
  on public.po_shortages (commitment_line_id) where status in ('open', 'backordered');
create index if not exists po_shortages_org_project_idx on public.po_shortages (org_id, project_id);
create index if not exists po_shortages_org_status_idx on public.po_shortages (org_id, status, opened_at desc);
create index if not exists po_shortages_commitment_idx on public.po_shortages (commitment_id);
create index if not exists po_shortages_line_idx on public.po_shortages (commitment_line_id);
create index if not exists po_shortages_project_idx on public.po_shortages (project_id);
create index if not exists po_shortages_vpo_idx on public.po_shortages (vpo_id) where vpo_id is not null;
create index if not exists po_shortages_opened_by_idx on public.po_shortages (opened_by) where opened_by is not null;
create index if not exists po_shortages_resolved_by_idx on public.po_shortages (resolved_by) where resolved_by is not null;

comment on table public.po_shortages is
  'A purchase-order line that is behind: late, short, damaged or wrong. One active row per line; closed by receipt or by purchasing (resolve_po_shortage). Internal only.';

-- ---------------------------------------------------------------------------
-- Guards: every reference stays inside the organization and the order, and a
-- receipt is a record.
-- ---------------------------------------------------------------------------

create or replace function public.guard_po_receipt_references()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.commitments c
    where c.id = new.commitment_id and c.org_id = new.org_id and c.project_id = new.project_id
      and c.commitment_type = 'purchase_order'
  ) then
    raise exception 'The purchase order does not belong to this home' using errcode = '23503';
  end if;
  if tg_table_name = 'po_receipts' then
    if new.received_by is not null and not exists (
      select 1 from public.memberships m where m.org_id = new.org_id and m.user_id = new.received_by
    ) then
      raise exception 'The receiver is not a member of this organization' using errcode = '23503';
    end if;
    return new;
  end if;
  if tg_table_name = 'po_receipt_lines' then
    if not exists (
      select 1 from public.po_receipts r
      where r.id = new.receipt_id and r.org_id = new.org_id and r.commitment_id = new.commitment_id
    ) then
      raise exception 'The receipt is for another purchase order' using errcode = '23503';
    end if;
  end if;
  if not exists (
    select 1 from public.commitment_lines l
    where l.id = new.commitment_line_id and l.org_id = new.org_id and l.commitment_id = new.commitment_id
  ) then
    raise exception 'The line is not on this purchase order' using errcode = '23503';
  end if;
  if tg_table_name = 'po_shortages' then
    if new.vpo_id is not null and not exists (
      select 1 from public.commitment_change_orders v
      where v.id = new.vpo_id and v.org_id = new.org_id and v.commitment_id = new.commitment_id
    ) then
      raise exception 'The variance order is not on this purchase order' using errcode = '23503';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_po_receipt_references() from public, anon, authenticated;

drop trigger if exists po_receipts_references on public.po_receipts;
create trigger po_receipts_references
  before insert or update of org_id, project_id, commitment_id, received_by on public.po_receipts
  for each row execute function public.guard_po_receipt_references();

drop trigger if exists po_receipt_lines_references on public.po_receipt_lines;
create trigger po_receipt_lines_references
  before insert or update of org_id, project_id, receipt_id, commitment_id, commitment_line_id on public.po_receipt_lines
  for each row execute function public.guard_po_receipt_references();

drop trigger if exists po_shortages_references on public.po_shortages;
create trigger po_shortages_references
  before insert or update of org_id, project_id, commitment_id, commitment_line_id, vpo_id on public.po_shortages
  for each row execute function public.guard_po_receipt_references();

create or replace function public.guard_po_receipt_record()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_table_name = 'po_receipt_lines' then
    raise exception 'A received quantity cannot be changed; void the receipt and record it again' using errcode = '42501';
  end if;
  if tg_table_name = 'po_receipts' then
    if row(new.org_id, new.project_id, new.commitment_id, new.received_at, new.received_by, new.ticket_number,
           new.note, new.photo_file_ids, new.idempotency_key)
       is distinct from
       row(old.org_id, old.project_id, old.commitment_id, old.received_at, old.received_by, old.ticket_number,
           old.note, old.photo_file_ids, old.idempotency_key) then
      raise exception 'A receipt cannot be changed; void it and record it again' using errcode = '42501';
    end if;
    if old.status = 'void' and new.status is distinct from old.status then
      raise exception 'This receipt is already void' using errcode = '42501';
    end if;
    return new;
  end if;
  -- po_shortages
  if row(new.org_id, new.project_id, new.commitment_id, new.commitment_line_id, new.short_quantity, new.opened_by, new.opened_at)
     is distinct from
     row(old.org_id, old.project_id, old.commitment_id, old.commitment_line_id, old.short_quantity, old.opened_by, old.opened_at) then
    raise exception 'A shortage''s line and quantity cannot be changed' using errcode = '42501';
  end if;
  -- A late shortage is re-labelled when the receiver closes the line short.
  if new.reason is distinct from old.reason and old.reason <> 'late' then
    raise exception 'A shortage''s reason cannot be changed' using errcode = '42501';
  end if;
  if old.status not in ('open', 'backordered') and new.status is distinct from old.status then
    raise exception 'This shortage is already closed' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_po_receipt_record() from public, anon, authenticated;

drop trigger if exists po_receipts_record on public.po_receipts;
create trigger po_receipts_record
  before update on public.po_receipts
  for each row execute function public.guard_po_receipt_record();

drop trigger if exists po_receipt_lines_record on public.po_receipt_lines;
create trigger po_receipt_lines_record
  before update on public.po_receipt_lines
  for each row execute function public.guard_po_receipt_record();

drop trigger if exists po_shortages_record on public.po_shortages;
create trigger po_shortages_record
  before update on public.po_shortages
  for each row execute function public.guard_po_receipt_record();

drop trigger if exists po_receipts_set_updated_at on public.po_receipts;
create trigger po_receipts_set_updated_at
  before update on public.po_receipts
  for each row execute function public.tg_set_updated_at();

drop trigger if exists po_shortages_set_updated_at on public.po_shortages;
create trigger po_shortages_set_updated_at
  before update on public.po_shortages
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- Row security: read with the permission and the division wall; no writes.
-- ---------------------------------------------------------------------------

alter table public.po_receipts enable row level security;
alter table public.po_receipt_lines enable row level security;
alter table public.po_shortages enable row level security;

drop policy if exists po_receipts_read on public.po_receipts;
create policy po_receipts_read on public.po_receipts
  for select to authenticated
  using (
    public.has_org_permission(org_id, 'po_receipt.record')
    or public.has_org_permission(org_id, 'price_book.read')
    or public.has_org_permission(org_id, 'commitment.read')
  );

drop policy if exists po_receipt_lines_read on public.po_receipt_lines;
create policy po_receipt_lines_read on public.po_receipt_lines
  for select to authenticated
  using (
    public.has_org_permission(org_id, 'po_receipt.record')
    or public.has_org_permission(org_id, 'price_book.read')
    or public.has_org_permission(org_id, 'commitment.read')
  );

drop policy if exists po_shortages_read on public.po_shortages;
create policy po_shortages_read on public.po_shortages
  for select to authenticated
  using (
    public.has_org_permission(org_id, 'po_receipt.record')
    or public.has_org_permission(org_id, 'price_book.read')
    or public.has_org_permission(org_id, 'commitment.read')
  );

drop policy if exists po_receipts_division_scope on public.po_receipts;
create policy po_receipts_division_scope on public.po_receipts
  as restrictive for all to authenticated
  using (org_id = any ((select public.member_unscoped_org_ids())::uuid[]) or project_id in (select public.member_reachable_project_ids()))
  with check (org_id = any ((select public.member_unscoped_org_ids())::uuid[]) or project_id in (select public.member_reachable_project_ids()));

drop policy if exists po_receipt_lines_division_scope on public.po_receipt_lines;
create policy po_receipt_lines_division_scope on public.po_receipt_lines
  as restrictive for all to authenticated
  using (org_id = any ((select public.member_unscoped_org_ids())::uuid[]) or project_id in (select public.member_reachable_project_ids()))
  with check (org_id = any ((select public.member_unscoped_org_ids())::uuid[]) or project_id in (select public.member_reachable_project_ids()));

drop policy if exists po_shortages_division_scope on public.po_shortages;
create policy po_shortages_division_scope on public.po_shortages
  as restrictive for all to authenticated
  using (org_id = any ((select public.member_unscoped_org_ids())::uuid[]) or project_id in (select public.member_reachable_project_ids()))
  with check (org_id = any ((select public.member_unscoped_org_ids())::uuid[]) or project_id in (select public.member_reachable_project_ids()));

revoke all on table public.po_receipts, public.po_receipt_lines, public.po_shortages from anon, authenticated;
grant select on table public.po_receipts, public.po_receipt_lines, public.po_shortages to authenticated;
grant all on table public.po_receipts, public.po_receipt_lines, public.po_shortages to service_role;

-- ---------------------------------------------------------------------------
-- The one rule for what has arrived: accepted quantity on non-void receipts.
-- ---------------------------------------------------------------------------

create or replace function public.po_line_received_quantity(p_line_id uuid)
returns numeric
language sql
stable
set search_path = ''
as $$
  select coalesce(sum(l.quantity_received), 0)
  from public.po_receipt_lines l
  join public.po_receipts r on r.id = l.receipt_id
  where l.commitment_line_id = p_line_id and l.condition = 'ok' and r.status = 'recorded';
$$;

revoke all on function public.po_line_received_quantity(uuid) from public, anon, authenticated;
grant execute on function public.po_line_received_quantity(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- record_po_receipt: lock the order, validate every line, write the ticket,
-- close or open shortages, audit and announce. Retry-safe on the key.
--
-- p_lines is an array of {commitment_line_id, quantity, condition?, note?,
-- over_receipt_reason?}. Returns {id, project_id, commitment_id, replayed,
-- shortages: [{id, commitment_line_id, reason}]}.
-- ---------------------------------------------------------------------------

create or replace function public.record_po_receipt(
  p_org_id uuid,
  p_actor_id uuid,
  p_commitment_id uuid,
  p_idempotency_key text,
  p_received_at timestamptz,
  p_ticket_number text,
  p_note text,
  p_photo_file_ids uuid[],
  p_lines jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_po public.commitments%rowtype;
  v_existing public.po_receipts%rowtype;
  v_receipt_id uuid;
  v_el jsonb;
  v_line public.commitment_lines%rowtype;
  v_qty numeric;
  v_cond text;
  v_reason text;
  v_prior numeric;
  v_outstanding numeric;
  v_seen uuid[] := '{}';
  v_shortages jsonb := '[]'::jsonb;
  v_shortage_id uuid;
  v_photos uuid[] := coalesce(p_photo_file_ids, '{}');
  v_over boolean := false;
  v_summary jsonb := '[]'::jsonb;
begin
  if p_idempotency_key is null or length(btrim(p_idempotency_key)) = 0 then
    raise exception 'A receipt needs an idempotency key' using errcode = '22023';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Receive at least one line' using errcode = '22023';
  end if;

  select * into v_po from public.commitments where id = p_commitment_id and org_id = p_org_id for update;
  if not found or v_po.commitment_type <> 'purchase_order' then
    raise exception 'Purchase order not found' using errcode = '42501';
  end if;

  select * into v_existing from public.po_receipts where org_id = p_org_id and idempotency_key = p_idempotency_key;
  if found then
    if v_existing.commitment_id <> p_commitment_id then
      raise exception 'That receipt key was already used for another purchase order' using errcode = '23505';
    end if;
    return jsonb_build_object('id', v_existing.id, 'project_id', v_po.project_id, 'commitment_id', p_commitment_id,
      'replayed', true, 'shortages', '[]'::jsonb);
  end if;

  if v_po.status not in ('approved', 'complete') then
    raise exception 'A purchase order has to be issued before it can be received against' using errcode = '22023';
  end if;
  if exists (
    select 1 from unnest(v_photos) as f(id)
    where not exists (select 1 from public.files x where x.id = f.id and x.org_id = p_org_id and x.project_id = v_po.project_id)
  ) then
    raise exception 'A photo does not belong to this home' using errcode = '22023';
  end if;

  insert into public.po_receipts(org_id, project_id, commitment_id, received_at, received_by, ticket_number, note,
    photo_file_ids, idempotency_key)
  values (p_org_id, v_po.project_id, p_commitment_id, coalesce(p_received_at, now()), p_actor_id,
    nullif(btrim(p_ticket_number), ''), nullif(btrim(p_note), ''), v_photos, btrim(p_idempotency_key))
  returning id into v_receipt_id;

  for v_el in select * from jsonb_array_elements(p_lines) loop
    select * into v_line from public.commitment_lines
    where id = (v_el->>'commitment_line_id')::uuid and org_id = p_org_id and commitment_id = p_commitment_id;
    if not found then
      raise exception 'A line is not on this purchase order' using errcode = '22023';
    end if;
    if v_line.id = any (v_seen) then
      raise exception 'A line can be received once per ticket' using errcode = '22023';
    end if;
    v_seen := v_seen || v_line.id;
    if v_line.needed_by is null then
      raise exception 'Give "%" a need-by date before receiving it', v_line.description using errcode = '22023';
    end if;
    v_qty := (v_el->>'quantity')::numeric;
    if v_qty is null or v_qty <= 0 then
      raise exception 'Received quantity must be more than zero' using errcode = '22023';
    end if;
    v_cond := coalesce(nullif(v_el->>'condition', ''), 'ok');
    if v_cond not in ('ok', 'damaged', 'wrong_item') then
      raise exception 'Unknown condition %', v_cond using errcode = '22023';
    end if;
    v_reason := nullif(btrim(coalesce(v_el->>'over_receipt_reason', '')), '');

    v_prior := public.po_line_received_quantity(v_line.id);
    if v_cond = 'ok' and v_prior + v_qty > v_line.quantity then
      if v_reason is null or length(v_reason) < 3 then
        raise exception 'Receiving % of "%" puts it over the % ordered; say why', v_qty, v_line.description, v_line.quantity
          using errcode = '22023';
      end if;
      v_over := true;
    else
      v_reason := null;
    end if;

    insert into public.po_receipt_lines(org_id, project_id, receipt_id, commitment_id, commitment_line_id,
      quantity_received, condition, note, over_receipt_reason)
    values (p_org_id, v_po.project_id, v_receipt_id, p_commitment_id, v_line.id, v_qty, v_cond,
      nullif(btrim(coalesce(v_el->>'note', '')), ''), v_reason);

    v_summary := v_summary || jsonb_build_object('commitment_line_id', v_line.id, 'quantity', v_qty, 'condition', v_cond);
    v_outstanding := v_line.quantity - v_prior - case when v_cond = 'ok' then v_qty else 0 end;

    if v_cond <> 'ok' then
      v_shortage_id := null;
      insert into public.po_shortages(org_id, project_id, commitment_id, commitment_line_id, short_quantity, reason,
        note, opened_by)
      values (p_org_id, v_po.project_id, p_commitment_id, v_line.id, v_qty, v_cond,
        nullif(btrim(coalesce(v_el->>'note', '')), ''), p_actor_id)
      on conflict (commitment_line_id) where status in ('open', 'backordered') do nothing
      returning id into v_shortage_id;
      if v_shortage_id is not null then
        v_shortages := v_shortages || jsonb_build_object('id', v_shortage_id, 'commitment_line_id', v_line.id, 'reason', v_cond);
        insert into public.audit_log(org_id, actor_user_id, action, entity_type, entity_id, after_data, source)
        values (p_org_id, p_actor_id, 'insert', 'po_shortage', v_shortage_id,
          jsonb_build_object('commitment_id', p_commitment_id, 'commitment_line_id', v_line.id, 'reason', v_cond, 'short_quantity', v_qty),
          'po_receipts.shortage_opened');
        insert into public.events(org_id, event_type, entity_type, entity_id, payload, channel)
        values (p_org_id, 'po_shortage.opened', 'po_shortage', v_shortage_id,
          jsonb_build_object('project_id', v_po.project_id, 'commitment_id', p_commitment_id, 'reason', v_cond, 'actor_id', p_actor_id), 'activity');
      end if;
    elsif v_outstanding <= 0 then
      update public.po_shortages
      set status = 'received', backorder_date = null, resolved_by = p_actor_id, resolved_at = now(),
          resolution_note = 'Received in full'
      where commitment_line_id = v_line.id and status in ('open', 'backordered');
    end if;
  end loop;

  insert into public.audit_log(org_id, actor_user_id, action, entity_type, entity_id, after_data, source)
  values (p_org_id, p_actor_id, 'insert', 'po_receipt', v_receipt_id,
    jsonb_build_object('commitment_id', p_commitment_id, 'ticket_number', nullif(btrim(p_ticket_number), ''),
      'lines', v_summary, 'over_receipt', v_over),
    'po_receipts.recorded');
  insert into public.events(org_id, event_type, entity_type, entity_id, payload, channel)
  values (p_org_id, 'po_receipt.recorded', 'po_receipt', v_receipt_id,
    jsonb_build_object('project_id', v_po.project_id, 'commitment_id', p_commitment_id, 'line_count', jsonb_array_length(v_summary),
      'over_receipt', v_over, 'actor_id', p_actor_id), 'activity');

  return jsonb_build_object('id', v_receipt_id, 'project_id', v_po.project_id, 'commitment_id', p_commitment_id,
    'replayed', false, 'shortages', v_shortages);
end;
$$;

revoke all on function public.record_po_receipt(uuid, uuid, uuid, text, timestamptz, text, text, uuid[], jsonb) from public, anon, authenticated;
grant execute on function public.record_po_receipt(uuid, uuid, uuid, text, timestamptz, text, text, uuid[], jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- close_po_line_short: the receiver is done with a delivery and the rest of the
-- line is not coming. Opens the line's shortage (or re-labels a late one).
-- ---------------------------------------------------------------------------

create or replace function public.close_po_line_short(
  p_org_id uuid,
  p_actor_id uuid,
  p_commitment_line_id uuid,
  p_reason text,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_line public.commitment_lines%rowtype;
  v_po public.commitments%rowtype;
  v_active public.po_shortages%rowtype;
  v_outstanding numeric;
  v_id uuid;
begin
  if p_reason not in ('vendor_short', 'not_delivered') then
    raise exception 'A line closed short is either short from the vendor or not delivered' using errcode = '22023';
  end if;
  select * into v_line from public.commitment_lines where id = p_commitment_line_id and org_id = p_org_id;
  if not found then
    raise exception 'Purchase-order line not found' using errcode = '42501';
  end if;
  select * into v_po from public.commitments where id = v_line.commitment_id and org_id = p_org_id for update;
  if not found or v_po.commitment_type <> 'purchase_order' or v_po.status <> 'approved' then
    raise exception 'Only a line on an issued, open purchase order can be closed short' using errcode = '22023';
  end if;
  if v_line.needed_by is null then
    raise exception 'Give "%" a need-by date first', v_line.description using errcode = '22023';
  end if;
  v_outstanding := v_line.quantity - public.po_line_received_quantity(v_line.id);
  if v_outstanding <= 0 then
    raise exception 'Nothing is outstanding on this line' using errcode = '22023';
  end if;

  select * into v_active from public.po_shortages
  where commitment_line_id = v_line.id and status in ('open', 'backordered') for update;
  if found then
    if v_active.reason = 'late' then
      update public.po_shortages set reason = p_reason, note = coalesce(nullif(btrim(p_note), ''), note)
      where id = v_active.id;
      insert into public.audit_log(org_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, source)
      values (p_org_id, p_actor_id, 'update', 'po_shortage', v_active.id,
        jsonb_build_object('reason', 'late'), jsonb_build_object('reason', p_reason), 'po_receipts.closed_short');
    end if;
    return jsonb_build_object('id', v_active.id, 'project_id', v_po.project_id, 'commitment_id', v_po.id, 'opened', false);
  end if;

  insert into public.po_shortages(org_id, project_id, commitment_id, commitment_line_id, short_quantity, reason, note, opened_by)
  values (p_org_id, v_po.project_id, v_po.id, v_line.id, v_outstanding, p_reason, nullif(btrim(p_note), ''), p_actor_id)
  returning id into v_id;
  insert into public.audit_log(org_id, actor_user_id, action, entity_type, entity_id, after_data, source)
  values (p_org_id, p_actor_id, 'insert', 'po_shortage', v_id,
    jsonb_build_object('commitment_id', v_po.id, 'commitment_line_id', v_line.id, 'reason', p_reason, 'short_quantity', v_outstanding),
    'po_receipts.closed_short');
  insert into public.events(org_id, event_type, entity_type, entity_id, payload, channel)
  values (p_org_id, 'po_shortage.opened', 'po_shortage', v_id,
    jsonb_build_object('project_id', v_po.project_id, 'commitment_id', v_po.id, 'reason', p_reason, 'actor_id', p_actor_id), 'activity');
  return jsonb_build_object('id', v_id, 'project_id', v_po.project_id, 'commitment_id', v_po.id, 'opened', true);
end;
$$;

revoke all on function public.close_po_line_short(uuid, uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function public.close_po_line_short(uuid, uuid, uuid, text, text) to service_role;

-- ---------------------------------------------------------------------------
-- resolve_po_shortage: purchasing's answer. backordered restarts the clock on a
-- new date (and may be repeated); accepted_short and cancelled need a note; vpo
-- links the variance order raised for the replacement.
-- ---------------------------------------------------------------------------

create or replace function public.resolve_po_shortage(
  p_org_id uuid,
  p_actor_id uuid,
  p_shortage_id uuid,
  p_resolution text,
  p_backorder_date date,
  p_note text,
  p_vpo_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_row public.po_shortages%rowtype;
  v_note text := nullif(btrim(p_note), '');
begin
  if p_resolution not in ('backordered', 'vpo', 'accepted_short', 'cancelled') then
    raise exception 'Unknown resolution %', p_resolution using errcode = '22023';
  end if;
  select * into v_row from public.po_shortages where id = p_shortage_id and org_id = p_org_id for update;
  if not found then
    raise exception 'Shortage not found' using errcode = '42501';
  end if;
  if v_row.status not in ('open', 'backordered') then
    raise exception 'This shortage was already resolved' using errcode = '40001';
  end if;
  if p_resolution = 'backordered' and p_backorder_date is null then
    raise exception 'Give the date the back-order is promised for' using errcode = '22023';
  end if;
  if p_resolution = 'vpo' and p_vpo_id is null then
    raise exception 'Name the variance order' using errcode = '22023';
  end if;
  if p_resolution in ('accepted_short', 'cancelled') and (v_note is null or length(v_note) < 3) then
    raise exception 'Say why' using errcode = '22023';
  end if;

  if p_resolution = 'backordered' then
    update public.po_shortages
    set status = 'backordered', backorder_date = p_backorder_date, resolution_note = v_note
    where id = p_shortage_id;
  else
    update public.po_shortages
    set status = p_resolution, backorder_date = null, vpo_id = case when p_resolution = 'vpo' then p_vpo_id else null end,
        resolved_by = p_actor_id, resolved_at = now(), resolution_note = v_note
    where id = p_shortage_id;
  end if;

  insert into public.audit_log(org_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, source)
  values (p_org_id, p_actor_id, 'update', 'po_shortage', p_shortage_id,
    jsonb_build_object('status', v_row.status, 'backorder_date', v_row.backorder_date),
    jsonb_build_object('status', p_resolution, 'backorder_date', p_backorder_date, 'vpo_id', p_vpo_id, 'note', v_note),
    'po_receipts.shortage_resolved');
  insert into public.events(org_id, event_type, entity_type, entity_id, payload, channel)
  values (p_org_id, 'po_shortage.resolved', 'po_shortage', p_shortage_id,
    jsonb_build_object('project_id', v_row.project_id, 'commitment_id', v_row.commitment_id, 'resolution', p_resolution, 'actor_id', p_actor_id), 'activity');
  return jsonb_build_object('id', p_shortage_id, 'project_id', v_row.project_id, 'resolution', p_resolution);
end;
$$;

revoke all on function public.resolve_po_shortage(uuid, uuid, uuid, text, date, text, uuid) from public, anon, authenticated;
grant execute on function public.resolve_po_shortage(uuid, uuid, uuid, text, date, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- void_po_receipt: a mistaken ticket comes off the books and its quantity is
-- outstanding again. The record stays.
-- ---------------------------------------------------------------------------

create or replace function public.void_po_receipt(
  p_org_id uuid,
  p_actor_id uuid,
  p_receipt_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_receipt public.po_receipts%rowtype;
  v_reason text := nullif(btrim(p_reason), '');
begin
  if v_reason is null or length(v_reason) < 3 then
    raise exception 'Say why this receipt is void' using errcode = '22023';
  end if;
  select * into v_receipt from public.po_receipts where id = p_receipt_id and org_id = p_org_id;
  if not found then
    raise exception 'Receipt not found' using errcode = '42501';
  end if;
  perform 1 from public.commitments where id = v_receipt.commitment_id and org_id = p_org_id for update;
  select * into v_receipt from public.po_receipts where id = p_receipt_id and org_id = p_org_id for update;
  if v_receipt.status = 'void' then
    raise exception 'This receipt was already voided' using errcode = '40001';
  end if;
  update public.po_receipts
  set status = 'void', voided_by = p_actor_id, voided_at = now(), void_reason = v_reason
  where id = p_receipt_id;
  insert into public.audit_log(org_id, actor_user_id, action, entity_type, entity_id, before_data, after_data, source)
  values (p_org_id, p_actor_id, 'update', 'po_receipt', p_receipt_id,
    jsonb_build_object('status', 'recorded'), jsonb_build_object('status', 'void', 'reason', v_reason), 'po_receipts.voided');
  insert into public.events(org_id, event_type, entity_type, entity_id, payload, channel)
  values (p_org_id, 'po_receipt.voided', 'po_receipt', p_receipt_id,
    jsonb_build_object('project_id', v_receipt.project_id, 'commitment_id', v_receipt.commitment_id, 'actor_id', p_actor_id), 'activity');
  return jsonb_build_object('id', p_receipt_id, 'project_id', v_receipt.project_id);
end;
$$;

revoke all on function public.void_po_receipt(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function public.void_po_receipt(uuid, uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- The nightly sweep: a line whose expected date has passed with quantity
-- outstanding gets one 'late' shortage. A line that already has an active
-- shortage, or one purchasing closed without receiving it, is left alone, so a
-- second run changes nothing.
-- ---------------------------------------------------------------------------

create or replace function public.sweep_late_po_deliveries(p_today date, p_limit integer)
returns table (id uuid, org_id uuid, project_id uuid, commitment_id uuid)
language sql
security definer
set search_path = ''
as $$
  with due as (
    select l.id as line_id, l.org_id, c.project_id, c.id as commitment_id,
           l.quantity - public.po_line_received_quantity(l.id) as outstanding
    from public.commitment_lines l
    join public.commitments c on c.id = l.commitment_id and c.org_id = l.org_id
    where c.commitment_type = 'purchase_order' and c.status = 'approved'
      and l.needed_by is not null and l.needed_by < coalesce(p_today, current_date)
      and l.quantity - public.po_line_received_quantity(l.id) > 0
      and not exists (
        select 1 from public.po_shortages s
        where s.commitment_line_id = l.id
          and s.status in ('open', 'backordered', 'vpo', 'accepted_short', 'cancelled')
      )
    order by l.needed_by, l.id
    limit greatest(least(coalesce(p_limit, 500), 2000), 1)
  ),
  opened as (
    insert into public.po_shortages(org_id, project_id, commitment_id, commitment_line_id, short_quantity, reason)
    select d.org_id, d.project_id, d.commitment_id, d.line_id, d.outstanding, 'late' from due d
    on conflict (commitment_line_id) where status in ('open', 'backordered') do nothing
    returning po_shortages.id, po_shortages.org_id, po_shortages.project_id, po_shortages.commitment_id,
              po_shortages.commitment_line_id, po_shortages.short_quantity
  ),
  audited as (
    insert into public.audit_log(org_id, actor_user_id, action, entity_type, entity_id, after_data, source)
    select o.org_id, null, 'insert', 'po_shortage', o.id,
      jsonb_build_object('commitment_id', o.commitment_id, 'commitment_line_id', o.commitment_line_id,
        'reason', 'late', 'short_quantity', o.short_quantity),
      'po_receipts.late_sweep'
    from opened o
  ),
  announced as (
    insert into public.events(org_id, event_type, entity_type, entity_id, payload, channel)
    select o.org_id, 'po_shortage.opened', 'po_shortage', o.id,
      jsonb_build_object('project_id', o.project_id, 'commitment_id', o.commitment_id, 'reason', 'late', 'source', 'late_sweep'),
      'activity'
    from opened o
  )
  select o.id, o.org_id, o.project_id, o.commitment_id from opened o;
$$;

revoke all on function public.sweep_late_po_deliveries(date, integer) from public, anon, authenticated;
grant execute on function public.sweep_late_po_deliveries(date, integer) to service_role;

-- ---------------------------------------------------------------------------
-- list_po_delivery_queue: every tracked line with what was ordered, received and
-- is outstanding, and its state, aggregated here so paging, counting and the
-- state filter agree. The caller has already authorized the read and passes its
-- scope: divisions (null = all), a member user when the reader only reaches the
-- homes they are on, and an optional community, home or order.
--
-- state: received > closed (purchasing closed it without receiving it, or the
-- order is complete) > short (damaged, wrong, short or not delivered) > late
-- (expected date passed) > partial > expected. p_state 'open' is every line
-- still owed; 'all' adds received and closed.
-- ---------------------------------------------------------------------------

create or replace function public.list_po_delivery_queue(
  p_org_id uuid,
  p_division_ids uuid[],
  p_member_user_id uuid,
  p_community_id uuid,
  p_project_id uuid,
  p_commitment_id uuid,
  p_state text,
  p_today date,
  p_limit integer,
  p_offset integer
)
returns table (
  line_id uuid,
  commitment_id uuid,
  project_id uuid,
  project_name text,
  po_title text,
  contract_number text,
  vendor_name text,
  cost_code_id uuid,
  description text,
  unit text,
  ordered numeric,
  received numeric,
  outstanding numeric,
  needed_by date,
  expected_date date,
  days_late integer,
  state text,
  shortage_id uuid,
  shortage_status text,
  shortage_reason text,
  backorder_date date,
  total_count bigint
)
language sql
stable
security definer
set search_path = ''
as $$
  with base as (
    select
      l.id as line_id, c.id as commitment_id, c.project_id, pr.name as project_name, c.title as po_title,
      c.contract_number, co.name as vendor_name, l.cost_code_id, l.description, l.unit,
      l.quantity as ordered,
      public.po_line_received_quantity(l.id) as received,
      l.quantity - public.po_line_received_quantity(l.id) as outstanding,
      l.needed_by,
      coalesce(case when act.status = 'backordered' then act.backorder_date end, l.needed_by) as expected_date,
      c.status as po_status,
      act.id as shortage_id, act.status as shortage_status, act.reason as shortage_reason, act.backorder_date,
      exists (
        select 1 from public.po_shortages f
        where f.commitment_line_id = l.id and f.status in ('vpo', 'accepted_short', 'cancelled')
      ) as closed_out
    from public.commitment_lines l
    join public.commitments c on c.id = l.commitment_id and c.org_id = l.org_id
    join public.projects pr on pr.id = c.project_id and pr.org_id = c.org_id
    left join public.companies co on co.id = c.company_id
    left join lateral (
      select s.id, s.status, s.reason, s.backorder_date from public.po_shortages s
      where s.commitment_line_id = l.id and s.status in ('open', 'backordered') limit 1
    ) act on true
    where l.org_id = p_org_id and l.needed_by is not null
      and c.commitment_type = 'purchase_order' and c.status in ('approved', 'complete')
      and (p_project_id is null or c.project_id = p_project_id)
      and (p_commitment_id is null or c.id = p_commitment_id)
      and (p_division_ids is null or pr.division_id = any (p_division_ids))
      and (p_member_user_id is null or exists (
        select 1 from public.project_members pm
        where pm.org_id = p_org_id and pm.project_id = pr.id and pm.user_id = p_member_user_id and pm.status = 'active'
      ))
      and (p_community_id is null or exists (
        select 1 from public.lots lo
        where lo.org_id = p_org_id and lo.project_id = pr.id and lo.community_id = p_community_id
      ))
  ),
  classified as (
    select b.*,
      case
        when b.outstanding <= 0 then 'received'
        when b.closed_out or b.po_status = 'complete' then 'closed'
        when b.shortage_reason is not null and b.shortage_reason <> 'late' then 'short'
        when b.expected_date < coalesce(p_today, current_date) then 'late'
        when b.received > 0 then 'partial'
        else 'expected'
      end as state
    from base b
  )
  select x.line_id, x.commitment_id, x.project_id, x.project_name, x.po_title, x.contract_number, x.vendor_name,
    x.cost_code_id, x.description, x.unit, x.ordered, x.received, x.outstanding, x.needed_by, x.expected_date,
    case when x.outstanding > 0 then greatest(coalesce(p_today, current_date) - x.expected_date, 0) else 0 end as days_late,
    x.state, x.shortage_id, x.shortage_status, x.shortage_reason, x.backorder_date,
    count(*) over () as total_count
  from classified x
  where case coalesce(p_state, 'open')
    when 'all' then true
    when 'open' then x.state in ('expected', 'late', 'partial', 'short')
    else x.state = p_state
  end
  order by x.expected_date, x.project_name, x.line_id
  limit greatest(least(coalesce(p_limit, 50), 200), 1)
  offset greatest(coalesce(p_offset, 0), 0);
$$;

revoke all on function public.list_po_delivery_queue(uuid, uuid[], uuid, uuid, uuid, uuid, text, date, integer, integer) from public, anon, authenticated;
grant execute on function public.list_po_delivery_queue(uuid, uuid[], uuid, uuid, uuid, uuid, text, date, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- RBAC: po_receipt.record.
--
-- Held by the roles that run a house or buy for it: org_owner, org_admin,
-- org_office_admin, org_project_lead, pm, org_superintendent, field,
-- org_purchasing_manager. Resolving a shortage uses po_exception.resolve
-- (org_owner, org_admin, org_purchasing_manager).
-- ---------------------------------------------------------------------------

insert into public.permissions (key, description) values
  ('po_receipt.record', 'Record deliveries against purchase orders and close lines short')
on conflict (key) do update set description = excluded.description;

insert into public.role_permissions (role_id, permission_key)
select r.id, 'po_receipt.record'
from public.roles r
where r.key in ('org_owner', 'org_admin', 'org_office_admin', 'org_project_lead', 'pm', 'org_superintendent', 'field', 'org_purchasing_manager')
on conflict (role_id, permission_key) do nothing;
