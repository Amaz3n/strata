-- EP05 review fixes: the sales controls hold for every writer.
--
-- contracts, change_orders, closing_checklist_items and vendor_bills still carry
-- their original is_org_member FOR ALL policies, so a signed-in member could
-- write them straight through PostgREST and walk around rules the EP05 services
-- enforce. As in EP04 (20261012170000), every fix below refuses the direct write
-- by a signed-in member (`current_user = 'authenticated'`, in an invoker
-- trigger) while the service-role and definer paths the services use pass.
--
-- 1. Purchase agreements: a member never inserts, deletes, or moves one's
--    status, terms, buyer, snapshot or signature. Creation is
--    create_purchase_agreement_atomic, execution the signing path, cancellation
--    void_purchase_agreement_atomic (all service role).
-- 2. Amendments: a member's approval of a change order that amends a signed
--    agreement is an offline approval only, by a change_order.approve holder in
--    their own name, carrying a real file on the home as the buyer's signed copy.
--    Envelope and portal signatures are recorded by the service. A member never
--    binds a new change order to a purchase agreement.
-- 3. Closing gates: a gate never stops being a gate and is never deleted, so the
--    certificate-of-occupancy evidence rule cannot be stepped around.
-- 4. Commission payables: a member moves a commission bill only with the
--    authority the payables service demands (bill.approve to approve, reject or
--    reopen; payment.release to pay), approvals in their own name, and never
--    touches a commission clawback credit. A commission bill and its lines are
--    read only by whoever may read the commission itself (or approves bills).
-- 5. Commission plans: "no commissions" stands on its own only when no approved
--    plan with lines came before it; replacing approved terms needs a second
--    person. The "terms you cannot see" refusal moves into the database.
-- 6. The closing reversal unwinds commissions in its own transaction: a failed
--    reversal leaves them owed. The Books side (payroll accrual reversals and
--    clawback accruals) is an outbox job, retried until it lands.
-- 7. Website leads: a phone number merges a lead into an open deal only when one
--    side has no email. Two different emails on one phone are two buyers: a new
--    deal, flagged as a possible duplicate of the other.
-- 8. Milestones: a member never writes what a lender or title company reported,
--    and acts in their own name. Rejected feed deliveries count atomically.
-- 9. Warranty: the program's terms are captured on the agreement when it is
--    executed, so closing enrolls the buyer in what was sold.
-- 10. Closings: a member never opens, deletes, settles or moves a closing's
--    status, settlement, invoice or dates; those go through the closing desk's
--    service paths after their readiness, permission and commission checks. A
--    member writes the schedule date and metadata (settlement adjustments) only
--    with closing.manage, and the checklist only with closing.manage, completing
--    an item in their own name.
-- 11. A change order out for e-signature is frozen: its price, lines and
--    signature requirement cannot change until the envelope executes or is
--    voided, and the envelope records the total the buyer is signing, which the
--    approval must match.

-- ---------------------------------------------------------------------------
-- 1. Purchase agreements.
-- ---------------------------------------------------------------------------

create or replace function public.tg_purchase_agreement_member_write_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return coalesce(new, old);
  end if;
  if tg_op = 'INSERT' then
    if new.contract_type = 'purchase_agreement' then
      raise exception 'A purchase agreement is created from its reservation on the sales desk' using errcode = '42501';
    end if;
    return new;
  end if;
  if tg_op = 'DELETE' then
    if old.contract_type = 'purchase_agreement' then
      raise exception 'A purchase agreement is a record; cancel the sale instead' using errcode = '42501';
    end if;
    return old;
  end if;
  if (old.contract_type = 'purchase_agreement' or new.contract_type = 'purchase_agreement')
     and row(new.contract_type, new.org_id, new.project_id, new.status, new.total_cents, new.currency, new.snapshot,
             new.signed_at, new.signature_data, new.buyer_contact_id, new.co_buyer_contact_id, new.warranty_program_id,
             new.warranty_terms_snapshot, new.number, new.title, new.terms, new.effective_date)
         is distinct from
         row(old.contract_type, old.org_id, old.project_id, old.status, old.total_cents, old.currency, old.snapshot,
             old.signed_at, old.signature_data, old.buyer_contact_id, old.co_buyer_contact_id, old.warranty_program_id,
             old.warranty_terms_snapshot, old.number, old.title, old.terms, old.effective_date) then
    raise exception 'A purchase agreement''s number, buyer, terms and status change only through the sales desk: signing executes it, a change order amends it and cancelling the sale voids it'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

-- 9 adds the column the guard reads; it exists before the trigger can fire.
alter table public.contracts add column if not exists warranty_terms_snapshot jsonb;

-- Named to fire after binding_purchase_agreement_pricing, whose message a
-- repricing attempt on a signed agreement keeps.
drop trigger if exists purchase_agreement_member_write_guard on public.contracts;
create trigger purchase_agreement_member_write_guard
  before insert or update or delete on public.contracts
  for each row execute function public.tg_purchase_agreement_member_write_guard();

-- ---------------------------------------------------------------------------
-- 2. Amendments need the buyer's signature, not a metadata flag.
-- ---------------------------------------------------------------------------

create or replace function public.tg_change_order_member_amendment_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_file text;
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if new.contract_id is not null
       and exists (select 1 from public.contracts c where c.id = new.contract_id and c.contract_type = 'purchase_agreement') then
      raise exception 'A change order''s purchase agreement is set when the buyer''s signed approval is recorded' using errcode = '42501';
    end if;
    return new;
  end if;
  -- change_order_agreement_binding (which fires first) bound an approval on a
  -- home under a signed agreement to that agreement.
  if new.status = 'approved' and old.status is distinct from 'approved' and new.contract_id is not null
     and exists (select 1 from public.contracts c where c.id = new.contract_id and c.contract_type = 'purchase_agreement') then
    if not public.has_org_permission(new.org_id, 'change_order.approve') then
      raise exception 'Approving a change order needs change_order.approve' using errcode = '42501';
    end if;
    if new.approved_by is distinct from (select auth.uid()) then
      raise exception 'An approval is recorded in the approver''s own name' using errcode = '42501';
    end if;
    if coalesce(new.metadata->>'approved_via_envelope', '') = 'true'
       or coalesce(new.metadata->>'approved_via_portal_signature', '') = 'true'
       or coalesce(new.metadata->>'approval_method', '') <> 'manual_offline' then
      raise exception 'E-signature and portal approvals are recorded when the buyer signs; approve it here only with the copy the buyer signed'
        using errcode = '42501';
    end if;
    v_file := new.metadata->>'approved_signed_file_id';
    if v_file is null
       or v_file !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
       or not exists (
         select 1 from public.files f
         where f.id = v_file::uuid and f.org_id = new.org_id and f.archived_at is null
           and f.project_id = new.project_id
       ) then
      raise exception 'Attach the copy the buyer signed: it must be a file on this home' using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists change_orders_member_amendment_guard on public.change_orders;
create trigger change_orders_member_amendment_guard
  before insert or update on public.change_orders
  for each row execute function public.tg_change_order_member_amendment_guard();

