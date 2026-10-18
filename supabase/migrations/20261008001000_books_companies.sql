-- Legal entities as segments of the one ledger, intercompany lot sales and per-company openings (B14).
--
-- Consolidated before deploy (2026-10-09) from 3 unapplied migrations, in their
-- original order; each section is marked with the file it came from.

-- ==== 20261007235800_books_legal_entities ====
-- B14.1: a legal entity is a segment of the one Books ledger (docs/books-entities.md).
--
-- * Every organization has one primary entity, created on first need, so a
--   single-company builder never sees the concept.
-- * Every journal line names its owning entity, resolved once, inside the only
--   writer (post_books_journal_entry): an explicit choice on the line, then the
--   owner recorded on an intercompany leg, then the account's owner (a company's
--   bank, cash or card account), then the project's owner (the primary entity
--   when the project names none), then the entry's choice, then the primary entity. A reversal keeps each original
--   line's owner, even if a project has changed hands since.
-- * An entry balances per entity. When its lines resolve to different entities,
--   posting adds the due-from / due-to legs (1180 / 2180) that make each entity
--   balance, settling any amount already owed between the two first; each leg
--   names its owner and counterparty.

create table public.books_legal_entities (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  name text not null check (length(btrim(name)) between 2 and 160),
  legal_name text check (legal_name is null or length(btrim(legal_name)) between 2 and 200),
  is_primary boolean not null default false,
  status text not null default 'active' check (status in ('active','archived')),
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint books_legal_entities_primary_active check (not is_primary or status = 'active'),
  unique (org_id, id)
);
create unique index books_legal_entities_one_primary on public.books_legal_entities (org_id) where is_primary;
create unique index books_legal_entities_name on public.books_legal_entities (org_id, lower(btrim(name)));
create index books_legal_entities_created_by_idx on public.books_legal_entities (created_by) where created_by is not null;
create trigger books_legal_entities_updated_at before update on public.books_legal_entities
  for each row execute function public.tg_set_updated_at();
alter table public.books_legal_entities enable row level security;
create policy books_legal_entities_read on public.books_legal_entities
  for select to authenticated using (public.has_org_permission(org_id, 'books.read'));
grant select on public.books_legal_entities to authenticated;

