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
      -- tagged with a job: the money moved through that company's account.
      (select a.legal_entity_id from public.gl_accounts a where a.org_id = p_org_id and a.id = (line_row ->> 'account_id')::uuid),
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
        insert into public.gl_accounts(org_id, code, name, account_type, subtype, normal_balance, cash_flow_category, is_system, active) values
          (p_org_id, '1180', 'Due from affiliates', 'asset', 'other_asset', 'debit', 'operating', true, true),
          (p_org_id, '2180', 'Due to affiliates', 'liability', 'other_liability', 'credit', 'operating', true, true)
          on conflict (org_id, code) do nothing;
        select id into v_due_from from public.gl_accounts where org_id = p_org_id and code = '1180' and account_type = 'asset' and active;
        select id into v_due_to from public.gl_accounts where org_id = p_org_id and code = '2180' and account_type = 'liability' and active;
        if v_due_from is null or v_due_to is null then raise exception 'Accounts 1180/2180 conflict with the organization chart'; end if;
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