-- ---------------------------------------------------------------------------
-- 3. Closing gates stay gates.
-- ---------------------------------------------------------------------------

create or replace function public.guard_closing_checklist_required_evidence()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    -- The closing went away and took its checklist with it.
    if pg_trigger_depth() > 1 and not exists (select 1 from public.closings c where c.id = old.closing_id) then
      return old;
    end if;
    if old.is_gate or old.key is not null or old.evidence_required then
      raise exception 'A closing gate is part of the closing''s record; complete it, or waive it with a reason where it allows' using errcode = '42501';
    end if;
    return old;
  end if;
  if tg_op = 'INSERT' and new.key = 'final_inspection_co' then
    new.evidence_required := true;
    new.is_gate := true;
  end if;
  if tg_op = 'UPDATE'
     and (new.key is distinct from old.key
          or new.is_gate is distinct from old.is_gate
          or (old.evidence_required and not new.evidence_required)) then
    raise exception 'A closing gate''s identity and evidence rule are fixed' using errcode = '42501';
  end if;
  if new.evidence_required
     and (tg_op = 'INSERT' or (new.status, new.file_id) is distinct from (old.status, old.file_id)) then
    if new.status = 'waived' then
      raise exception '% cannot be waived; attach its evidence', new.title using errcode = '23514';
    end if;
    if new.status = 'complete' and new.file_id is null then
      raise exception '% needs its evidence file', new.title using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.guard_closing_checklist_required_evidence() from public, anon, authenticated;

drop trigger if exists closing_checklist_required_evidence on public.closing_checklist_items;
create trigger closing_checklist_required_evidence
  before insert or update or delete on public.closing_checklist_items
  for each row execute function public.guard_closing_checklist_required_evidence();

-- ---------------------------------------------------------------------------
-- 4. Commission payables: AP's authority, and the comp stays private.
-- ---------------------------------------------------------------------------

create or replace function public.guard_sales_commission_bill()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if coalesce(current_setting('arc.commission_write', true), '') = 'on' then
    return coalesce(new, old);
  end if;
  if tg_op = 'DELETE' then
    if old.metadata ? 'sales_commission_obligation_id' then
      raise exception 'A commission payable cannot be deleted; reverse the closing instead' using errcode = '42501';
    end if;
    return old;
  end if;
  if not (old.metadata ? 'sales_commission_obligation_id') then
    return new;
  end if;
  if row(new.total_cents, new.company_id, new.project_id, new.bill_number, new.currency, new.retainage_cents, new.bill_date)
       is distinct from row(old.total_cents, old.company_id, old.project_id, old.bill_number, old.currency, old.retainage_cents, old.bill_date)
     or new.metadata->>'sales_commission_obligation_id' is distinct from old.metadata->>'sales_commission_obligation_id'
     or new.metadata->>'source' is distinct from old.metadata->>'source' then
    raise exception 'A commission payable''s amount, payee and home come from the approved terms' using errcode = '42501';
  end if;
  -- Definer functions (approval, payment runs, credit application) and the
  -- service role carry their own checks.
  if current_user <> 'authenticated' then
    return new;
  end if;
  if old.metadata->>'source' = 'vendor_credit' then
    if row(new.status, new.paid_cents, new.paid_at, new.approved_at, new.approved_by, new.rejected_at, new.rejected_by, new.rejection_reason)
       is distinct from row(old.status, old.paid_cents, old.paid_at, old.approved_at, old.approved_by, old.rejected_at, old.rejected_by, old.rejection_reason) then
      raise exception 'A commission clawback credit nets against the payee''s next payment; write it off in Books with a reason' using errcode = '42501';
    end if;
    return new;
  end if;
  if (new.status is distinct from old.status and new.status in ('paid', 'partial'))
     or row(new.paid_cents, new.paid_at) is distinct from row(old.paid_cents, old.paid_at) then
    if not public.has_org_permission(new.org_id, 'payment.release') then
      raise exception 'Paying a commission needs payment.release' using errcode = '42501';
    end if;
  elsif new.status is distinct from old.status
     or row(new.approved_at, new.approved_by, new.rejected_at, new.rejected_by, new.rejection_reason)
        is distinct from row(old.approved_at, old.approved_by, old.rejected_at, old.rejected_by, old.rejection_reason) then
    if not public.has_org_permission(new.org_id, 'bill.approve') then
      raise exception 'Approving or rejecting a commission payable needs bill.approve' using errcode = '42501';
    end if;
  end if;
  if new.approved_by is distinct from old.approved_by and new.approved_by is distinct from (select auth.uid()) then
    raise exception 'An approval is recorded in the approver''s own name' using errcode = '42501';
  end if;
  if new.rejected_by is distinct from old.rejected_by and new.rejected_by is distinct from (select auth.uid()) then
    raise exception 'A rejection is recorded in the rejecter''s own name' using errcode = '42501';
  end if;
  return new;
end;
$$;

revoke all on function public.guard_sales_commission_bill() from public, anon, authenticated;

