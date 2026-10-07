-- B12.2: a home the builder owns is written down, after review, when it is worth
-- less than it cost.
--
-- * Measurement (inventory, ASC 330): the carrying amount (1160 + 1170 on the
--   home as of the review date) against net realizable value = expected selling
--   price − cost to complete − cost to sell. The write-down is the excess; none
--   when net realizable value covers cost.
-- * A review is an immutable record of the assumptions, the evidence and the
--   numbers; a different member approves it, and only then does it post
--   (Dr 5070 inventory impairment / Cr 1160 or 1170). If the carrying amount
--   moved since the review was prepared, approval refuses: the review must be
--   prepared again on the current cost.
-- * A write-down is the home's new cost basis. It is never written back up when
--   the outlook recovers; a later review only writes down further.
-- * Owned homes earn at closing and never take a contract loss provision (the
--   provision is refused while capitalized cost exists), so a loss is recognized
--   once: through impairment.
-- * At the sale, the write-down is its own (negative) cost-of-sales component.

create table public.books_inventory_impairments (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  project_id uuid not null references public.projects(id) on delete restrict,
  as_of date not null,
  carrying_cents bigint not null check (carrying_cents > 0),
  selling_price_cents bigint not null check (selling_price_cents >= 0),
  cost_to_complete_cents bigint not null check (cost_to_complete_cents >= 0),
  cost_to_sell_cents bigint not null check (cost_to_sell_cents >= 0),
  net_realizable_cents bigint not null,
  write_down_cents bigint not null check (write_down_cents > 0),
  evidence_url text not null check (evidence_url like 'https://%'),
  assumptions text not null check (length(trim(assumptions)) between 10 and 4000),
  status text not null default 'proposed' check (status in ('proposed','approved','rejected')),
  prepared_by uuid not null references public.app_users(id),
  prepared_at timestamptz not null default clock_timestamp(),
  reviewed_by uuid references public.app_users(id),
  reviewed_at timestamptz,
  review_note text,
  journal_entry_id uuid references public.journal_entries(id) on delete restrict,
  constraint books_inventory_impairments_measure_check check (
    net_realizable_cents = selling_price_cents - cost_to_complete_cents - cost_to_sell_cents
    and write_down_cents = carrying_cents - net_realizable_cents),
  constraint books_inventory_impairments_review_check check ((status = 'proposed') = (reviewed_by is null)),
  constraint books_inventory_impairments_independent_check check (reviewed_by is null or reviewed_by <> prepared_by),
  constraint books_inventory_impairments_posted_check check ((status = 'approved') = (journal_entry_id is not null))
);
create index books_inventory_impairments_project_idx on public.books_inventory_impairments (org_id, project_id, as_of desc);
create unique index books_inventory_impairments_one_open_idx on public.books_inventory_impairments (project_id) where status = 'proposed';
create index books_inventory_impairments_project_fk_idx on public.books_inventory_impairments (project_id);
create index books_inventory_impairments_prepared_by_idx on public.books_inventory_impairments (prepared_by);
create index books_inventory_impairments_reviewed_by_idx on public.books_inventory_impairments (reviewed_by) where reviewed_by is not null;
create index books_inventory_impairments_entry_idx on public.books_inventory_impairments (journal_entry_id) where journal_entry_id is not null;
alter table public.books_inventory_impairments enable row level security;
create policy books_inventory_impairments_read on public.books_inventory_impairments
  for select to authenticated using (public.has_org_permission(org_id, 'books.read'));
grant select on public.books_inventory_impairments to authenticated;

create or replace function public.books_guard_inventory_impairment()
returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'Impairment reviews are kept'; end if;
  if old.status <> 'proposed' then raise exception 'A reviewed impairment cannot change; a write-down is the home''s new cost and is not written back up'; end if;
  if (new.org_id, new.project_id, new.as_of, new.carrying_cents, new.selling_price_cents, new.cost_to_complete_cents, new.cost_to_sell_cents, new.net_realizable_cents, new.write_down_cents, new.evidence_url, new.assumptions, new.prepared_by, new.prepared_at)
    is distinct from (old.org_id, old.project_id, old.as_of, old.carrying_cents, old.selling_price_cents, old.cost_to_complete_cents, old.cost_to_sell_cents, old.net_realizable_cents, old.write_down_cents, old.evidence_url, old.assumptions, old.prepared_by, old.prepared_at) then
    raise exception 'Only the review decision of an impairment can be recorded';
  end if;
  return new;
end;
$$;
revoke all on function public.books_guard_inventory_impairment() from public, anon, authenticated;
create trigger books_inventory_impairments_guard before update or delete on public.books_inventory_impairments
  for each row execute function public.books_guard_inventory_impairment();

