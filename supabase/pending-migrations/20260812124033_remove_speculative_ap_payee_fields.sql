-- DESTRUCTIVE / PENDING HUMAN APPROVAL
--
-- The launch product supports exactly one primary-vendor ACH destination per
-- payable. Joint payees and external checks never had an authorization,
-- evidence, delivery, or reconciliation workflow, and allocation_snapshot was
-- always the empty array. Remove those speculative database promises only after
-- confirming production contains no unsupported rows.

begin;

do $$
begin
  if exists (
    select 1
    from public.payment_run_item_payees
    where payee_kind <> 'primary_vendor'
       or method <> 'ach'
       or recipient_account_id is null
  ) then
    raise exception 'Unsupported joint/external-check payees exist; resolve them before applying this migration';
  end if;
  if exists (
    select 1
    from public.payment_run_item_payees
    group by run_item_id
    having count(*) > 1
  ) then
    raise exception 'Multi-payee payment-run items exist; resolve them before applying this migration';
  end if;
end;
$$;

-- Rebuild the currently deployed function definition without the inert column.
-- Pulling the active definition is intentional: several later migrations fixed
-- fee constraints, so copying the obsolete foundation body would regress them.
do $$
declare
  v_definition text;
  v_rewritten text;
begin
  select pg_get_functiondef(
    'public.create_payment_run_atomic(uuid,uuid,uuid,text,text,smallint,bigint,bigint,bigint,bigint,jsonb,text,jsonb)'::regprocedure
  ) into v_definition;
  v_rewritten := replace(
    v_definition,
    '      total_debit_cents, allocation_snapshot, hold_snapshot, waiver_snapshot',
    '      total_debit_cents, hold_snapshot, waiver_snapshot'
  );
  v_rewritten := replace(
    v_rewritten,
    E'      coalesce(v_item->''allocation_snapshot'', ''[]''::jsonb),\n      coalesce(v_item->''hold_snapshot'', ''{}''::jsonb),',
    '      coalesce(v_item->''hold_snapshot'', ''{}''::jsonb),'
  );
  if v_rewritten = v_definition or position('allocation_snapshot' in v_rewritten) > 0 then
    raise exception 'create_payment_run_atomic did not match the reviewed definition; rewrite it explicitly before dropping allocation_snapshot';
  end if;
  execute v_rewritten;
end;
$$;

alter table public.payment_run_items
  drop column allocation_snapshot;

alter table public.payment_run_item_payees
  drop constraint if exists payment_run_item_payees_payee_kind_check,
  drop constraint if exists payment_run_item_payees_method_check,
  drop constraint if exists payment_run_item_payees_check,
  add constraint payment_run_item_payees_primary_ach_check check (
    payee_kind = 'primary_vendor'
    and method = 'ach'
    and recipient_account_id is not null
  );

create unique index payment_run_item_payees_one_per_item_uidx
  on public.payment_run_item_payees (run_item_id);

commit;