-- Whether the signed-in member may read the commission behind a payable: the
-- commission's own read policy decides (the payee, sales.commission_approve,
-- payment.release, or co-op terms for sales and AP), and whoever approves
-- payables sees what they approve. Invoker: the obligation read runs under the
-- caller's row security.
create or replace function public.member_reads_sales_commission(p_org_id uuid, p_obligation_id text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select public.has_org_permission(p_org_id, 'bill.approve')
      or exists (select 1 from public.sales_commission_obligations o where o.id::text = p_obligation_id)
$$;

revoke all on function public.member_reads_sales_commission(uuid, text) from public, anon;
grant execute on function public.member_reads_sales_commission(uuid, text) to authenticated, service_role;

drop policy if exists vendor_bills_sales_commission_privacy on public.vendor_bills;
create policy vendor_bills_sales_commission_privacy on public.vendor_bills
  as restrictive
  for select
  to authenticated
  using (
    not (metadata ? 'sales_commission_obligation_id')
    or public.member_reads_sales_commission(org_id, metadata->>'sales_commission_obligation_id')
  );

drop policy if exists bill_lines_sales_commission_privacy on public.bill_lines;
create policy bill_lines_sales_commission_privacy on public.bill_lines
  as restrictive
  for select
  to authenticated
  using (
    not (metadata ? 'sales_commission_obligation_id')
    or public.member_reads_sales_commission(org_id, metadata->>'sales_commission_obligation_id')
  );

-- ---------------------------------------------------------------------------
-- 5. Commission plans: replacing approved terms needs a second person.
-- ---------------------------------------------------------------------------

create or replace function public.guard_sales_commission_plan()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_member boolean := (select auth.role()) is distinct from 'service_role';
  v_lines integer;
  v_second_person boolean;
begin
  if row(new.org_id, new.project_id, new.contract_id, new.revision, new.coop_broker, new.line_count, new.proposed_by, new.proposed_at)
     is distinct from row(old.org_id, old.project_id, old.contract_id, old.revision, old.coop_broker, old.line_count, old.proposed_by, old.proposed_at) then
    raise exception 'Commission terms cannot be edited; revise the plan instead' using errcode = '42501';
  end if;
  if old.status in ('superseded', 'void') then
    raise exception 'This commission plan is final' using errcode = '42501';
  end if;
  if new.status = old.status then
    if row(new.approved_by, new.approved_at, new.approval_note, new.ended_at, new.end_reason)
       is distinct from row(old.approved_by, old.approved_at, old.approval_note, old.ended_at, old.end_reason) then
      raise exception 'A commission decision cannot be edited' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.status = 'approved' then
    if old.status <> 'proposed' then
      raise exception 'Only proposed commission terms can be approved' using errcode = '42501';
    end if;
    -- "No commissions" stands on its own only when it takes nothing away: once
    -- terms with lines were approved, removing them is a decision like any other.
    v_second_person := old.line_count > 0 or exists (
      select 1 from public.sales_commission_plans p
      where p.contract_id = old.contract_id and p.id <> old.id and p.approved_at is not null and p.line_count > 0
    );
    if v_member then
      if new.approved_by is distinct from (select auth.uid()) then
        raise exception 'An approval is recorded in the approver''s own name' using errcode = '42501';
      end if;
      if v_second_person and not public.has_org_permission(new.org_id, 'sales.commission_approve') then
        raise exception 'Approving commission terms needs sales.commission_approve' using errcode = '42501';
      end if;
      if not v_second_person
         and not (public.has_org_permission(new.org_id, 'sales.commission_manage')
                  or public.has_org_permission(new.org_id, 'sales.commission_approve')) then
        raise exception 'Declaring no commissions needs sales.commission_manage' using errcode = '42501';
      end if;
    end if;
    if v_second_person then
      if new.approved_by = old.proposed_by then
        raise exception 'The person who proposed commission terms cannot approve them' using errcode = '42501';
      end if;
      if exists (
        select 1 from public.sales_commission_plan_lines l
        where l.plan_id = old.id and l.payee_user_id = new.approved_by
      ) then
        raise exception 'A payee cannot approve their own commission' using errcode = '42501';
      end if;
    end if;
    select count(*) into v_lines from public.sales_commission_plan_lines where plan_id = old.id;
    if v_lines <> old.line_count then
      raise exception 'The commission plan is incomplete; propose it again' using errcode = '23514';
    end if;
    return new;
  end if;

  if new.status in ('superseded', 'void') then
    -- A member ends a plan only by proposing the next one (which checks every
    -- line is visible to them) or by voiding the agreement.
    if v_member
       and coalesce(current_setting('arc.commission_plan_void', true), '') is distinct from old.contract_id::text
       and coalesce(current_setting('arc.commission_plan_revise', true), '') is distinct from old.contract_id::text then
      raise exception 'Commission terms are revised by proposing new terms' using errcode = '42501';
    end if;
    if exists (select 1 from public.sales_commission_obligations o where o.plan_id = old.id) then
      raise exception 'Commissions were already recorded for this agreement; reverse the closing to adjust them' using errcode = '42501';
    end if;
    if exists (
      select 1 from public.closings c
      where c.org_id = old.org_id and c.project_id = old.project_id and c.status = 'closed'
        and c.settlement->>'contractId' = old.contract_id::text
    ) then
      raise exception 'This home has closed; adjust commissions through the closing reversal' using errcode = '42501';
    end if;
    new.ended_at := coalesce(new.ended_at, now());
    return new;
  end if;

  raise exception 'A commission plan cannot move from % to %', old.status, new.status using errcode = '42501';
end;
$$;

revoke all on function public.guard_sales_commission_plan() from public, anon, authenticated;

-- Runs as the member, under row security: proposing needs
-- sales.commission_manage, and a revision is refused when the live plan holds
-- lines the proposer cannot read (another consultant's comp would be dropped
-- unseen). Supersedes the live plan (refused once the home closed or
-- commissions exist) and writes the next revision with its lines in one
-- transaction. A plan with no lines is the explicit "no commissions"
-- declaration: it stands at once unless approved terms with lines came before
-- it, in which case it waits for a second person like any revision.
create or replace function public.propose_sales_commission_plan(
  p_org_id uuid,
  p_contract_id uuid,
  p_coop_broker text,
  p_lines jsonb,
  p_reason text default null
)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_contract record;
  v_live public.sales_commission_plans%rowtype;
  v_plan_id uuid;
  v_revision integer;
  v_count integer := coalesce(jsonb_array_length(p_lines), 0);
  v_line jsonb;
  v_index integer := 0;
  v_replaces_lines boolean;
begin
  if (select auth.uid()) is null then
    raise exception 'Sign in to propose commission terms' using errcode = '42501';
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' then
    raise exception 'Commission lines must be a list' using errcode = '22023';
  end if;
  if p_coop_broker = 'broker' and not exists (
    select 1 from jsonb_array_elements(p_lines) l where l->>'kind' = 'coop_broker'
  ) then
    raise exception 'Name the co-op broker''s terms, or declare no co-op broker' using errcode = '23514';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('sales_commission_plan:' || p_contract_id::text, 0));

  select id, project_id, status into v_contract
  from public.contracts
  where org_id = p_org_id and id = p_contract_id and contract_type = 'purchase_agreement';
  if v_contract.id is null then
    raise exception 'Purchase agreement not found' using errcode = '23503';
  end if;
  if v_contract.status not in ('draft', 'active') then
    raise exception 'Commission terms are set only on an open purchase agreement' using errcode = '42501';
  end if;

  select * into v_live from public.sales_commission_plans
  where org_id = p_org_id and contract_id = p_contract_id and status in ('proposed', 'approved');
  if v_live.id is not null then
    if (select count(*) from public.sales_commission_plan_lines l where l.plan_id = v_live.id) <> v_live.line_count then
      raise exception 'This plan includes commission terms you cannot see; ask a sales manager to revise it' using errcode = '42501';
    end if;
    perform set_config('arc.commission_plan_revise', p_contract_id::text, true);
    update public.sales_commission_plans
    set status = 'superseded', end_reason = coalesce(nullif(btrim(p_reason), ''), 'Commission terms revised')
    where id = v_live.id;
    perform set_config('arc.commission_plan_revise', '', true);
  end if;

  select exists (
    select 1 from public.sales_commission_plans
    where org_id = p_org_id and contract_id = p_contract_id and approved_at is not null and line_count > 0
  ) into v_replaces_lines;

  select coalesce(max(revision), 0) + 1 into v_revision
  from public.sales_commission_plans where org_id = p_org_id and contract_id = p_contract_id;

  insert into public.sales_commission_plans (org_id, project_id, contract_id, revision, status, coop_broker, line_count, proposed_by)
  values (p_org_id, v_contract.project_id, p_contract_id, v_revision, 'proposed', p_coop_broker, v_count, (select auth.uid()))
  returning id into v_plan_id;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_index := v_index + 1;
    insert into public.sales_commission_plan_lines (
      org_id, plan_id, project_id, line_no, kind, payout_channel, payee_company_id, payee_user_id,
      agent_name, basis, rate_bps, flat_cents
    ) values (
      p_org_id, v_plan_id, v_contract.project_id, v_index, v_line->>'kind', v_line->>'payout_channel',
      nullif(v_line->>'payee_company_id', '')::uuid, nullif(v_line->>'payee_user_id', '')::uuid,
      nullif(btrim(v_line->>'agent_name'), ''), v_line->>'basis',
      nullif(v_line->>'rate_bps', '')::integer, nullif(v_line->>'flat_cents', '')::bigint
    );
  end loop;

  if v_count = 0 and not v_replaces_lines then
    update public.sales_commission_plans
    set status = 'approved', approved_by = (select auth.uid()), approved_at = now(), approval_note = 'No commissions on this sale'
    where id = v_plan_id;
  end if;
  return v_plan_id;