-- The home's carrying amount: what sits in 1160 and 1170 on it as of a date.
create or replace function public.books_home_carrying_cents(p_org_id uuid, p_project_id uuid, p_as_of date)
returns bigint language sql stable set search_path = public as $$
  select coalesce(sum(l.debit_cents - l.credit_cents), 0)::bigint
  from public.journal_lines l
  join public.journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
  join public.gl_accounts a on a.id = l.account_id and a.org_id = l.org_id
  where l.org_id = p_org_id and l.project_id = p_project_id and a.code in ('1160','1170') and e.status in ('posted','reversed') and e.entry_date <= p_as_of;
$$;
revoke all on function public.books_home_carrying_cents(uuid,uuid,date) from public, anon, authenticated;
grant execute on function public.books_home_carrying_cents(uuid,uuid,date) to service_role;

create or replace function public.propose_books_inventory_impairment(
  p_org_id uuid, p_project_id uuid, p_as_of date, p_selling_price_cents bigint, p_cost_to_complete_cents bigint, p_cost_to_sell_cents bigint,
  p_evidence_url text, p_assumptions text, p_actor_id uuid
) returns uuid language plpgsql security definer set search_path = public as $$
declare v_settings public.project_financial_settings%rowtype; v_carrying bigint; v_nrv bigint; v_id uuid;
begin
  if p_actor_id is null or not exists(select 1 from public.app_users where id = p_actor_id) then raise exception 'A preparer is required'; end if;
  select * into v_settings from public.project_financial_settings where org_id = p_org_id and project_id = p_project_id and books_inventory_enabled;
  if not found or p_as_of < v_settings.books_inventory_effective_on then raise exception 'Impairment applies to a home the builder owns, from its inventory date'; end if;
  if v_settings.books_inventory_sold_on is not null and p_as_of >= v_settings.books_inventory_sold_on then raise exception 'The home is sold; its cost is already in cost of sales'; end if;
  if exists(select 1 from public.accounting_periods where org_id = p_org_id and status = 'closed' and p_as_of between period_start and period_end) then raise exception 'The review date is in a closed month'; end if;
  if least(p_selling_price_cents, p_cost_to_complete_cents, p_cost_to_sell_cents) < 0 then raise exception 'Amounts cannot be negative'; end if;
  v_carrying := public.books_home_carrying_cents(p_org_id, p_project_id, p_as_of);
  if v_carrying <= 0 then raise exception 'The home carries no cost to review'; end if;
  v_nrv := p_selling_price_cents - p_cost_to_complete_cents - p_cost_to_sell_cents;
  if v_carrying <= v_nrv then raise exception 'No write-down: the home''s net realizable value covers its cost'; end if;
  insert into public.books_inventory_impairments(org_id, project_id, as_of, carrying_cents, selling_price_cents, cost_to_complete_cents, cost_to_sell_cents, net_realizable_cents, write_down_cents, evidence_url, assumptions, prepared_by)
  values (p_org_id, p_project_id, p_as_of, v_carrying, p_selling_price_cents, p_cost_to_complete_cents, p_cost_to_sell_cents, v_nrv, v_carrying - v_nrv, p_evidence_url, trim(p_assumptions), p_actor_id)
  returning id into v_id;
  return v_id;
end;
$$;
revoke all on function public.propose_books_inventory_impairment(uuid,uuid,date,bigint,bigint,bigint,text,text,uuid) from public, anon, authenticated;
grant execute on function public.propose_books_inventory_impairment(uuid,uuid,date,bigint,bigint,bigint,text,text,uuid) to service_role;