-- The organization's primary entity, created on first need.
create or replace function public.books_primary_entity(p_org_id uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_id uuid;
begin
  select id into v_id from public.books_legal_entities where org_id = p_org_id and is_primary;
  if v_id is not null then return v_id; end if;
  insert into public.books_legal_entities(org_id, name, is_primary)
    select p_org_id, coalesce(nullif(btrim(o.name), ''), 'Primary company'), true from public.orgs o where o.id = p_org_id
    on conflict (org_id) where is_primary do nothing;
  select id into v_id from public.books_legal_entities where org_id = p_org_id and is_primary;
  if v_id is null then raise exception 'Organization not found'; end if;
  return v_id;
end;
$$;
revoke all on function public.books_primary_entity(uuid) from public, anon, authenticated;
grant execute on function public.books_primary_entity(uuid) to service_role;

alter table public.projects add column legal_entity_id uuid;
alter table public.projects add constraint projects_legal_entity_fkey foreign key (org_id, legal_entity_id) references public.books_legal_entities(org_id, id);
create index projects_legal_entity_idx on public.projects (org_id, legal_entity_id) where legal_entity_id is not null;

alter table public.gl_accounts add column legal_entity_id uuid;
alter table public.gl_accounts add constraint gl_accounts_legal_entity_fkey foreign key (org_id, legal_entity_id) references public.books_legal_entities(org_id, id);
create index gl_accounts_legal_entity_idx on public.gl_accounts (org_id, legal_entity_id) where legal_entity_id is not null;

-- Existing lines belong to their organization's primary entity.
alter table public.journal_lines add column legal_entity_id uuid;
do $$
declare v_org uuid;
begin
  for v_org in select distinct org_id from public.journal_lines loop
    perform public.books_primary_entity(v_org);
  end loop;
end $$;
alter table public.journal_lines disable trigger user;
update public.journal_lines l set legal_entity_id = e.id from public.books_legal_entities e where e.org_id = l.org_id and e.is_primary and l.legal_entity_id is null;
alter table public.journal_lines enable trigger user;
alter table public.journal_lines alter column legal_entity_id set not null;
alter table public.journal_lines add constraint journal_lines_legal_entity_fkey foreign key (org_id, legal_entity_id) references public.books_legal_entities(org_id, id);
create index journal_lines_legal_entity_idx on public.journal_lines (org_id, legal_entity_id, account_id);

-- Arc's system account for what companies owe each other: an existing one in
-- 1180-1189 (asset) or 2180-2189 (liability), or a new one at the first free code.
create or replace function public.books_intercompany_account(p_org_id uuid, p_side text)
returns uuid language plpgsql security definer set search_path = public, pg_catalog as $$
declare v_id uuid; v_code text; v_prefix text := case p_side when 'asset' then '118' when 'liability' then '218' end;
begin
  if v_prefix is null then raise exception 'Unknown intercompany side'; end if;
  select id into v_id from public.gl_accounts where org_id = p_org_id and is_system and active and account_type = p_side
    and subtype = case p_side when 'asset' then 'other_asset' else 'other_liability' end and code ~ ('^' || v_prefix || '[0-9]$') order by code limit 1;
  if v_id is not null then return v_id; end if;
  select v_prefix || n into v_code from generate_series(0, 9) n
    where not exists (select 1 from public.gl_accounts where org_id = p_org_id and code = v_prefix || n) order by n limit 1;
  if v_code is null then raise exception 'Accounts %0-%9 are all in use; free one for what companies owe each other', v_prefix, v_prefix; end if;
  insert into public.gl_accounts(org_id, code, name, account_type, subtype, normal_balance, cash_flow_category, is_system, active)
    values (p_org_id, v_code, case p_side when 'asset' then 'Due from affiliates' else 'Due to affiliates' end, p_side,
      case p_side when 'asset' then 'other_asset' else 'other_liability' end, case p_side when 'asset' then 'debit' else 'credit' end, 'operating', true, true)
    returning id into v_id;
  return v_id;
end $$;
revoke all on function public.books_intercompany_account(uuid, text) from public, anon, authenticated;

create or replace function public.post_books_journal_entry(p_org_id uuid, p_entry jsonb, p_lines jsonb)
returns uuid language plpgsql security definer set search_path = public, pg_catalog as $$
declare
  entry_id uuid;
  line_row jsonb;
  resolved_period_id uuid;
  v_primary uuid;
  v_entry_entity uuid;
  v_original uuid;
  v_resolved jsonb := '[]'::jsonb;
  v_entity uuid;
  v_line_no integer := 0;
  v_used uuid[] := '{}';
  v_match uuid;
  v_debtor record;
  v_creditor record;
  v_amount bigint;
  v_due_from uuid;
  v_due_to uuid;
  v_owed bigint;
  v_settle bigint;
begin
  if jsonb_typeof(p_entry) <> 'object' or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) < 2 then
    raise exception 'A journal entry requires an entry object and at least two lines';
  end if;

  select id into resolved_period_id
  from public.accounting_periods
  where org_id = p_org_id
    and (p_entry ->> 'entry_date')::date between period_start and period_end
  order by period_start desc
  limit 1;

  v_primary := public.books_primary_entity(p_org_id);
  v_entry_entity := nullif(p_entry ->> 'legal_entity_id', '')::uuid;
  v_original := nullif(p_entry ->> 'reversal_of_entry_id', '')::uuid;

  -- Resolve each line's owner.
  for line_row in select value from jsonb_array_elements(p_lines) loop
    v_entity := null;
    if v_original is not null then
      -- A reversal keeps the owner of the original line it mirrors.
      select l.id, l.legal_entity_id into v_match, v_entity from public.journal_lines l
       where l.org_id = p_org_id and l.entry_id = v_original and not (l.id = any(v_used))
         and l.account_id = (line_row ->> 'account_id')::uuid
         and l.project_id is not distinct from nullif(line_row ->> 'project_id', '')::uuid
         and l.company_id is not distinct from nullif(line_row ->> 'company_id', '')::uuid
         and l.debit_cents = coalesce((line_row ->> 'credit_cents')::bigint, 0)
         and l.credit_cents = coalesce((line_row ->> 'debit_cents')::bigint, 0)
       order by l.line_no limit 1;
      if v_match is not null then v_used := v_used || v_match; end if;
    end if;
    v_entity := coalesce(
      v_entity,
      nullif(line_row ->> 'legal_entity_id', '')::uuid,
      nullif(line_row -> 'dimensions' ->> 'intercompany_owner_entity_id', '')::uuid,
      -- An owned account (a company's bank, cash or card) decides, even on a line
      -- tagged with a job: the money moved through that company's account. Cash,
      -- undeposited funds and cards no company owns belong to the primary company,
      -- so paying another company's job from them records what that company owes.
      (select coalesce(a.legal_entity_id, case when a.subtype in ('cash', 'undeposited_funds', 'credit_card') then v_primary end)
         from public.gl_accounts a where a.org_id = p_org_id and a.id = (line_row ->> 'account_id')::uuid),
      -- A job belongs to its company, or to the primary company when it names none.
      (select coalesce(p.legal_entity_id, v_primary) from public.projects p where p.org_id = p_org_id and p.id = nullif(line_row ->> 'project_id', '')::uuid),
      v_entry_entity,
      v_primary);
    v_resolved := v_resolved || jsonb_build_array(line_row || jsonb_build_object('legal_entity_id', v_entity));
  end loop;

  -- Intercompany: pair each entity whose debits exceed its credits with one whose
  -- credits exceed its debits, until every entity balances on its own.
  if (select count(distinct value ->> 'legal_entity_id') from jsonb_array_elements(v_resolved)) > 1 then
    loop
      select value ->> 'legal_entity_id' as entity, sum(coalesce((value ->> 'debit_cents')::bigint, 0) - coalesce((value ->> 'credit_cents')::bigint, 0)) as net
        into v_debtor from jsonb_array_elements(v_resolved) group by 1 having sum(coalesce((value ->> 'debit_cents')::bigint, 0) - coalesce((value ->> 'credit_cents')::bigint, 0)) > 0 order by 2 desc, 1 limit 1;
      exit when v_debtor is null;
      select value ->> 'legal_entity_id' as entity, sum(coalesce((value ->> 'debit_cents')::bigint, 0) - coalesce((value ->> 'credit_cents')::bigint, 0)) as net
        into v_creditor from jsonb_array_elements(v_resolved) group by 1 having sum(coalesce((value ->> 'debit_cents')::bigint, 0) - coalesce((value ->> 'credit_cents')::bigint, 0)) < 0 order by 2, 1 limit 1;
      if v_creditor is null then raise exception 'Journal entry does not balance'; end if;
      if v_due_from is null then
        -- Arc's own system accounts in 1180-1189 and 2180-2189: a builder's chart
        -- that already uses 1180 or 2180 for something else is never touched; the
        -- first free code is used instead.
        v_due_from := public.books_intercompany_account(p_org_id, 'asset');
        v_due_to := public.books_intercompany_account(p_org_id, 'liability');
      end if;
      v_amount := least(v_debtor.net, -v_creditor.net);
      -- The entity with excess debits owes the other. It first settles what the
      -- other already owes it (its due-from that company, mirrored by the other's
      -- due-to), and only the rest becomes a new amount owed, so two companies
      -- never carry a receivable and a payable with each other at once.
      perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':intercompany:' || least(v_debtor.entity, v_creditor.entity) || greatest(v_debtor.entity, v_creditor.entity), 0));
      select greatest(coalesce(sum(l.debit_cents - l.credit_cents), 0), 0) into v_owed
        from public.journal_lines l join public.journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
        where l.org_id = p_org_id and l.account_id = v_due_from and l.legal_entity_id = v_debtor.entity::uuid
          and l.dimensions ->> 'counterparty_entity_id' = v_creditor.entity and e.status in ('posted','reversed');
      v_settle := least(v_amount, v_owed);
      if v_settle > 0 then
        v_resolved := v_resolved || jsonb_build_array(
          jsonb_build_object('account_id', v_due_from, 'debit_cents', 0, 'credit_cents', v_settle, 'legal_entity_id', v_debtor.entity,
            'dimensions', jsonb_build_object('intercompany', true, 'intercompany_owner_entity_id', v_debtor.entity, 'counterparty_entity_id', v_creditor.entity)),
          jsonb_build_object('account_id', v_due_to, 'debit_cents', v_settle, 'credit_cents', 0, 'legal_entity_id', v_creditor.entity,
            'dimensions', jsonb_build_object('intercompany', true, 'intercompany_owner_entity_id', v_creditor.entity, 'counterparty_entity_id', v_debtor.entity)));
      end if;
      if v_amount > v_settle then
        v_resolved := v_resolved || jsonb_build_array(
          jsonb_build_object('account_id', v_due_to, 'debit_cents', 0, 'credit_cents', v_amount - v_settle, 'legal_entity_id', v_debtor.entity,
            'dimensions', jsonb_build_object('intercompany', true, 'intercompany_owner_entity_id', v_debtor.entity, 'counterparty_entity_id', v_creditor.entity)),
          jsonb_build_object('account_id', v_due_from, 'debit_cents', v_amount - v_settle, 'credit_cents', 0, 'legal_entity_id', v_creditor.entity,
            'dimensions', jsonb_build_object('intercompany', true, 'intercompany_owner_entity_id', v_creditor.entity, 'counterparty_entity_id', v_debtor.entity)));
      end if;
    end loop;
  end if;

  insert into public.journal_entries (
    org_id, fact_id, period_id, entry_date, entry_kind, status, memo,
    posting_key, projection_version, policy_version, source_type, source_id,
    reversal_of_entry_id, created_by
  ) values (
    p_org_id,
    nullif(p_entry ->> 'fact_id', '')::uuid,
    resolved_period_id,
    (p_entry ->> 'entry_date')::date,
    p_entry ->> 'entry_kind',
    'draft',
    p_entry ->> 'memo',
    p_entry ->> 'posting_key',
    coalesce((p_entry ->> 'projection_version')::integer, 1),
    (p_entry ->> 'policy_version')::integer,
    nullif(p_entry ->> 'source_type', ''),
    nullif(p_entry ->> 'source_id', '')::uuid,
    v_original,
    nullif(p_entry ->> 'created_by', '')::uuid
  )
  returning id into entry_id;

  for line_row in select value from jsonb_array_elements(v_resolved)
  loop
    v_line_no := greatest(v_line_no + 1, coalesce((line_row ->> 'line_no')::integer, 0));
    insert into public.journal_lines (
      org_id, entry_id, line_no, account_id, project_id, company_id,
      description, debit_cents, credit_cents, dimensions, legal_entity_id
    ) values (
      p_org_id,
      entry_id,
      coalesce((line_row ->> 'line_no')::smallint, v_line_no::smallint),
      (line_row ->> 'account_id')::uuid,
      nullif(line_row ->> 'project_id', '')::uuid,
      nullif(line_row ->> 'company_id', '')::uuid,
      nullif(line_row ->> 'description', ''),
      coalesce((line_row ->> 'debit_cents')::bigint, 0),
      coalesce((line_row ->> 'credit_cents')::bigint, 0),
      coalesce(line_row -> 'dimensions', '{}'::jsonb),
      (line_row ->> 'legal_entity_id')::uuid
    );
  end loop;

  update public.journal_entries
  set status = 'posted', posted_at = now(), posted_by = nullif(p_entry ->> 'created_by', '')::uuid
  where id = entry_id;

  return entry_id;