end;
$$;

revoke all on function public.propose_sales_commission_plan(uuid, uuid, text, jsonb, text) from public, anon;
grant execute on function public.propose_sales_commission_plan(uuid, uuid, text, jsonb, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 6. The closing reversal unwinds commissions in its own transaction.
-- ---------------------------------------------------------------------------

-- 20261007235500's reversal, with the closing's open commissions unwound
-- (unwind_sales_commission) after the money checks and before the home goes
-- back to inventory. A commission bill in a payment run refuses the whole
-- reversal. The payroll side's Books entries are queued for
-- settle_sales_commission_unwind_books, which retries until they land.
create or replace function public.reverse_books_home_closing(p_org_id uuid, p_closing_id uuid, p_date date, p_reason text, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_closing public.closings%rowtype; v_invoice public.invoices%rowtype; v_settings public.project_financial_settings%rowtype;
  v_cogs uuid; v_reserve uuid; v_expense uuid; v_policy integer; v_lines jsonb := '[]'::jsonb; v_line integer := 0; v_row record; v_inventory uuid; v_warranty uuid; v_reserve_cents bigint; v_revision integer;
  v_obligation record; v_commissions jsonb := '[]'::jsonb;
begin
  select * into v_closing from public.closings where id = p_closing_id and org_id = p_org_id for update;
  if not found then raise exception 'Closing not found'; end if;
  if v_closing.status <> 'closed' then raise exception 'Only a recorded closing can be reversed'; end if;
  if p_actor_id is null or length(trim(coalesce(p_reason, ''))) < 10 then raise exception 'Say why the closing is reversed'; end if;
  if exists(select 1 from public.accounting_periods where org_id = p_org_id and status = 'closed' and p_date between period_start and period_end) then
    raise exception 'The reversal date is in a closed month; date it in an open month';
  end if;
  select * into v_invoice from public.invoices where id = v_closing.closing_invoice_id and org_id = p_org_id for update;
  if not found then raise exception 'Closing invoice not found'; end if;
  -- The money comes off first: nothing still owed, nothing still collected, and the sale credited in full.
  if coalesce(v_invoice.balance_due_cents, 0) <> 0
    or coalesce((select sum(a.amount_cents) from public.receivable_adjustments a where a.org_id = p_org_id and a.invoice_id = v_invoice.id and a.adjustment_type = 'credit_memo' and a.status = 'posted'), 0) <> v_invoice.total_cents then
    raise exception 'Refund the closing payment, reverse the deposit applications and credit the sale in full before reversing the closing';
  end if;
  -- Commissions come back with the sale: cleared where nothing was paid, clawed back where it was.
  for v_obligation in
    select o.id, o.payout_channel from public.sales_commission_obligations o
    where o.org_id = p_org_id and o.closing_id = v_closing.id and o.adjusts_obligation_id is null and o.status = 'open'
    order by o.line_no
  loop
    v_commissions := v_commissions || jsonb_build_array(
      public.unwind_sales_commission(p_org_id, v_obligation.id, p_actor_id, trim(p_reason), p_date)
        || jsonb_build_object('obligation_id', v_obligation.id, 'payout_channel', v_obligation.payout_channel));
  end loop;
  if exists (select 1 from jsonb_array_elements(v_commissions) c where c->>'payout_channel' = 'payroll') then
    insert into public.outbox (org_id, job_type, payload, dedupe_key)
    values (p_org_id, 'settle_sales_commission_unwind_books', jsonb_build_object('closing_id', v_closing.id),
            'sales-commission-unwind-books:' || v_closing.id::text)
    on conflict (org_id, dedupe_key) where status = 'pending' and dedupe_key is not null do update
      set run_at = now(), last_error = null, updated_at = now();
  end if;
  select * into v_settings from public.project_financial_settings where org_id = p_org_id and project_id = v_closing.project_id for update;
  select active_policy_version into v_policy from public.books_settings where org_id = p_org_id;
  select id into v_cogs from public.gl_accounts where org_id = p_org_id and code = '5000' and active;
  -- Inventory back, component by component: the exact negative of every relief.
  if v_settings.books_inventory_sold_on is not null then
    for v_row in
      select l.account_id, coalesce(l.dimensions->>'cost_component', 'construction') as component, sum(l.debit_cents - l.credit_cents)::bigint as cents
      from public.journal_lines l join public.journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
      where l.org_id = p_org_id and l.project_id = v_closing.project_id and e.status in ('posted','reversed')
        and (e.source_type = 'inventory_sale_relief' or exists(select 1 from public.journal_entries o where o.id = e.reversal_of_entry_id and o.source_type = 'inventory_sale_relief'))
      group by 1, 2 having sum(l.debit_cents - l.credit_cents) <> 0 order by 2, 1
    loop
      v_line := v_line + 1;
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('line_no', v_line, 'account_id', v_row.account_id, 'project_id', v_closing.project_id,
        'debit_cents', greatest(-v_row.cents, 0), 'credit_cents', greatest(v_row.cents, 0),
        'dimensions', jsonb_build_object('inventory_transition', 'sale_reversal', 'closing_id', v_closing.id) || case when v_row.account_id = v_cogs then jsonb_build_object('cost_component', v_row.component) else '{}'::jsonb end));
    end loop;
    if jsonb_array_length(v_lines) > 0 then
      select count(*) + 1 into v_revision from public.journal_entries where org_id = p_org_id and source_type = 'inventory_sale_relief' and source_id = v_closing.project_id;
      v_inventory := public.post_books_journal_entry(p_org_id, jsonb_build_object('entry_date', p_date, 'entry_kind', 'adjusting', 'memo', 'Closing reversed: home returned to inventory',
        'posting_key', 'inventory:' || v_closing.project_id || ':sale_reversal:' || v_revision, 'projection_version', 1, 'policy_version', v_policy,
        'source_type', 'inventory_sale_relief', 'source_id', v_closing.project_id, 'created_by', p_actor_id), v_lines);
    end if;
    update public.project_financial_settings set books_inventory_sold_on = null, updated_at = now() where org_id = p_org_id and project_id = v_closing.project_id;
  end if;
  -- The warranty provision made at closing is withdrawn (what remains of it).
  select id into v_reserve from public.gl_accounts where org_id = p_org_id and code = '2260' and active;
  select id into v_expense from public.gl_accounts where org_id = p_org_id and code = '5050' and active;
  select coalesce(sum(l.credit_cents - l.debit_cents), 0) into v_reserve_cents from public.journal_lines l join public.journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
    where l.org_id = p_org_id and l.project_id = v_closing.project_id and l.account_id = v_reserve and e.status in ('posted','reversed');
  if v_reserve_cents <> 0 then
    select count(*) + 1 into v_revision from public.journal_entries where org_id = p_org_id and source_type = 'warranty_reserve' and source_id = v_closing.project_id;
    v_warranty := public.post_books_journal_entry(p_org_id, jsonb_build_object('entry_date', p_date, 'entry_kind', 'adjusting', 'memo', 'Closing reversed: warranty provision withdrawn',
      'posting_key', 'warranty_reserve:' || v_closing.project_id || ':' || v_revision, 'projection_version', 1, 'policy_version', v_policy,
      'source_type', 'warranty_reserve', 'source_id', v_closing.project_id, 'created_by', p_actor_id),
      jsonb_build_array(
        jsonb_build_object('line_no', 1, 'account_id', v_reserve, 'project_id', v_closing.project_id, 'debit_cents', greatest(v_reserve_cents, 0), 'credit_cents', greatest(-v_reserve_cents, 0), 'dimensions', jsonb_build_object('warranty_reserve_adjustment', true, 'closing_id', v_closing.id)),
        jsonb_build_object('line_no', 2, 'account_id', v_expense, 'project_id', v_closing.project_id, 'debit_cents', greatest(-v_reserve_cents, 0), 'credit_cents', greatest(v_reserve_cents, 0), 'dimensions', jsonb_build_object('warranty_reserve_adjustment', true, 'closing_id', v_closing.id))));
  end if;
  update public.project_financial_settings set books_warranty_provisioned_on = null, updated_at = now() where org_id = p_org_id and project_id = v_closing.project_id;
  update public.lots set status = 'started', updated_at = now() where org_id = p_org_id and id = v_closing.lot_id and status = 'closed';
  perform set_config('arc.closing_reversal', v_closing.id::text, true);
  update public.closings set status = 'cancelled', cancel_reason = trim(p_reason),
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object('reversed_at', now(), 'reversed_by', p_actor_id, 'reversed_on', p_date, 'reversal_inventory_entry_id', v_inventory, 'reversal_warranty_entry_id', v_warranty)
    where id = v_closing.id;
  perform set_config('arc.closing_reversal', '', true);
  return jsonb_build_object('closingId', v_closing.id, 'projectId', v_closing.project_id, 'inventoryEntryId', v_inventory, 'warrantyEntryId', v_warranty,
    'commissions', v_commissions);
end;
$$;
revoke all on function public.reverse_books_home_closing(uuid,uuid,date,text,uuid) from public, anon, authenticated;
grant execute on function public.reverse_books_home_closing(uuid,uuid,date,text,uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 7. Website leads: a phone alone never merges two people with two emails.
-- ---------------------------------------------------------------------------

alter table public.lead_intake_receipts add column if not exists possible_duplicate_prospect_id uuid;
alter table public.lead_intake_receipts drop constraint if exists lead_intake_receipts_possible_duplicate_fkey;
alter table public.lead_intake_receipts add constraint lead_intake_receipts_possible_duplicate_fkey
  foreign key (org_id, possible_duplicate_prospect_id) references public.prospects(org_id, id) on delete set null (possible_duplicate_prospect_id);
create index if not exists lead_intake_receipts_possible_duplicate_idx
  on public.lead_intake_receipts (org_id, possible_duplicate_prospect_id) where possible_duplicate_prospect_id is not null;

comment on column public.lead_intake_receipts.possible_duplicate_prospect_id is
  'An open deal whose buyer has the same phone but a different email. The lead was filed as its own deal; an operator decides (resolved_at marks the review).';

-- The buyer behind a phone match is the same person only when one side has no
-- email to tell them apart. Twin of phoneMatchIsSameBuyer in lib/sales/lead-identity.ts.
create or replace function public.file_lead(p_org_id uuid, p_receipt_id uuid, p_lead jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text := public.arc_normalize_email(p_lead->>'email');
  v_phone text := public.arc_normalize_phone(p_lead->>'phone');
  v_community uuid := nullif(p_lead->>'community_id', '')::uuid;
  v_routed_owner uuid := nullif(p_lead->>'owner_user_id', '')::uuid;
  v_actor uuid := nullif(p_lead->>'created_by', '')::uuid;
  v_contact uuid := nullif(p_lead->>'contact_id', '')::uuid;
  v_receipt public.lead_intake_receipts%rowtype;
  v_prospect uuid;
  v_matched_by text;
  v_prior uuid;
  v_duplicate uuid;
  v_candidate uuid;
  v_candidate_email text;
  v_existing_owner uuid;
  v_owner uuid;
  v_outcome text;
  v_routing_outcome text := p_lead->>'routing_outcome';
  v_rotation uuid[] := array(
    select value::uuid from jsonb_array_elements_text(
      case when jsonb_typeof(p_lead->'round_robin_user_ids') = 'array' then p_lead->'round_robin_user_ids' else '[]'::jsonb end
    )
  );
  v_touch integer;
begin
  if p_receipt_id is not null then
    select * into v_receipt from public.lead_intake_receipts
      where id = p_receipt_id and org_id = p_org_id for update;
    if not found then raise exception 'Lead receipt not found' using errcode = 'P0002'; end if;
    if v_receipt.status in ('filed', 'merged') then
      return jsonb_build_object('prospect_id', v_receipt.prospect_id, 'outcome', v_receipt.status,
        'matched_by', v_receipt.matched_by, 'prior_prospect_id', v_receipt.prior_prospect_id,
        'possible_duplicate_prospect_id', v_receipt.possible_duplicate_prospect_id,
        'owner_user_id', v_receipt.owner_user_id, 'replayed', true);
    end if;
    if v_receipt.status in ('rejected', 'dismissed') then
      raise exception 'This delivery was % and cannot be filed', v_receipt.status using errcode = '22023';
    end if;
    if v_email is null and v_phone is null then
      raise exception 'A website lead needs an email or a phone number' using errcode = '22023';
    end if;
  end if;

  if length(btrim(coalesce(p_lead->>'name', ''))) = 0 then
    raise exception 'A lead needs a name' using errcode = '22023';
  end if;
  if v_community is not null and not exists (
    select 1 from public.communities where id = v_community and org_id = p_org_id and archived_at is null
  ) then
    raise exception 'Community not found' using errcode = '22023';
  end if;
  if v_routed_owner is not null and not exists (
    select 1 from public.memberships where org_id = p_org_id and user_id = v_routed_owner and status = 'active'
  ) then
    raise exception 'Choose an active team member' using errcode = '22023';
  end if;
  if v_contact is not null and not exists (
    select 1 from public.contacts where id = v_contact and org_id = p_org_id and archived_at is null
  ) then
    raise exception 'Contact not found' using errcode = '22023';
  end if;

  -- Two deliveries for the same person file one after the other. Email before
  -- phone, one lock each, so the order is the same in every transaction.
  if v_email is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':lead-email:' || v_email, 0));
  end if;
  if v_phone is not null then
    perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':lead-phone:' || v_phone, 0));
  end if;

  -- The community rotation takes its turn under the community's lock (always
  -- the last lock taken, so the order never inverts): two leads routed at the
  -- same moment read the same "least recently handed a lead", and the second
  -- must see the first's new deal before it picks.
  if v_routing_outcome = 'community_assignee' and v_community is not null and cardinality(v_rotation) > 0 then
    if v_routed_owner is null or not v_routed_owner = any (v_rotation) then
      raise exception 'The routed owner is not in the community rotation' using errcode = '22023';
    end if;
    perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':lead-rotation:' || v_community::text, 0));
    select pool.user_id into v_routed_owner
      from unnest(v_rotation) as pool(user_id)
      order by (
        select max(p.created_at) from public.prospects p
        where p.org_id = p_org_id and p.community_id = v_community and p.owner_user_id = pool.user_id
      ) asc nulls first, pool.user_id::text
      limit 1;
  end if;

  -- The buyer is the primary contact; a co-op agent's address on another deal is
  -- not this buyer. Only an open deal takes the merge: a won or lost buyer who
  -- comes back is a new deal, flagged as returning. A phone match is the same
  -- buyer only when one side has no email; two emails on one phone (an agent's
  -- line, a shared office number) are two buyers, and the new deal is flagged
  -- as a possible duplicate instead.
  if v_email is not null then
    select p.id into v_prospect from public.prospect_contacts pc
      join public.prospects p on p.id = pc.prospect_id and p.org_id = pc.org_id
      where pc.org_id = p_org_id and pc.is_primary and pc.email_normalized = v_email
        and p.status not in ('won', 'lost')
      order by p.created_at, p.id limit 1;
    if v_prospect is not null then v_matched_by := 'email'; end if;
  end if;
  if v_prospect is null and v_phone is not null then
    select p.id, pc.email_normalized into v_candidate, v_candidate_email from public.prospect_contacts pc
      join public.prospects p on p.id = pc.prospect_id and p.org_id = pc.org_id
      where pc.org_id = p_org_id and pc.is_primary and pc.phone_normalized = v_phone
        and p.status not in ('won', 'lost')
      order by (v_email is null or pc.email_normalized is null) desc, p.created_at, p.id limit 1;
    if v_candidate is not null then
      if v_email is null or v_candidate_email is null then
        v_prospect := v_candidate;
        v_matched_by := 'phone';
      else
        v_duplicate := v_candidate;
      end if;
    end if;
  end if;

  if v_prospect is not null then
    select owner_user_id into v_existing_owner from public.prospects where id = v_prospect for update;
    v_owner := coalesce(v_existing_owner, v_routed_owner);
    if v_existing_owner is not null then
      v_routing_outcome := 'existing_owner';
    elsif v_owner is not null then
      update public.prospects set owner_user_id = v_owner, updated_at = now() where id = v_prospect;
    end if;
    -- The second submission may carry what the first did not.
    update public.prospect_contacts set
      email = coalesce(email, nullif(btrim(p_lead->>'email'), '')),
      phone = coalesce(phone, nullif(btrim(p_lead->>'phone'), '')),
      updated_at = now()
    where prospect_id = v_prospect and is_primary
      and ((email is null and v_email is not null) or (phone is null and v_phone is not null));
    v_outcome := 'merged';
  else
    if v_email is not null then
      select p.id into v_prior from public.prospect_contacts pc
        join public.prospects p on p.id = pc.prospect_id and p.org_id = pc.org_id
        where pc.org_id = p_org_id and pc.is_primary and pc.email_normalized = v_email and p.status in ('won', 'lost')
        order by coalesce(p.won_at, p.lost_at) desc nulls last, p.id limit 1;
    end if;
    if v_prior is null and v_phone is not null then
      select p.id into v_prior from public.prospect_contacts pc
        join public.prospects p on p.id = pc.prospect_id and p.org_id = pc.org_id
        where pc.org_id = p_org_id and pc.is_primary and pc.phone_normalized = v_phone and p.status in ('won', 'lost')
          and (v_email is null or pc.email_normalized is null)
        order by coalesce(p.won_at, p.lost_at) desc nulls last, p.id limit 1;
    end if;

    v_owner := v_routed_owner;
    insert into public.prospects (
      org_id, name, status, owner_user_id, community_id, source, project_type, budget_range,
      timeline_preference, notes, created_by
    ) values (
      p_org_id, btrim(p_lead->>'name'), 'new', v_owner, v_community, nullif(btrim(p_lead->>'source'), ''),
      nullif(btrim(p_lead->>'project_type'), ''), nullif(btrim(p_lead->>'budget_range'), ''),
      nullif(btrim(p_lead->>'timeline_preference'), ''), nullif(btrim(p_lead->>'notes'), ''), v_actor
    ) returning id into v_prospect;

    insert into public.prospect_contacts (org_id, prospect_id, contact_id, full_name, email, phone, is_primary)
    values (
      p_org_id, v_prospect, v_contact, btrim(p_lead->>'name'),
      nullif(btrim(p_lead->>'email'), ''), nullif(btrim(p_lead->>'phone'), ''), true
    );

    if v_community is not null and p_lead->>'traffic_bucket' in ('walk_ins', 'appointments', 'web_inquiries') then
      insert into public.community_traffic (org_id, community_id, logged_date, walk_ins, appointments, web_inquiries, recorded_by)
      values (
        p_org_id, v_community, coalesce(nullif(p_lead->>'occurred_on', '')::date, current_date),
        (p_lead->>'traffic_bucket' = 'walk_ins')::int, (p_lead->>'traffic_bucket' = 'appointments')::int,
        (p_lead->>'traffic_bucket' = 'web_inquiries')::int, v_actor
      )
      on conflict (community_id, logged_date) do update set
        walk_ins = public.community_traffic.walk_ins + excluded.walk_ins,
        appointments = public.community_traffic.appointments + excluded.appointments,
        web_inquiries = public.community_traffic.web_inquiries + excluded.web_inquiries,
        updated_at = now();
    end if;
    v_outcome := 'filed';
  end if;

  select coalesce(max(touch), 0) + 1 into v_touch from public.prospect_attributions where prospect_id = v_prospect;
  insert into public.prospect_attributions (
    org_id, prospect_id, receipt_id, touch, channel, source_label, utm_source, utm_medium, utm_campaign,
    utm_term, utm_content, click_ids, referrer_url, landing_url, community_id, occurred_at, created_by
  ) values (
    p_org_id, v_prospect, p_receipt_id, v_touch, coalesce(p_lead->>'channel', 'web'),
    nullif(btrim(p_lead->>'source_label'), ''), nullif(btrim(p_lead->>'utm_source'), ''),
    nullif(btrim(p_lead->>'utm_medium'), ''), nullif(btrim(p_lead->>'utm_campaign'), ''),
    nullif(btrim(p_lead->>'utm_term'), ''), nullif(btrim(p_lead->>'utm_content'), ''),
    coalesce(p_lead->'click_ids', '{}'::jsonb), nullif(btrim(p_lead->>'referrer_url'), ''),
    nullif(btrim(p_lead->>'landing_url'), ''), v_community,
    coalesce(nullif(p_lead->>'occurred_at', '')::timestamptz, now()), v_actor
  );

  if p_receipt_id is not null then
    update public.lead_intake_receipts set
      status = v_outcome, prospect_id = v_prospect, matched_by = v_matched_by, prior_prospect_id = v_prior,
      possible_duplicate_prospect_id = v_duplicate,
      owner_user_id = v_owner, routing_outcome = v_routing_outcome, routing_reason = p_lead->>'routing_reason',
      community_id = coalesce(v_community, community_id), failure_code = null, last_error = null,
      next_attempt_at = null, attempts = attempts + 1, filed_at = now()
    where id = p_receipt_id;
  end if;

  return jsonb_build_object('prospect_id', v_prospect, 'outcome', v_outcome, 'matched_by', v_matched_by,
    'prior_prospect_id', v_prior, 'possible_duplicate_prospect_id', v_duplicate, 'owner_user_id', v_owner,
    'routing_outcome', v_routing_outcome, 'touch', v_touch, 'replayed', false);