create or replace function public.review_books_inventory_impairment(p_org_id uuid, p_impairment_id uuid, p_approve boolean, p_note text, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v public.books_inventory_impairments%rowtype; v_settings public.project_financial_settings%rowtype; v_policy integer; v_expense uuid; v_inventory uuid; v_entry uuid; v_dims jsonb;
begin
  select * into v from public.books_inventory_impairments where id = p_impairment_id and org_id = p_org_id for update;
  if not found then raise exception 'Impairment review not found'; end if;
  if v.status <> 'proposed' then raise exception 'This impairment has already been reviewed'; end if;
  if p_actor_id is null or p_actor_id = v.prepared_by then raise exception 'An impairment is approved by someone other than the person who prepared it'; end if;
  if not p_approve then
    if length(trim(coalesce(p_note, ''))) < 10 then raise exception 'Say why the impairment is rejected'; end if;
    update public.books_inventory_impairments set status = 'rejected', reviewed_by = p_actor_id, reviewed_at = clock_timestamp(), review_note = trim(p_note) where id = v.id;
    return jsonb_build_object('impairmentId', v.id, 'projectId', v.project_id, 'status', 'rejected', 'journalEntryId', null);
  end if;
  select * into v_settings from public.project_financial_settings where org_id = p_org_id and project_id = v.project_id for update;
  if v_settings.books_inventory_sold_on is not null and v.as_of >= v_settings.books_inventory_sold_on then raise exception 'The home is sold; its cost is already in cost of sales'; end if;
  if public.books_home_carrying_cents(p_org_id, v.project_id, v.as_of) <> v.carrying_cents then
    raise exception 'The home''s cost changed since this review was prepared; prepare it again on the current cost';
  end if;
  select active_policy_version into v_policy from public.books_settings where org_id = p_org_id;
  if v_policy is null then raise exception 'Books posting is not enabled'; end if;
  insert into public.gl_accounts(org_id, code, name, account_type, subtype, normal_balance, cash_flow_category, is_system, active)
    values (p_org_id, '5070', 'Inventory impairment', 'cogs', 'job_costs', 'debit', 'operating', true, true) on conflict (org_id, code) do nothing;
  -- 5070 is a cost-of-sales account identified by its code (chart policy v1 is
  -- immutable; a dedicated subtype waits for the next chart policy version).
  select id into v_expense from public.gl_accounts where org_id = p_org_id and code = '5070' and account_type = 'cogs' and name = 'Inventory impairment' and active;
  if v_expense is null then raise exception 'Account 5070 conflicts with the organization chart'; end if;
  select id into v_inventory from public.gl_accounts where org_id = p_org_id and active and code = case when v_settings.books_inventory_completed_on is not null and v.as_of >= v_settings.books_inventory_completed_on then '1170' else '1160' end;
  if v_inventory is null then raise exception 'Inventory accounts are missing'; end if;
  v_dims := jsonb_build_object('inventory_impairment_id', v.id, 'net_realizable_cents', v.net_realizable_cents, 'evidence_url', v.evidence_url);
  v_entry := public.post_books_journal_entry(p_org_id, jsonb_build_object('entry_date', v.as_of, 'entry_kind', 'adjusting', 'memo', 'Inventory written down to net realizable value',
    'posting_key', 'inventory_impairment:' || v.id, 'projection_version', 1, 'policy_version', v_policy, 'source_type', 'inventory_impairment', 'source_id', v.project_id, 'created_by', p_actor_id),
    jsonb_build_array(
      jsonb_build_object('line_no', 1, 'account_id', v_expense, 'project_id', v.project_id, 'debit_cents', v.write_down_cents, 'credit_cents', 0, 'dimensions', v_dims),
      jsonb_build_object('line_no', 2, 'account_id', v_inventory, 'project_id', v.project_id, 'debit_cents', 0, 'credit_cents', v.write_down_cents, 'dimensions', v_dims)));
  update public.books_inventory_impairments set status = 'approved', reviewed_by = p_actor_id, reviewed_at = clock_timestamp(), review_note = nullif(trim(coalesce(p_note, '')), ''), journal_entry_id = v_entry
    where id = v.id;
  return jsonb_build_object('impairmentId', v.id, 'projectId', v.project_id, 'status', 'approved', 'journalEntryId', v_entry);
end;
$$;
revoke all on function public.review_books_inventory_impairment(uuid,uuid,boolean,text,uuid) from public, anon, authenticated;
grant execute on function public.review_books_inventory_impairment(uuid,uuid,boolean,text,uuid) to service_role;

-- The loss and impairment schedule ties to the ledger: write-downs posted to
-- 5070 (before any year-end close moves them to retained earnings) equal the
-- approved reviews dated by then.
create or replace function public.books_impairment_control(p_org_id uuid, p_as_of date)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'ledgerCents', (select coalesce(sum(l.debit_cents - l.credit_cents), 0)::bigint from public.journal_lines l
      join public.journal_entries e on e.id = l.entry_id and e.org_id = l.org_id join public.gl_accounts a on a.id = l.account_id and a.org_id = l.org_id
      where l.org_id = p_org_id and a.code = '5070' and e.status in ('posted','reversed') and e.entry_date <= p_as_of
        and e.source_type is distinct from 'year_end_close'
        and not exists(select 1 from public.journal_entries o where o.id = e.reversal_of_entry_id and o.source_type = 'year_end_close')),
    'subledgerCents', (select coalesce(sum(write_down_cents), 0)::bigint from public.books_inventory_impairments where org_id = p_org_id and status = 'approved' and as_of <= p_as_of));
$$;
revoke all on function public.books_impairment_control(uuid,date) from public, anon, authenticated;
grant execute on function public.books_impairment_control(uuid,date) to service_role;
