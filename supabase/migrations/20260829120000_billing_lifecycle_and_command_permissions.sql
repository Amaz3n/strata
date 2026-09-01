-- Billing: one derived lifecycle, and money rows that only commands can write.
--
-- Three problems, one migration, because they are the same problem seen from
-- three sides — the database trusted the caller about things the caller had no
-- business deciding.
--
--   1. `saved` was a lifecycle state that meant nothing except "sync me to
--      QuickBooks". `draft` and `saved` were otherwise interchangeable in every
--      guard, every menu and every filter, and the invoice composer autosaved
--      into `saved`, so abandoned drafts became accounts receivable in a real
--      customer's books. It is folded into `draft`.
--
--   2. The invoice RPCs took `status` from their caller and wrote it verbatim,
--      so `paid` with a full balance due, or `sent` with no recipient and no
--      sent_at, were representable. The application no longer sends a status at
--      all; these functions now derive it, and reject one if it is offered.
--
--   3. `invoices`, `invoice_lines` and `payments` carried FOR ALL policies whose
--      only test was org/project membership. That is tenancy, not authorization:
--      any authenticated member could INSERT an invoice, edit an issued one, or
--      write a payment row directly, without ever holding `invoice.write`,
--      `invoice.send` or `payment.release` — the entire financial RBAC catalog
--      lived in application code and nowhere else. Members keep SELECT; every
--      write now goes through the service role, behind an application permission
--      check (see lib/services/receivables-writer.ts).
--
-- ORDER MATTERS: the application changes ship first. This migration is safe to
-- apply only against a deployment whose invoice writes already route through
-- `receivablesWriter()`.

begin;

-- ── 1. `saved` is folded into `draft` ────────────────────────────────────────

update public.invoices
   set status = 'draft'
 where status = 'saved';

alter table public.invoices
  drop constraint if exists invoices_status_check;
alter table public.invoices
  add constraint invoices_status_check
  check (status in ('draft', 'sent', 'partial', 'paid', 'overdue', 'void'));

-- The derivation the payment engine and the recalc job both post through.
create or replace function public.derive_invoice_status(
  p_current_status text,
  p_total_cents integer,
  p_paid_cents bigint,
  p_due_date date,
  p_client_visible boolean,
  p_sent_at timestamptz
)
returns text
language sql
immutable
as $$
  select case
    when p_current_status = 'void' then 'void'
    when greatest(coalesce(p_total_cents, 0) - p_paid_cents, 0) = 0
         and coalesce(p_total_cents, 0) > 0 then 'paid'
    when p_paid_cents > 0 then 'partial'
    when p_sent_at is null
         and not coalesce(p_client_visible, false)
         and coalesce(p_current_status, 'sent') not in ('sent', 'partial', 'paid', 'overdue')
      then 'draft'
    when p_due_date is not null and p_due_date < current_date then 'overdue'
    else 'sent'
  end;
$$;

-- ── 2. The invoice RPCs derive the lifecycle instead of accepting one ────────