end
$$;

revoke all on function public.file_lead(uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function public.file_lead(uuid, uuid, jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 8. Milestones: what a lender reported is the feed's alone.
-- ---------------------------------------------------------------------------

create or replace function public.tg_agreement_milestone_member_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return new;
  end if;
  if tg_op = 'INSERT' then
    if row(new.reported_status, new.reported_on, new.reported_at, new.reported_delivery_id, new.reported_reference) is distinct from row(null::text, null::date, null::timestamptz, null::uuid, null::text) then
      raise exception 'What a lender or title company reported arrives only through the signed feed' using errcode = '42501';
    end if;
    new.created_by := (select auth.uid());
    new.updated_by := (select auth.uid());
    new.resolved_by := case when new.status = 'open' then null else (select auth.uid()) end;
    return new;
  end if;
  -- A reminder marker is bookkeeping, written by the service.
  if (to_jsonb(new) - 'metadata' - 'updated_at') = (to_jsonb(old) - 'metadata' - 'updated_at') then
    return new;
  end if;
  if row(new.reported_status, new.reported_on, new.reported_at, new.reported_delivery_id, new.reported_reference)
     is distinct from row(old.reported_status, old.reported_on, old.reported_at, old.reported_delivery_id, old.reported_reference) then
    raise exception 'What a lender or title company reported arrives only through the signed feed' using errcode = '42501';
  end if;
  new.updated_by := (select auth.uid());
  if new.status is distinct from old.status then
    new.resolved_by := case when new.status = 'open' then null else (select auth.uid()) end;
  elsif new.resolved_by is distinct from old.resolved_by then
    raise exception 'Who resolved a milestone is recorded when it is resolved' using errcode = '42501';
  end if;
  return new;
end;
$$;

drop trigger if exists agreement_milestones_member_guard on public.agreement_milestones;
create trigger agreement_milestones_member_guard
  before insert or update on public.agreement_milestones
  for each row execute function public.tg_agreement_milestone_member_guard();

-- An unsigned or badly signed delivery, counted in one statement so a burst
-- never under-counts.
create or replace function public.record_agreement_milestone_rejection(p_source_id uuid, p_reason text, p_at timestamptz)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.agreement_milestone_sources set
    rejected_count = rejected_count + 1,
    last_rejected_at = greatest(coalesce(last_rejected_at, p_at), p_at),
    last_rejection_reason = p_reason
  where id = p_source_id;
  if not found then raise exception 'Milestone feed not found' using errcode = 'P0002'; end if;
end
$$;

revoke all on function public.record_agreement_milestone_rejection(uuid, text, timestamptz) from public, anon, authenticated;
grant execute on function public.record_agreement_milestone_rejection(uuid, text, timestamptz) to service_role;

-- ---------------------------------------------------------------------------
-- 9. Warranty terms are what the agreement sold.
-- ---------------------------------------------------------------------------

comment on column public.contracts.warranty_terms_snapshot is
  'The bound warranty program''s coverage terms (key, label, duration_months, is_structural, description) captured when the purchase agreement was executed. Closing enrolls the home on these, not on the program as later edited.';

create or replace function public.warranty_program_terms_snapshot(p_org_id uuid, p_program_id uuid)
returns jsonb
language sql
stable
set search_path = ''
as $$
  select jsonb_agg(jsonb_build_object('key', t.key, 'label', t.label, 'duration_months', t.duration_months,
           'is_structural', t.is_structural, 'description', t.description) order by t.sort_order, t.key)
  from public.warranty_coverage_terms t
  where t.org_id = p_org_id and t.program_id = p_program_id
$$;

revoke all on function public.warranty_program_terms_snapshot(uuid, uuid) from public, anon, authenticated;

create or replace function public.tg_contract_bind_warranty_program()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE' and old.warranty_program_id is not null
     and new.warranty_program_id is distinct from old.warranty_program_id then
    raise exception 'The warranty program an agreement sold cannot change' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' and old.warranty_terms_snapshot is not null
     and new.warranty_terms_snapshot is distinct from old.warranty_terms_snapshot then
    raise exception 'The warranty terms an agreement sold cannot change' using errcode = '42501';
  end if;
  if new.contract_type = 'purchase_agreement' and new.status = 'active' then
    if new.warranty_program_id is null then
      select p.id into new.warranty_program_id
      from public.warranty_programs p
      where p.org_id = new.org_id and p.is_default and p.is_active
      order by p.id
      limit 1;
    end if;
    if new.warranty_program_id is not null and new.warranty_terms_snapshot is null then
      new.warranty_terms_snapshot := public.warranty_program_terms_snapshot(new.org_id, new.warranty_program_id);
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.tg_contract_bind_warranty_program() from public, anon, authenticated;

drop trigger if exists contracts_bind_warranty_program on public.contracts;
create trigger contracts_bind_warranty_program
  before insert or update of status, warranty_program_id, warranty_terms_snapshot on public.contracts
  for each row execute function public.tg_contract_bind_warranty_program();

-- Agreements executed before the terms were captured take their program's
-- terms as they stand today: the nearest record of what was sold. A home that
-- already closed keeps the coverage it enrolled on.
update public.contracts c
   set warranty_terms_snapshot = public.warranty_program_terms_snapshot(c.org_id, c.warranty_program_id)
 where c.contract_type = 'purchase_agreement' and c.status = 'active'
   and c.warranty_program_id is not null and c.warranty_terms_snapshot is null;

-- ---------------------------------------------------------------------------
-- 10. Closings move through the closing desk.
-- ---------------------------------------------------------------------------

create or replace function public.tg_closing_member_write_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return coalesce(new, old);
  end if;
  if tg_op = 'INSERT' then
    raise exception 'A closing is opened when the purchase agreement is executed' using errcode = '42501';
  end if;
  if tg_op = 'DELETE' then
    raise exception 'A closing is a record; cancel the sale or reverse the closing instead' using errcode = '42501';
  end if;
  if row(new.org_id, new.project_id, new.lot_id, new.community_id, new.status, new.actual_date, new.settlement,
         new.closing_invoice_id, new.cancel_reason, new.buyer_contact_id)
     is distinct from
     row(old.org_id, old.project_id, old.lot_id, old.community_id, old.status, old.actual_date, old.settlement,
         old.closing_invoice_id, old.cancel_reason, old.buyer_contact_id) then
    raise exception 'A closing''s status, settlement and dates move only through the closing desk' using errcode = '42501';
  end if;
  if row(new.scheduled_date, new.metadata) is distinct from row(old.scheduled_date, old.metadata)
     and not public.has_org_permission(new.org_id, 'closing.manage') then
    raise exception 'Changing a closing needs closing.manage' using errcode = '42501';
  end if;
  return new;
end;
$$;

-- Named to fire before the settlement-evidence and milestone guards, so a
-- member hears why the write is theirs to make or not.
drop trigger if exists closing_access_member_guard on public.closings;
create trigger closing_access_member_guard
  before insert or update or delete on public.closings
  for each row execute function public.tg_closing_member_write_guard();

create or replace function public.tg_closing_checklist_member_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if current_user <> 'authenticated' then
    return coalesce(new, old);
  end if;
  if not public.has_org_permission(coalesce(new.org_id, old.org_id), 'closing.manage') then
    raise exception 'Changing the closing checklist needs closing.manage' using errcode = '42501';
  end if;
  if tg_op <> 'DELETE' and new.status <> 'open'
     and (tg_op = 'INSERT' or row(new.status, new.file_id, new.notes, new.completed_by, new.completed_at)
                              is distinct from row(old.status, old.file_id, old.notes, old.completed_by, old.completed_at))
     and new.completed_by is distinct from (select auth.uid()) then
    raise exception 'A closing gate is completed in the completer''s own name' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

drop trigger if exists closing_checklist_member_guard on public.closing_checklist_items;
create trigger closing_checklist_member_guard
  before insert or update or delete on public.closing_checklist_items
  for each row execute function public.tg_closing_checklist_member_guard();

-- ---------------------------------------------------------------------------
-- 11. A change order out for e-signature is what the buyer is signing.
-- ---------------------------------------------------------------------------

-- The live (sent, partly signed) envelope a change order is out on, if any:
-- linked by the envelope's source, or by its document's source or metadata.
create or replace function public.change_order_signing_envelope(p_change_order_id uuid)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.id
  from public.envelopes e
  left join public.documents d on d.id = e.document_id and d.org_id = e.org_id
  where e.status in ('sent', 'partially_signed')
    and ((e.source_entity_type = 'change_order' and e.source_entity_id = p_change_order_id)
         or (d.source_entity_type = 'change_order' and d.source_entity_id = p_change_order_id)
         or d.metadata->>'change_order_id' = p_change_order_id::text)
  order by e.sent_at desc nulls last, e.id
  limit 1
$$;

revoke all on function public.change_order_signing_envelope(uuid) from public, anon, authenticated;
grant execute on function public.change_order_signing_envelope(uuid) to service_role;

-- The change order an envelope carries, for the envelope's own trigger.
create or replace function public.envelope_change_order_id(p_envelope public.envelopes)
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    case when p_envelope.source_entity_type = 'change_order' then p_envelope.source_entity_id end,
    (select case when d.source_entity_type = 'change_order' then d.source_entity_id
                 when d.metadata->>'change_order_id' ~ '^[0-9a-fA-F-]{36}$' then (d.metadata->>'change_order_id')::uuid end
     from public.documents d where d.id = p_envelope.document_id and d.org_id = p_envelope.org_id))
$$;

revoke all on function public.envelope_change_order_id(public.envelopes) from public, anon, authenticated;

-- Sending records the total on the document the buyer is asked to sign.
create or replace function public.tg_envelope_change_order_terms()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_change_order uuid := public.envelope_change_order_id(new);
  v_total bigint;
begin
  if v_change_order is null then
    return new;
  end if;
  select total_cents into v_total from public.change_orders where id = v_change_order and org_id = new.org_id;
  new.metadata := coalesce(new.metadata, '{}'::jsonb)
    || jsonb_build_object('change_order_id', v_change_order, 'change_order_total_cents', coalesce(v_total, 0));
  return new;
end;
$$;

revoke all on function public.tg_envelope_change_order_terms() from public, anon, authenticated;

drop trigger if exists envelopes_change_order_terms on public.envelopes;
create trigger envelopes_change_order_terms
  before update of status on public.envelopes
  for each row
  when (new.status = 'sent' and old.status is distinct from 'sent' and old.status = 'draft')
  execute function public.tg_envelope_change_order_terms();

create or replace function public.tg_change_order_signature_freeze()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_envelope uuid;
  v_signed_total text;
begin
  if row(new.total_cents, new.requires_signature, new.project_id, new.title, new.summary, new.description, new.days_impact, new.currency)
     is distinct from
     row(old.total_cents, old.requires_signature, old.project_id, old.title, old.summary, old.description, old.days_impact, old.currency) then
    v_envelope := public.change_order_signing_envelope(old.id);
    if v_envelope is not null then
      raise exception 'This change order is out for signature; void the envelope before changing what the buyer is signing' using errcode = '42501';
    end if;
  end if;
  -- An e-signed approval is the amount on the signed document.
  if new.status = 'approved' and old.status is distinct from 'approved'
     and coalesce(new.metadata->>'approved_envelope_id', '') ~ '^[0-9a-fA-F-]{36}$' then
    select e.metadata->>'change_order_total_cents' into v_signed_total
    from public.envelopes e where e.id = (new.metadata->>'approved_envelope_id')::uuid and e.org_id = new.org_id;
    if v_signed_total is not null and v_signed_total::bigint is distinct from new.total_cents then
      raise exception 'The signed document shows %, not this change order''s %; void it and send the change order again', v_signed_total, new.total_cents
        using errcode = '23514';
    end if;
  end if;
  return new;
end;
$$;

revoke all on function public.tg_change_order_signature_freeze() from public, anon, authenticated;

drop trigger if exists change_orders_signature_freeze on public.change_orders;
create trigger change_orders_signature_freeze
  before update on public.change_orders
  for each row execute function public.tg_change_order_signature_freeze();

create or replace function public.tg_change_order_line_signature_freeze()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_change_order uuid := coalesce(new.change_order_id, old.change_order_id);
begin
  -- The change order went away and took its lines with it.
  if tg_op = 'DELETE' and pg_trigger_depth() > 1 and not exists (select 1 from public.change_orders c where c.id = v_change_order) then
    return old;
  end if;
  if public.change_order_signing_envelope(v_change_order) is not null then
    raise exception 'This change order is out for signature; void the envelope before changing what the buyer is signing' using errcode = '42501';
  end if;
  return coalesce(new, old);
end;
$$;

revoke all on function public.tg_change_order_line_signature_freeze() from public, anon, authenticated;

drop trigger if exists change_order_lines_signature_freeze on public.change_order_lines;
create trigger change_order_lines_signature_freeze
  before insert or update or delete on public.change_order_lines
  for each row execute function public.tg_change_order_line_signature_freeze();