end;
$$;

-- Ownership is fixed once money has posted against it: changing a project's or
-- an account's owner afterwards would silently move posted history between
-- companies. That takes a governed correction, not an edit.
create or replace function public.books_guard_posted_entity_owner()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.legal_entity_id is not distinct from old.legal_entity_id then return new; end if;
  if tg_table_name = 'projects' and exists(select 1 from public.journal_lines where org_id = old.org_id and project_id = old.id) then
    raise exception 'This project already has postings; its owning company cannot change' using errcode = 'P0001';
  end if;
  if tg_table_name = 'gl_accounts' and exists(select 1 from public.journal_lines where org_id = old.org_id and account_id = old.id) then
    raise exception 'This account already has postings; its owning company cannot change' using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke all on function public.books_guard_posted_entity_owner() from public, anon, authenticated;
create trigger books_projects_entity_owner_guard before update of legal_entity_id on public.projects
  for each row execute function public.books_guard_posted_entity_owner();
create trigger books_gl_accounts_entity_owner_guard before update of legal_entity_id on public.gl_accounts
  for each row execute function public.books_guard_posted_entity_owner();

-- Jobs and cash accounts that have postings, whose owner is therefore fixed.
create or replace function public.books_entity_owned_with_postings(p_org_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(id), '[]'::jsonb) from (
    select distinct l.project_id as id from public.journal_lines l where l.org_id = p_org_id and l.project_id is not null
    union
    select distinct l.account_id from public.journal_lines l join public.gl_accounts a on a.id = l.account_id and a.org_id = l.org_id
      where l.org_id = p_org_id and a.subtype in ('cash','undeposited_funds','credit_card')
  ) owned;
$$;
revoke all on function public.books_entity_owned_with_postings(uuid) from public, anon, authenticated;
grant execute on function public.books_entity_owned_with_postings(uuid) to service_role;

-- As-of balances also by owning company and intercompany flag, so trial balance,
-- balance sheet and the close tie-outs can be read for one company or consolidated.
drop function public.books_ledger_balances(uuid, date);
create function public.books_ledger_balances(p_org_id uuid, p_as_of date)
returns table(account_id uuid, project_id uuid, contract_id text, warranty_reserve_adjustment boolean, legal_entity_id uuid, intercompany boolean, debit_cents bigint, credit_cents bigint)
language sql stable set search_path to 'pg_catalog', 'public' as $$
  select line.account_id,
    line.project_id,
    line.dimensions ->> 'contract_id',
    coalesce(line.dimensions ->> 'warranty_reserve_adjustment' = 'true', false),
    line.legal_entity_id,
    -- Removed in consolidation: due-from / due-to legs and sales between companies.
    coalesce(line.dimensions ->> 'intercompany' = 'true' or line.dimensions ->> 'intercompany_eliminate' = 'true', false),
    sum(line.debit_cents)::bigint,
    sum(line.credit_cents)::bigint
  from public.journal_lines line
  join public.journal_entries entry on entry.id = line.entry_id and entry.org_id = line.org_id
  where line.org_id = p_org_id
    and entry.org_id = p_org_id
    and entry.status in ('posted', 'reversed')
    and entry.entry_date <= p_as_of
  group by 1, 2, 3, 4, 5, 6
$$;
revoke all on function public.books_ledger_balances(uuid, date) from public, anon, authenticated;
grant execute on function public.books_ledger_balances(uuid, date) to service_role;

-- A close saves each company's statements beside the consolidated ones (empty
-- company), so a closed month reads as it was closed for each company too.
alter table public.financial_statement_snapshots add column legal_entity_id uuid;
alter table public.financial_statement_snapshots add constraint financial_statement_snapshots_legal_entity_fkey
  foreign key (org_id, legal_entity_id) references public.books_legal_entities(org_id, id);
alter table public.financial_statement_snapshots drop constraint financial_statement_snapshots_period_id_statement_type_basi_key;
alter table public.financial_statement_snapshots add constraint financial_statement_snapshots_identity_key
  unique nulls not distinct (period_id, statement_type, basis, legal_entity_id, content_hash);
create index financial_statement_snapshots_legal_entity_idx on public.financial_statement_snapshots (org_id, legal_entity_id) where legal_entity_id is not null;