create or replace function public.create_invoice_atomic(
  p_org_id uuid,
  p_invoice jsonb,
  p_lines jsonb
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_invoice public.invoices%rowtype;
  v_line jsonb;
  v_line_id uuid;
  v_cost_id uuid;
  v_lines jsonb := '[]'::jsonb;
  v_claimed integer;
  v_draw_id uuid := nullif(p_invoice ->> 'source_draw_id', '')::uuid;
  v_retainage_cents integer := coalesce((p_invoice -> 'metadata' ->> 'retainage_amount_cents')::integer, 0);
  v_contract_id uuid := nullif(p_invoice -> 'metadata' ->> 'source_contract_id', '')::uuid;
  v_issued boolean := coalesce((p_invoice ->> 'client_visible')::boolean, false);
  v_status text;
begin
  if p_org_id is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Invoice requires an organization and at least one line';
  end if;
  if auth.uid() is not null and not public.is_org_member(p_org_id) then
    raise exception 'Not authorized for this organization';
  end if;

  -- A new invoice is either a draft or freshly issued. Anything else — paid,
  -- partial, overdue, void — is a state the ledger reaches on its own.
  if coalesce(nullif(p_invoice ->> 'status', ''), case when v_issued then 'sent' else 'draft' end)
     not in ('draft', 'sent') then
    raise exception 'An invoice cannot be created in state %', p_invoice ->> 'status';
  end if;
  v_status := case when v_issued then 'sent' else 'draft' end;

  if p_invoice ->> 'product_posture' = 'commercial'
    and v_issued
    and p_invoice ->> 'approval_status' <> 'approved' then
    raise exception 'Commercial owner billing must be approved before issue';
  end if;

  insert into public.invoices (
    org_id, project_id, token, invoice_number, title, status, issue_date,
    due_date, notes, client_visible, subtotal_cents, tax_cents, total_cents,
    balance_due_cents, source_type, source_draw_id, source_change_order_id,
    source_pay_application_id, metadata, sent_at, sent_to_emails,
    product_posture, approval_status, delivery_status, issued_snapshot
  ) values (
    p_org_id, nullif(p_invoice ->> 'project_id', '')::uuid,
    nullif(p_invoice ->> 'token', ''), p_invoice ->> 'invoice_number',
    p_invoice ->> 'title', v_status,
    nullif(p_invoice ->> 'issue_date', '')::date,
    nullif(p_invoice ->> 'due_date', '')::date, nullif(p_invoice ->> 'notes', ''),
    v_issued,
    coalesce((p_invoice ->> 'subtotal_cents')::integer, 0),
    coalesce((p_invoice ->> 'tax_cents')::integer, 0),
    coalesce((p_invoice ->> 'total_cents')::integer, 0),
    coalesce((p_invoice ->> 'balance_due_cents')::integer, 0),
    nullif(p_invoice ->> 'source_type', ''), v_draw_id,
    nullif(p_invoice ->> 'source_change_order_id', '')::uuid,
    nullif(p_invoice ->> 'source_pay_application_id', '')::uuid,
    coalesce(p_invoice -> 'metadata', '{}'::jsonb),
    nullif(p_invoice ->> 'sent_at', '')::timestamptz,
    case when jsonb_typeof(p_invoice -> 'sent_to_emails') = 'array'
      then array(select jsonb_array_elements_text(p_invoice -> 'sent_to_emails'))
      else null end,
    nullif(p_invoice ->> 'product_posture', ''),
    coalesce(nullif(p_invoice ->> 'approval_status', ''), 'not_required'),
    coalesce(nullif(p_invoice ->> 'delivery_status', ''), 'not_sent'),
    p_invoice -> 'issued_snapshot'
  ) returning * into v_invoice;

  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    insert into public.invoice_lines (
      org_id, invoice_id, cost_code_id, description, quantity, unit,
      unit_price_cents, metadata
    ) values (
      p_org_id, v_invoice.id, nullif(v_line ->> 'cost_code_id', '')::uuid,
      coalesce(v_line ->> 'description', ''),
      coalesce((v_line ->> 'quantity')::numeric, 1), v_line ->> 'unit',
      coalesce((v_line ->> 'unit_price_cents')::integer, 0),
      coalesce(v_line -> 'metadata', '{}'::jsonb)
    ) returning id into v_line_id;

    if jsonb_typeof(v_line -> 'metadata' -> 'billable_cost_ids') = 'array' then
      for v_cost_id in
        select value::uuid from jsonb_array_elements_text(v_line -> 'metadata' -> 'billable_cost_ids')
      loop
        update public.billable_costs
        set invoice_id = v_invoice.id, invoice_line_id = v_line_id,
            status = 'billed', billed_at = now()
        where id = v_cost_id and org_id = p_org_id
          and invoice_id is null and status in ('open', 'locked');
        get diagnostics v_claimed = row_count;
        if v_claimed <> 1 then
          raise exception 'An approved cost was already claimed by another invoice';
        end if;
      end loop;
    end if;

    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('id', v_line_id, 'metadata', coalesce(v_line -> 'metadata', '{}'::jsonb))
    );
  end loop;

  if v_draw_id is not null then
    update public.draw_schedules
    set invoice_id = v_invoice.id,
        status = case when status in ('paid', 'partial') then status else 'invoiced' end,
        invoiced_at = coalesce(invoiced_at, now())
    where id = v_draw_id and org_id = p_org_id
      and (invoice_id is null or invoice_id = v_invoice.id);
    get diagnostics v_claimed = row_count;
    if v_claimed <> 1 then
      raise exception 'Selected draw is already linked to another invoice';
    end if;
  end if;

  if v_retainage_cents > 0 and v_contract_id is not null and v_invoice.project_id is not null then
    insert into public.retainage (
      org_id, project_id, contract_id, invoice_id, amount_cents, status
    ) values (
      p_org_id, v_invoice.project_id, v_contract_id, v_invoice.id,
      v_retainage_cents, 'held'
    );
  end if;

  return jsonb_build_object('invoice', to_jsonb(v_invoice), 'lines', v_lines);
end;
$$;

create or replace function public.update_invoice_atomic(
  p_org_id uuid,
  p_invoice_id uuid,
  p_invoice jsonb,
  p_lines jsonb,
  p_expected_updated_at timestamptz default null
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_existing public.invoices%rowtype;
  v_invoice public.invoices%rowtype;
  v_line jsonb;
  v_line_id uuid;
  v_lines jsonb := '[]'::jsonb;
  v_old_draw_id uuid;
  v_new_draw_id uuid := nullif(p_invoice ->> 'source_draw_id', '')::uuid;
  v_claimed integer;
  v_retainage public.retainage%rowtype;
  v_retainage_cents integer := coalesce((p_invoice -> 'metadata' ->> 'retainage_amount_cents')::integer, 0);
  v_contract_id uuid := nullif(p_invoice -> 'metadata' ->> 'source_contract_id', '')::uuid;
  v_issued boolean := coalesce((p_invoice ->> 'client_visible')::boolean, false);
  v_status text;
  v_project_id uuid;
begin
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Invoice requires at least one line';
  end if;
  if auth.uid() is not null and not public.is_org_member(p_org_id) then
    raise exception 'Not authorized for this organization';
  end if;

  select * into v_existing from public.invoices
  where id = p_invoice_id and org_id = p_org_id for update;
  if v_existing.id is null then raise exception 'Invoice not found'; end if;
  if v_existing.sent_at is not null or v_existing.client_visible
    or v_existing.status <> 'draft' then
    raise exception 'Issued invoices are immutable; void and reissue instead';
  end if;
  if p_expected_updated_at is not null and v_existing.updated_at <> p_expected_updated_at then
    raise exception 'Invoice changed in another session; refresh before saving';
  end if;

  -- An edit may not relocate the invoice. The caller was authorized against the
  -- project this invoice is already in; moving it is `move_invoice_to_project`,
  -- which authorizes BOTH sides and releases the source project's links.
  v_project_id := nullif(p_invoice ->> 'project_id', '')::uuid;
  if v_project_id is distinct from v_existing.project_id then
    raise exception 'An invoice edit cannot change its project';
  end if;

  if coalesce(nullif(p_invoice ->> 'status', ''), case when v_issued then 'sent' else 'draft' end)
     not in ('draft', 'sent') then
    raise exception 'An invoice edit cannot set state %', p_invoice ->> 'status';
  end if;
  v_status := case when v_issued then 'sent' else 'draft' end;

  if p_invoice ->> 'product_posture' = 'commercial'
    and v_issued
    and p_invoice ->> 'approval_status' <> 'approved' then
    raise exception 'Commercial owner billing must be approved before issue';
  end if;

  v_old_draw_id := v_existing.source_draw_id;
  if v_old_draw_id is distinct from v_new_draw_id and v_old_draw_id is not null then
    update public.draw_schedules
    set invoice_id = null, status = 'pending', invoiced_at = null
    where id = v_old_draw_id and org_id = p_org_id and invoice_id = p_invoice_id;
  end if;
  if v_new_draw_id is not null then
    update public.draw_schedules
    set invoice_id = p_invoice_id,
        status = case when status in ('paid', 'partial') then status else 'invoiced' end,
        invoiced_at = coalesce(invoiced_at, now())
    where id = v_new_draw_id and org_id = p_org_id
      and (invoice_id is null or invoice_id = p_invoice_id);
    get diagnostics v_claimed = row_count;
    if v_claimed <> 1 then
      raise exception 'Selected draw is already linked to another invoice';
    end if;
  end if;

  update public.invoices set
    token = nullif(p_invoice ->> 'token', ''),
    invoice_number = p_invoice ->> 'invoice_number', title = p_invoice ->> 'title',
    status = v_status,
    issue_date = nullif(p_invoice ->> 'issue_date', '')::date,
    due_date = nullif(p_invoice ->> 'due_date', '')::date,
    notes = nullif(p_invoice ->> 'notes', ''),
    client_visible = v_issued,
    subtotal_cents = coalesce((p_invoice ->> 'subtotal_cents')::integer, 0),
    tax_cents = coalesce((p_invoice ->> 'tax_cents')::integer, 0),
    total_cents = coalesce((p_invoice ->> 'total_cents')::integer, 0),
    balance_due_cents = coalesce((p_invoice ->> 'balance_due_cents')::integer, 0),
    source_type = nullif(p_invoice ->> 'source_type', ''),
    source_draw_id = v_new_draw_id,
    source_change_order_id = nullif(p_invoice ->> 'source_change_order_id', '')::uuid,
    source_pay_application_id = nullif(p_invoice ->> 'source_pay_application_id', '')::uuid,
    metadata = coalesce(p_invoice -> 'metadata', '{}'::jsonb),
    sent_at = nullif(p_invoice ->> 'sent_at', '')::timestamptz,
    sent_to_emails = case when jsonb_typeof(p_invoice -> 'sent_to_emails') = 'array'
      then array(select jsonb_array_elements_text(p_invoice -> 'sent_to_emails'))
      else null end,
    product_posture = nullif(p_invoice ->> 'product_posture', ''),
    approval_status = coalesce(nullif(p_invoice ->> 'approval_status', ''), 'not_required'),
    delivery_status = coalesce(nullif(p_invoice ->> 'delivery_status', ''), 'not_sent'),
    issued_snapshot = p_invoice -> 'issued_snapshot'
  where id = p_invoice_id and org_id = p_org_id
  returning * into v_invoice;

  delete from public.invoice_lines where invoice_id = p_invoice_id and org_id = p_org_id;
  for v_line in select * from jsonb_array_elements(p_lines)
  loop
    insert into public.invoice_lines (
      org_id, invoice_id, cost_code_id, description, quantity, unit,
      unit_price_cents, metadata
    ) values (
      p_org_id, p_invoice_id, nullif(v_line ->> 'cost_code_id', '')::uuid,
      coalesce(v_line ->> 'description', ''),
      coalesce((v_line ->> 'quantity')::numeric, 1), v_line ->> 'unit',
      coalesce((v_line ->> 'unit_price_cents')::integer, 0),
      coalesce(v_line -> 'metadata', '{}'::jsonb)
    ) returning id into v_line_id;
    v_lines := v_lines || jsonb_build_array(
      jsonb_build_object('id', v_line_id, 'metadata', coalesce(v_line -> 'metadata', '{}'::jsonb))
    );
  end loop;

  select * into v_retainage from public.retainage
  where org_id = p_org_id and invoice_id = p_invoice_id for update;
  if v_retainage.id is not null and v_retainage.status = 'paid'
    and (v_retainage_cents <> v_retainage.amount_cents or v_retainage_cents = 0) then
    raise exception 'Paid retainage cannot be changed';
  elsif v_retainage_cents <= 0 or v_contract_id is null or v_invoice.project_id is null then
    delete from public.retainage
    where id = v_retainage.id and status <> 'paid';
  elsif v_retainage.id is not null then
    update public.retainage set
      project_id = v_invoice.project_id, contract_id = v_contract_id,
      amount_cents = v_retainage_cents, updated_at = now()
    where id = v_retainage.id;
  else
    insert into public.retainage (
      org_id, project_id, contract_id, invoice_id, amount_cents, status
    ) values (
      p_org_id, v_invoice.project_id, v_contract_id, p_invoice_id,
      v_retainage_cents, 'held'
    );
  end if;

  return jsonb_build_object('invoice', to_jsonb(v_invoice), 'lines', v_lines);
end;
$$;

-- ── 3. A payment needs something that was actually billed ────────────────────
--
-- The guard was `status = 'void'`, which let a draft — created with
-- balance_due_cents equal to its total — be settled and flipped to `paid`
-- without ever having been issued to anybody.

-- A trigger rather than an edit to each payment RPC: it catches every path into
-- the table (both atomic functions, the QuickBooks importer, any future one) and
-- cannot be forgotten by the next writer. Vendor-bill payments carry no
-- invoice_id and are untouched.

create or replace function public.tg_payments_require_billable_invoice()
returns trigger
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_status text;
begin
  if new.invoice_id is null then
    return new;
  end if;

  select status into v_status from public.invoices
   where id = new.invoice_id and org_id = new.org_id;

  if v_status is null then
    raise exception 'Payment references an invoice that does not exist in this organization';
  end if;
  if v_status = 'void' then
    raise exception 'Cannot apply payment to a void invoice';
  end if;
  if v_status not in ('sent', 'partial', 'paid', 'overdue') then
    raise exception 'Cannot apply payment to an invoice that has not been issued';
  end if;

  return new;
end;
$$;

drop trigger if exists payments_require_billable_invoice on public.payments;
create trigger payments_require_billable_invoice
  before insert on public.payments
  for each row execute function public.tg_payments_require_billable_invoice();

-- ── 4. Money tables: members read, commands write ────────────────────────────

drop policy if exists invoices_access on public.invoices;
create policy invoices_read on public.invoices
  for select
  using (
    (select auth.role()) = 'service_role'
    or (
      public.is_org_member(org_id)
      and (
        project_id is null
        or public.is_project_member(project_id)
        or public.is_org_admin_member(org_id)
      )
    )
  );

drop policy if exists invoice_lines_access on public.invoice_lines;
create policy invoice_lines_read on public.invoice_lines
  for select
  using (
    (select auth.role()) = 'service_role'
    or (
      public.is_org_member(org_id)
      and exists (
        select 1 from public.invoices i
        where i.id = invoice_lines.invoice_id
          and i.org_id = invoice_lines.org_id
          and (
            i.project_id is null
            or public.is_project_member(i.project_id)
            or public.is_org_admin_member(i.org_id)
          )
      )
    )
  );

drop policy if exists payments_access on public.payments;
create policy payments_read on public.payments
  for select
  using (
    (select auth.role()) = 'service_role'
    or (
      public.is_org_member(org_id)
      and (
        project_id is null
        or public.is_project_member(project_id)
        or public.is_org_admin_member(org_id)
      )
    )
  );

drop policy if exists payment_intents_access on public.payment_intents;
create policy payment_intents_read on public.payment_intents
  for select
  using ((select auth.role()) = 'service_role' or public.is_org_member(org_id));

-- Defence in depth: even if a permissive policy is ever re-added by accident,
-- the grant is gone.
revoke insert, update, delete on public.invoices from authenticated;
revoke insert, update, delete on public.invoice_lines from authenticated;
revoke insert, update, delete on public.payments from authenticated;
revoke insert, update, delete on public.payment_intents from authenticated;

grant select on public.invoices to authenticated;
grant select on public.invoice_lines to authenticated;
grant select on public.payments to authenticated;
grant select on public.payment_intents to authenticated;

commit;