-- ==== 20261007235900_books_intercompany_lot_sales ====
-- B14.3/B14.4: a land company sells a lot to an affiliated building company's home.
--
-- The seller (the company that holds the lot's land basis) records the sale: it
-- earns the price and relieves the lot's cost. The buyer's home takes the lot into
-- construction at the price. Posting adds the due-from / due-to pair between them.
-- This replaces the ordinary start transfer for that lot (same posting key), so a
-- lot enters a house once.
--
-- Consolidated statements eliminate the sale: the seller's revenue and cost of the
-- lot (tagged intercompany_eliminate) and the due-from / due-to pair are removed,
-- and the profit the seller made stays out of the home's inventory until the home
-- sells to an outside buyer (computed from this register; nothing is posted to
-- either company's books).

create table public.books_intercompany_sales (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  lot_id uuid not null,
  buyer_project_id uuid not null,
  seller_entity_id uuid not null,
  buyer_entity_id uuid not null,
  sale_date date not null,
  price_cents bigint not null check (price_cents > 0),
  cost_cents bigint not null check (cost_cents > 0),
  evidence_url text not null check (evidence_url like 'https://%'),
  journal_entry_id uuid not null references public.journal_entries(id) on delete restrict,
  created_by uuid references public.app_users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint books_intercompany_sales_parties_check check (seller_entity_id <> buyer_entity_id),
  constraint books_intercompany_sales_lot_fkey foreign key (lot_id) references public.lots(id) on delete restrict,
  constraint books_intercompany_sales_project_fkey foreign key (buyer_project_id) references public.projects(id) on delete restrict,
  constraint books_intercompany_sales_seller_fkey foreign key (org_id, seller_entity_id) references public.books_legal_entities(org_id, id),
  constraint books_intercompany_sales_buyer_fkey foreign key (org_id, buyer_entity_id) references public.books_legal_entities(org_id, id),
  unique (org_id, lot_id)
);
create index books_intercompany_sales_project_idx on public.books_intercompany_sales (org_id, buyer_project_id);
create index books_intercompany_sales_lot_idx on public.books_intercompany_sales (lot_id);
create index books_intercompany_sales_buyer_project_fk_idx on public.books_intercompany_sales (buyer_project_id);
create index books_intercompany_sales_seller_idx on public.books_intercompany_sales (org_id, seller_entity_id);
create index books_intercompany_sales_buyer_idx on public.books_intercompany_sales (org_id, buyer_entity_id);
create index books_intercompany_sales_entry_idx on public.books_intercompany_sales (journal_entry_id);
create index books_intercompany_sales_created_by_idx on public.books_intercompany_sales (created_by) where created_by is not null;
alter table public.books_intercompany_sales enable row level security;
create policy books_intercompany_sales_read on public.books_intercompany_sales
  for select to authenticated using (public.has_org_permission(org_id, 'books.read'));
grant select on public.books_intercompany_sales to authenticated;

create or replace function public.books_guard_intercompany_sale()
returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'An intercompany sale is kept as recorded; correct it with a new posting';
end;
$$;
revoke all on function public.books_guard_intercompany_sale() from public, anon, authenticated;
create trigger books_intercompany_sales_guard before update or delete on public.books_intercompany_sales
  for each row execute function public.books_guard_intercompany_sale();

create or replace function public.sell_books_lot_to_affiliate(p_org_id uuid, p_lot_id uuid, p_date date, p_price_cents bigint, p_evidence_url text, p_actor_id uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_lot public.lots%rowtype; v_land uuid; v_cip uuid; v_revenue uuid; v_cogs uuid; v_cost bigint; v_seller uuid; v_buyer uuid; v_policy integer;
  v_entry uuid; v_sale uuid := gen_random_uuid(); v_key text; v_dims jsonb; v_existing public.books_intercompany_sales%rowtype; v_holders bigint;
begin
  if p_price_cents is null or p_price_cents <= 0 or p_evidence_url not like 'https://%' then raise exception 'A sale price and supporting evidence are required'; end if;
  select * into v_lot from public.lots where org_id = p_org_id and id = p_lot_id for update;
  if not found then raise exception 'Lot not found'; end if;
  select * into v_existing from public.books_intercompany_sales where org_id = p_org_id and lot_id = p_lot_id;
  if found then
    if v_existing.sale_date <> p_date or v_existing.price_cents <> p_price_cents then raise exception 'This lot was already sold to its home on different terms'; end if;
    return jsonb_build_object('status', 'posted', 'saleId', v_existing.id, 'journalEntryId', v_existing.journal_entry_id);
  end if;
  if v_lot.books_acquisition_entry_id is null then raise exception 'The lot has no recorded land basis'; end if;
  if v_lot.project_id is null then raise exception 'Assign the lot to the home it is sold to'; end if;
  perform 1 from public.project_financial_settings where org_id = p_org_id and project_id = v_lot.project_id and books_inventory_enabled and books_inventory_effective_on <= p_date
    and books_inventory_completed_on is null and books_inventory_sold_on is null for update;
  if not found then raise exception 'The buying home must hold owned inventory before the lot is sold to it'; end if;
  v_key := 'inventory_start:' || v_lot.id;
  if exists(select 1 from public.journal_entries where org_id = p_org_id and posting_key = v_key and status = 'posted') then raise exception 'The lot is already in a home'; end if;
  select id into v_land from public.gl_accounts where org_id = p_org_id and code = '1120' and active;
  select id into v_cip from public.gl_accounts where org_id = p_org_id and code = '1160' and active;
  select id into v_revenue from public.gl_accounts where org_id = p_org_id and code = '4000' and active;
  select id into v_cogs from public.gl_accounts where org_id = p_org_id and code = '5000' and active;
  if v_land is null or v_cip is null or v_revenue is null or v_cogs is null then raise exception 'Inventory, revenue or cost accounts are missing'; end if;
  -- The seller is whoever holds the lot's land basis.
  select coalesce(sum(l.debit_cents - l.credit_cents), 0), (array_agg(distinct l.legal_entity_id))[1], count(distinct l.legal_entity_id)
    into v_cost, v_seller, v_holders
    from public.journal_lines l join public.journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
    where l.org_id = p_org_id and l.account_id = v_land and l.dimensions ->> 'lot_id' = v_lot.id::text and e.status in ('posted','reversed') and e.entry_date <= p_date;
  if v_cost <= 0 then raise exception 'The lot has no positive land basis at the sale date'; end if;
  if v_holders <> 1 then raise exception 'The lot''s land basis is split between companies; review it before selling the lot'; end if;
  v_buyer := coalesce((select legal_entity_id from public.projects where org_id = p_org_id and id = v_lot.project_id), public.books_primary_entity(p_org_id));
  if v_seller = v_buyer then raise exception 'The home belongs to the company that holds the lot; move the lot into the home instead of selling it'; end if;
  select active_policy_version into v_policy from public.books_settings where org_id = p_org_id;
  v_dims := jsonb_build_object('lot_id', v_lot.id, 'community_id', v_lot.community_id, 'division_id', v_lot.division_id, 'intercompany_sale_id', v_sale);
  v_entry := public.post_books_journal_entry(p_org_id, jsonb_build_object('entry_date', p_date, 'entry_kind', 'adjusting', 'memo', 'Lot sold to an affiliated company',
    'posting_key', v_key, 'projection_version', 1, 'policy_version', v_policy, 'source_type', 'inventory_start', 'source_id', v_lot.id, 'created_by', p_actor_id),
    jsonb_build_array(
      jsonb_build_object('line_no', 1, 'account_id', v_cip, 'project_id', v_lot.project_id, 'debit_cents', p_price_cents, 'credit_cents', 0, 'dimensions', v_dims),
      jsonb_build_object('line_no', 2, 'account_id', v_land, 'legal_entity_id', v_seller, 'debit_cents', 0, 'credit_cents', v_cost, 'dimensions', v_dims),
      jsonb_build_object('line_no', 3, 'account_id', v_cogs, 'legal_entity_id', v_seller, 'debit_cents', v_cost, 'credit_cents', 0, 'dimensions', v_dims || jsonb_build_object('intercompany_eliminate', true)),
      jsonb_build_object('line_no', 4, 'account_id', v_revenue, 'legal_entity_id', v_seller, 'debit_cents', 0, 'credit_cents', p_price_cents, 'dimensions', v_dims || jsonb_build_object('intercompany_eliminate', true))));
  insert into public.job_cost_entries(org_id, project_id, source_type, source_id, incurred_on, cost_cents, status, is_billable, metadata)
    values (p_org_id, v_lot.project_id, 'inventory_event', v_entry, p_date, p_price_cents, 'posted', false, jsonb_build_object('lot_id', v_lot.id, 'journal_entry_id', v_entry, 'intercompany_sale_id', v_sale));
  insert into public.books_intercompany_sales(id, org_id, lot_id, buyer_project_id, seller_entity_id, buyer_entity_id, sale_date, price_cents, cost_cents, evidence_url, journal_entry_id, created_by)
    values (v_sale, p_org_id, v_lot.id, v_lot.project_id, v_seller, v_buyer, p_date, p_price_cents, v_cost, p_evidence_url, v_entry, p_actor_id);
  return jsonb_build_object('status', 'posted', 'saleId', v_sale, 'journalEntryId', v_entry, 'costCents', v_cost);
end;
$$;
revoke all on function public.sell_books_lot_to_affiliate(uuid,uuid,date,bigint,text,uuid) from public, anon, authenticated;
grant execute on function public.sell_books_lot_to_affiliate(uuid,uuid,date,bigint,text,uuid) to service_role;

-- The export carries the companies every journal line belongs to and the
-- intercompany sales register consolidation reads.
create or replace function public.capture_books_export_snapshot(p_org_id uuid)
returns jsonb language plpgsql stable security invoker
set search_path = pg_catalog, public
as $$
declare
  v_table text;
  v_rows jsonb;
  v_tables jsonb := '{}'::jsonb;
begin
  if p_org_id is null then raise exception 'Export organization is required'; end if;
  foreach v_table in array array[
    'closings',
    'closing_checklist_items',
    'lot_takedowns',
    'lot_reservations',
    'budgets',
    'budget_lines',
    'commitments',
    'commitment_lines',
    'change_orders',
    'file_links',
    'project_financial_settings',
    'divisions',
    'communities',
    'community_phases',
    'lots',
    'contracts',
    'cost_codes',
    'time_entries',
    'warranty_requests',
    'warranty_service_visits',
    'warranty_backcharges',
    'org_funding_sources',
    'disbursements',
    'payment_runs',
    'payment_run_items',
    'payment_run_fee_charges',
    'receivable_adjustments',
    'books_deposit_batches',
    'books_deposit_batch_items',
    'receivable_payment_groups',
    'receivable_payment_group_items',
    'books_tax_adjustment_workpapers',
    'books_payroll_imports',
    'books_payroll_payment_reviews',
    'books_payroll_posting_proposals',
    'books_payroll_postings',
    'books_payroll_labor_ownership',
    'books_payroll_correction_sources',
    'books_payroll_correction_proposals',
    'books_payroll_correction_postings',
    'books_overhead_budgets',
    'books_overhead_budget_lines',
    'books_legal_entities',
    'books_intercompany_sales',
    'books_settings',
    'accounting_policies',
    'accounting_account_mappings',
    'gl_accounts',
    'books_projection_receipts',
    'accounting_facts',
    'journal_entries',
    'journal_lines',
    'accounting_periods',
    'accounting_reconciliation_runs',
    'accounting_reconciliation_items',
    'poc_snapshots',
    'books_comparison_runs',
    'books_comparison_items',
    'opening_balance_batches',
    'opening_balance_lines',
    'opening_balance_approvals',
    'bank_accounts',
    'bank_transactions',
    'bank_transaction_details',
    'bank_receipts',
    'bank_transaction_revisions',
    'bank_transaction_matches',
    'bank_reconciliations',
    'bank_reconciliation_items',
    'bank_rules',
    'coding_rules',
    'books_debt_instruments',
    'books_debt_events',
    'books_fixed_assets',
    'books_fixed_asset_events',
    'books_tax_jurisdictions',
    'books_tax_filings',
    'books_greenfield_launches',
    'books_journal_proposals',
    'books_cutover_runs',
    'books_cutover_approvals',
    'books_close_items',
    'recurring_posting_templates',
    'recurring_posting_lines',
    'financial_statement_snapshots',
    'tax_policy_versions',
    'companies',
    'contacts',
    'projects',
    'invoices',
    'invoice_lines',
    'payments',
    'payment_allocations',
    'payment_reversals',
    'vendor_bills',
    'bill_lines',
    'project_expenses',
    'project_expense_lines',
    'job_cost_entries',
    'billable_costs',
    'retainage',
    'doc_versions',
    'files',
    'books_journal_request_resolutions',
    'audit_log'
  ] loop
    execute format('select coalesce(jsonb_agg((to_jsonb(t) || jsonb_build_object(''id'', t.id::text)) order by t.id), ''[]''::jsonb) from public.%I t where t.org_id = $1', v_table)
      into v_rows using p_org_id;
    v_tables := v_tables || jsonb_build_object(v_table, v_rows);
  end loop;
  -- Exact decimal quantities, so restore never round-trips them through a float.
  select coalesce(jsonb_agg(to_jsonb(r) || jsonb_build_object('id', r.id::text, 'quantity', to_jsonb(r)->>'quantity') order by r.id), '[]'::jsonb)
    into v_rows from public.invoice_lines r where r.org_id = p_org_id;
  v_tables := jsonb_set(v_tables, '{invoice_lines}', v_rows);
  return jsonb_build_object('orgId', p_org_id, 'capturedAt', statement_timestamp(),
    'databaseSnapshot', pg_current_snapshot()::text, 'tables', v_tables);
end;
$$;
revoke all on function public.capture_books_export_snapshot(uuid) from public, anon, authenticated;
grant execute on function public.capture_books_export_snapshot(uuid) to service_role;

-- The intercompany reconciliation: for each company and each affiliate, what it
-- is owed (1180) and what it owes (2180) on the ledger as of a date. A's net
-- position with B must equal B's opposite position with A.
create or replace function public.books_intercompany_positions(p_org_id uuid, p_as_of date)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('entityId', owner, 'counterpartyId', counterparty, 'dueFromCents', due_from, 'dueToCents', due_to) order by owner, counterparty), '[]'::jsonb)
  from (
    select l.legal_entity_id as owner, (l.dimensions ->> 'counterparty_entity_id')::uuid as counterparty,
      coalesce(sum(l.debit_cents - l.credit_cents) filter (where a.account_type = 'asset'), 0)::bigint as due_from,
      coalesce(sum(l.credit_cents - l.debit_cents) filter (where a.account_type = 'liability'), 0)::bigint as due_to
    from public.journal_lines l
    join public.journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
    join public.gl_accounts a on a.id = l.account_id and a.org_id = l.org_id
    where l.org_id = p_org_id and e.status in ('posted','reversed') and e.entry_date <= p_as_of
      and l.dimensions ->> 'intercompany' = 'true' and a.account_type in ('asset','liability')
    group by 1, 2
  ) positions;
$$;
revoke all on function public.books_intercompany_positions(uuid, date) from public, anon, authenticated;
grant execute on function public.books_intercompany_positions(uuid, date) to service_role;

-- ==== 20261008001000_books_company_opening_balances ====
-- B14.2: each company brings its own opening position. A batch names the company
-- it opens (empty: the primary company); lines with no job or owned account take
-- that company, and a batch whose lines resolve to more than one company is
-- refused rather than inventing intercompany balances at cutover.

alter table public.opening_balance_batches add column legal_entity_id uuid;
alter table public.opening_balance_batches add constraint opening_balance_batches_legal_entity_fkey
  foreign key (org_id, legal_entity_id) references public.books_legal_entities(org_id, id);
create index opening_balance_batches_legal_entity_idx on public.opening_balance_batches (org_id, legal_entity_id) where legal_entity_id is not null;

CREATE OR REPLACE FUNCTION public.post_books_opening_batch(p_org_id uuid, p_batch_id uuid, p_actor_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $$
declare batch public.opening_balance_batches%rowtype; item record; entity_id uuid; payment_id uuid; entity_kind text; customer uuid; amount bigint; document_number text; document_date date; due_date date; journal_id uuid; policy integer; lines jsonb; cash uuid; interest uuid; accumulated uuid; depreciation uuid; funding uuid; opening_asset_number text; existing_amount bigint;
begin
 select * into batch from public.opening_balance_batches where org_id=p_org_id and id=p_batch_id for update;
 if not found then raise exception 'Opening batch not found'; end if;
 if batch.status='posted' and batch.journal_entry_id is not null then return batch.journal_entry_id; end if;
 if batch.status<>'approved' or batch.digest is null or (select count(distinct approved_by) from public.opening_balance_approvals where org_id=p_org_id and batch_id=p_batch_id and approved_digest=batch.digest)<>2 then raise exception 'Opening batch requires owner and accountant approval'; end if;
 if batch.line_manifest_digest is null or batch.line_manifest_digest<>public.books_opening_manifest(p_org_id,p_batch_id) then raise exception 'Revalidate and reapprove this opening batch with the operational import contract'; end if;
 if (select count(*) from public.opening_balance_lines where org_id=p_org_id and batch_id=p_batch_id)<2 or (select sum(debit_cents-credit_cents) from public.opening_balance_lines where org_id=p_org_id and batch_id=p_batch_id)<>0 then raise exception 'Opening journal must balance'; end if;
 select active_policy_version into policy from public.books_settings where org_id=p_org_id and workspace_enabled and arc_ledger_mode<>'disabled';
 if not found then raise exception 'Books posting is not enabled'; end if;
 -- Cost records precede accumulated-depreciation lines regardless of CSV ordering.
 for item in select l.*,a.code,a.subtype from public.opening_balance_lines l join public.gl_accounts a on a.id=l.account_id and a.org_id=l.org_id where l.org_id=p_org_id and l.batch_id=p_batch_id order by case when a.subtype='fixed_assets' then 0 when a.subtype='accumulated_depreciation' then 2 else 1 end,l.line_no loop
   entity_id:=null; payment_id:=null; entity_kind:=null;
   if item.project_id is not null and not exists(select 1 from public.projects where org_id=p_org_id and id=item.project_id) then raise exception 'Opening project is outside the organization'; end if;
   if item.company_id is not null and not exists(select 1 from public.companies where org_id=p_org_id and id=item.company_id) then raise exception 'Opening company is outside the organization'; end if;
   document_number:=coalesce(nullif(item.details->>'document_number',''),nullif(item.source_entity_id,''),'OPEN-'||left(item.id::text,8));
   document_date:=coalesce((item.details->>'document_date')::date,batch.cutover_date);
   -- No due date stays no due date; aging shows it as such rather than as due at cutover.
   due_date:=(item.details->>'due_date')::date;
   if document_date>batch.cutover_date then raise exception 'Imported documents cannot originate after cutover'; end if;
   if item.details->>'existing_entity_id' is not null then entity_id:=(item.details->>'existing_entity_id')::uuid; end if;
   if item.subledger_type in('ar','deposit') then
     if (item.subledger_type='ar' and item.subtype not in('accounts_receivable','retainage_receivable')) or (item.subledger_type='deposit' and item.subtype<>'customer_deposits') then raise exception 'Receivable and deposit openings require their control accounts'; end if;
     amount:=case when item.subledger_type='ar' then item.debit_cents-item.credit_cents else item.credit_cents-item.debit_cents end;
     if amount<=0 then raise exception 'Import positive outstanding invoices or unapplied deposits; customer credits need a separate supported credit document'; end if;
     customer:=nullif(item.details->>'customer_id','')::uuid;
     if customer is null or not exists(select 1 from public.contacts where org_id=p_org_id and id=customer) then raise exception 'Opening line %: name the customer who owes this item', item.line_no; end if;
     if entity_id is null then
       if nullif(item.details->>'document_number','') is null and nullif(item.source_entity_id,'') is null then raise exception 'Opening line %: give the original invoice number', item.line_no; end if;
       if item.details->>'document_date' is null then raise exception 'Opening line %: give the original invoice date', item.line_no; end if;
       insert into public.invoices(org_id,project_id,invoice_number,title,status,issue_date,due_date,recipient_contact_id,subtotal_cents,total_cents,balance_due_cents,tax_cents,metadata)
       values(p_org_id,item.project_id,document_number,coalesce(item.description,'Imported outstanding balance'),'draft',document_date,due_date,customer,amount,amount,amount,0,jsonb_build_object('invoice_kind',case when item.subledger_type='deposit' then 'earnest_deposit' else 'standard' end,'opening_batch_id',batch.id,'customer_id',customer,'original_document',item.details)) returning id into entity_id;
       insert into public.invoice_lines(org_id,invoice_id,description,quantity,unit,unit_price_cents,metadata) values(p_org_id,entity_id,coalesce(item.description,'Imported outstanding balance'),1,'ea',amount,jsonb_build_object('opening_balance',true));
       update public.invoices set status='sent',subtotal_cents=amount,total_cents=amount,balance_due_cents=amount where org_id=p_org_id and id=entity_id;
     else
       select balance_due_cents into existing_amount from public.invoices where org_id=p_org_id and id=entity_id and recipient_contact_id=customer and project_id is not distinct from item.project_id and balance_due_cents=total_cents and status in('sent','overdue','partial');
       if not found or existing_amount<>amount then raise exception 'Existing invoice must match the exact imported outstanding balance and customer'; end if;
       if exists(select 1 from public.payments where org_id=p_org_id and invoice_id=entity_id and status in('succeeded','completed','paid')) then raise exception 'Previously paid invoice history must be imported as a residual open item'; end if;
     end if;
     entity_kind:=case when item.subledger_type='deposit' then 'deposit_invoice' else 'invoice' end;
     if exists(select 1 from public.accounting_facts where org_id=p_org_id and source_type='invoice' and source_id=entity_id) then raise exception 'An already projected invoice cannot also belong to an opening batch'; end if;
     if item.subtype='retainage_receivable' then
       if not exists(select 1 from public.contracts where org_id=p_org_id and id=nullif(item.details->>'contract_id','')::uuid and project_id=item.project_id) then raise exception 'Retained receivables require their project contract'; end if;
       if item.details->>'existing_entity_id' is not null then raise exception 'Import held retainage as a separate residual document'; end if;
       update public.invoice_lines set unit_price_cents=0 where org_id=p_org_id and invoice_id=entity_id;
       update public.invoices set subtotal_cents=0,total_cents=0,balance_due_cents=0 where org_id=p_org_id and id=entity_id;
       insert into public.retainage(org_id,project_id,contract_id,invoice_id,amount_cents,status,held_at,metadata) values(p_org_id,item.project_id,(item.details->>'contract_id')::uuid,entity_id,amount,'held',document_date::timestamptz,jsonb_build_object('opening_batch_id',batch.id));
     end if;
     if item.subledger_type='deposit' then
       insert into public.payments(org_id,invoice_id,amount_cents,status,method,received_at,metadata) values(p_org_id,entity_id,amount,'succeeded','imported',document_date::timestamptz,jsonb_build_object('opening_batch_id',batch.id)) returning id into payment_id;
       update public.invoices set balance_due_cents=0,status='paid' where org_id=p_org_id and id=entity_id;
     end if;
   elsif item.subledger_type='ap' then
     if item.subtype not in('accounts_payable','retainage_payable') then raise exception 'AP open items require the accounts-payable control account'; end if;
     amount:=item.credit_cents-item.debit_cents;
     if amount<=0 or item.company_id is null or item.project_id is null then raise exception 'AP openings require a positive unpaid balance, vendor and project'; end if;
     if entity_id is null then
       if nullif(item.details->>'document_number','') is null and nullif(item.source_entity_id,'') is null then raise exception 'Opening line %: give the vendor''s bill number', item.line_no; end if;
       if item.details->>'document_date' is null then raise exception 'Opening line %: give the original bill date', item.line_no; end if;
       insert into public.vendor_bills(org_id,project_id,company_id,bill_number,bill_date,due_date,total_cents,paid_cents,retainage_cents,status,metadata)
       values(p_org_id,item.project_id,item.company_id,document_number,document_date,due_date,amount,0,0,'approved',jsonb_build_object('opening_batch_id',batch.id,'original_document',item.details)) returning id into entity_id;
       insert into public.bill_lines(org_id,bill_id,description,quantity,unit_cost_cents) values(p_org_id,entity_id,coalesce(item.description,'Imported unpaid balance'),1,amount);
     else
       select total_cents into existing_amount from public.vendor_bills where org_id=p_org_id and id=entity_id and company_id=item.company_id and project_id=item.project_id and paid_cents=0 and coalesce(retainage_cents,0)=0 and status in('approved','payable');
       if not found or existing_amount<>amount then raise exception 'Existing payable must match the imported unpaid amount, vendor and project'; end if;
     end if;
     if item.subtype='retainage_payable' then
       if item.details->>'existing_entity_id' is not null then raise exception 'Import held payable retainage as a separate residual document'; end if;
       update public.vendor_bills set retainage_cents=amount where org_id=p_org_id and id=entity_id;
     end if;
     entity_kind:='vendor_bill';
     if exists(select 1 from public.accounting_facts where org_id=p_org_id and source_type='vendor_bill' and source_id=entity_id) then raise exception 'An already projected payable cannot also belong to an opening batch'; end if;
   elsif item.subledger_type in('bank','credit_card') then
     if entity_id is null then raise exception 'Create or select the native bank/card account before importing its opening balance'; end if;
     if not exists(select 1 from public.bank_accounts where org_id=p_org_id and id=entity_id and gl_account_id=item.account_id) then raise exception 'Opening bank/card account must map to this control account'; end if;
     entity_kind:='bank_account';
     -- A check or deposit uncleared at cutover rides on the account's opening as
     -- its own line; the statement-balance line remains the account's one owner.
     if item.details->>'bank_opening_role'='outstanding_item' then
       if nullif(btrim(item.details->>'reference'),'') is null then raise exception 'An outstanding bank item needs its check or deposit reference'; end if;
       entity_id:=null; entity_kind:=null;
     elsif item.details ? 'bank_opening_role' then raise exception 'Unknown bank opening role';
     end if;
   elsif item.subledger_type='loan' then
     amount:=item.credit_cents-item.debit_cents;
     if amount<=0 or item.subtype not in('current_debt','long_term_debt') then raise exception 'Loan opening must credit a debt account'; end if;
     if entity_id is null then
       cash:=nullif(item.details->>'cash_account_id','')::uuid; interest:=nullif(item.details->>'interest_account_id','')::uuid;
       if not exists(select 1 from public.gl_accounts where org_id=p_org_id and id=cash and subtype='cash' and active) or not exists(select 1 from public.gl_accounts where org_id=p_org_id and id=interest and subtype='interest' and active) then raise exception 'Select the native repayment bank and interest accounts for the loan'; end if;
       insert into public.books_debt_instruments(org_id,name,liability_account_id,cash_account_id,interest_expense_account_id,opened_on,maturity_on,original_principal_cents,annual_interest_bps,payment_frequency,created_by)
       values(p_org_id,coalesce(item.description,document_number),item.account_id,cash,interest,document_date,(item.details->>'maturity_on')::date,amount,coalesce((item.details->>'annual_interest_bps')::integer,0),coalesce(item.details->>'payment_frequency','monthly'),p_actor_id) returning id into entity_id;
     else
       if not exists(select 1 from public.books_debt_instruments where org_id=p_org_id and id=entity_id and liability_account_id=item.account_id and original_principal_cents=amount) or exists(select 1 from public.books_debt_events where org_id=p_org_id and instrument_id=entity_id) then raise exception 'Opening loan must match a register with no posted history'; end if;
     end if;
     entity_kind:='debt_instrument';
   elsif item.subledger_type='fixed_asset' then
     opening_asset_number:=coalesce(nullif(item.details->>'asset_number',''),document_number);
     if item.subtype='fixed_assets' then
       amount:=item.debit_cents-item.credit_cents;
       if amount<=0 then raise exception 'Asset cost opening must be a debit'; end if;
       if entity_id is null then
         accumulated:=nullif(item.details->>'accumulated_depreciation_account_id','')::uuid; depreciation:=nullif(item.details->>'depreciation_expense_account_id','')::uuid; funding:=nullif(item.details->>'funding_account_id','')::uuid;
         if not exists(select 1 from public.gl_accounts where org_id=p_org_id and id=accumulated and subtype='accumulated_depreciation') or not exists(select 1 from public.gl_accounts where org_id=p_org_id and id=depreciation and subtype='depreciation') or not exists(select 1 from public.gl_accounts where org_id=p_org_id and id=funding and subtype in('cash','accounts_payable','current_debt','long_term_debt','owner_contributions','owner_equity')) then raise exception 'Asset register accounts must belong to this organization and match their roles'; end if;
         insert into public.books_fixed_assets(org_id,asset_number,name,project_id,placed_in_service_on,acquisition_cost_cents,salvage_value_cents,useful_life_months,asset_account_id,accumulated_depreciation_account_id,depreciation_expense_account_id,funding_account_id,opening_as_of,created_by)
         values(p_org_id,opening_asset_number,coalesce(item.description,opening_asset_number),item.project_id,coalesce((item.details->>'placed_in_service_on')::date,document_date),amount,coalesce((item.details->>'salvage_value_cents')::bigint,0),(item.details->>'useful_life_months')::integer,item.account_id,accumulated,depreciation,funding,batch.cutover_date,p_actor_id) returning id into entity_id;
       else
         if not exists(select 1 from public.books_fixed_assets where org_id=p_org_id and id=entity_id and acquisition_cost_cents=amount and asset_account_id=item.account_id) or exists(select 1 from public.books_fixed_asset_events where org_id=p_org_id and asset_id=entity_id) then raise exception 'Opening asset must match a register with no posted history'; end if;
         update public.books_fixed_assets set opening_as_of=batch.cutover_date where org_id=p_org_id and id=entity_id;
       end if;
       entity_kind:='fixed_asset';
     elsif item.subtype='accumulated_depreciation' then
       amount:=item.credit_cents-item.debit_cents;
       if amount<=0 then raise exception 'Accumulated depreciation opening must be a credit'; end if;
       if entity_id is null then select id into entity_id from public.books_fixed_assets a where a.org_id=p_org_id and a.asset_number=opening_asset_number; end if;
       if entity_id is null or not exists(select 1 from public.opening_balance_lines where org_id=p_org_id and batch_id=p_batch_id and operational_entity_type='fixed_asset' and operational_entity_id=entity_id) then raise exception 'Import this asset cost in the same batch before its accumulated depreciation'; end if;
       if not exists(select 1 from public.books_fixed_assets where org_id=p_org_id and id=entity_id and accumulated_depreciation_account_id=item.account_id and acquisition_cost_cents-salvage_value_cents>=amount) then raise exception 'Accumulated depreciation exceeds depreciable cost or uses the wrong account'; end if;
       update public.books_fixed_assets set opening_accumulated_depreciation_cents=amount where org_id=p_org_id and id=entity_id;
       entity_kind:='fixed_asset_depreciation';
     else raise exception 'Fixed-asset opening requires cost or accumulated-depreciation accounts'; end if;
   elsif item.subtype in('cash','credit_card','accounts_receivable','accounts_payable','customer_deposits','current_debt','long_term_debt','fixed_assets','accumulated_depreciation','retainage_receivable','retainage_payable') then
     raise exception 'Control accounts require an operational opening subledger type';
   end if;
   if entity_id is not null then
     update public.opening_balance_lines set operational_entity_type=entity_kind,operational_entity_id=entity_id,operational_payment_id=payment_id where org_id=p_org_id and id=item.id;
   end if;
 end loop;
 select jsonb_agg(jsonb_build_object('line_no',line_no,'account_id',account_id,'project_id',project_id,'company_id',company_id,'description',description,'debit_cents',debit_cents,'credit_cents',credit_cents,'dimensions',details||jsonb_build_object('opening_line_id',id)) order by line_no) into lines from public.opening_balance_lines where org_id=p_org_id and batch_id=p_batch_id;
 journal_id:=public.post_books_journal_entry(p_org_id,jsonb_build_object('entry_date',batch.cutover_date,'entry_kind','opening','memo','Opening balances at '||batch.cutover_date,'posting_key','opening:'||batch.id||':'||batch.digest,'projection_version',1,'policy_version',policy,'source_type','opening_balance_batch','source_id',batch.id,'created_by',p_actor_id,'legal_entity_id',batch.legal_entity_id),lines);
 -- One company's opening position at a time: lines that resolve to another
 -- company (its job, its account) would invent what the companies owe each other.
 if exists(select 1 from public.journal_lines where org_id=p_org_id and entry_id=journal_id and dimensions->>'intercompany'='true') then
   raise exception 'These opening lines belong to more than one company; post each company''s opening position as its own batch';
 end if;
 update public.opening_balance_batches set status='posted',journal_entry_id=journal_id,posted_at=now(),updated_at=now() where org_id=p_org_id and id=p_batch_id;
 return journal_id;
end;
$$;

-- Which company paid: the owner of the cash, bank or card line on a payment's,
-- reversal's or expense's posted entry. Each company files its own 1099s.
create or replace function public.books_cash_source_companies(p_org_id uuid, p_start date, p_end date)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('sourceId', source_id, 'legalEntityId', legal_entity_id)), '[]'::jsonb)
  from (
    select distinct e.source_id, l.legal_entity_id
    from public.journal_entries e
    join public.journal_lines l on l.entry_id = e.id and l.org_id = e.org_id
    join public.gl_accounts a on a.id = l.account_id and a.org_id = l.org_id
    where e.org_id = p_org_id and e.status in ('posted','reversed') and e.entry_date between p_start and p_end
      and e.source_type in ('bill_payment','expense','payment_reversal')
      and a.subtype in ('cash','undeposited_funds','credit_card')
  ) paid;
$$;
revoke all on function public.books_cash_source_companies(uuid, date, date) from public, anon, authenticated;
grant execute on function public.books_cash_source_companies(uuid, date, date) to service_role;
