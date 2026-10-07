-- Ledger and job-cost totals for the month-end review, summed in the database.
--
-- The close checklist, the close snapshot and the as-of statements loaded every
-- posted journal entry and line since the company began, several times per
-- review, and summed them in the application: the review's cost grew with the
-- whole history (18,160 rows for 1,200 bills in CAP-01). These return one row
-- per account, project and contract, and one job-cost total, so the review reads
-- what the chart and the jobs need.
--
-- A reversed entry and its reversal both count, as in the application loader,
-- and net to zero. Service role only: they take an organization id.

create or replace function public.books_ledger_balances(p_org_id uuid, p_as_of date)
returns table (
  account_id uuid,
  project_id uuid,
  contract_id text,
  warranty_reserve_adjustment boolean,
  debit_cents bigint,
  credit_cents bigint
)
language sql stable security invoker set search_path = pg_catalog, public as $$
  select line.account_id,
    line.project_id,
    line.dimensions ->> 'contract_id',
    coalesce(line.dimensions ->> 'warranty_reserve_adjustment' = 'true', false),
    sum(line.debit_cents)::bigint,
    sum(line.credit_cents)::bigint
  from public.journal_lines line
  join public.journal_entries entry on entry.id = line.entry_id and entry.org_id = line.org_id
  where line.org_id = p_org_id
    and entry.org_id = p_org_id
    and entry.status in ('posted', 'reversed')
    and entry.entry_date <= p_as_of
  group by 1, 2, 3, 4
$$;
revoke all on function public.books_ledger_balances(uuid, date) from public, anon, authenticated;
grant execute on function public.books_ledger_balances(uuid, date) to service_role;

create or replace function public.books_job_cost_subledger_cents(p_org_id uuid, p_as_of date)
returns bigint
language sql stable security invoker set search_path = pg_catalog, public as $$
  select coalesce(sum(cost_cents), 0)::bigint
  from public.job_cost_entries
  where org_id = p_org_id and status = 'posted' and incurred_on <= p_as_of
$$;
revoke all on function public.books_job_cost_subledger_cents(uuid, date) from public, anon, authenticated;
grant execute on function public.books_job_cost_subledger_cents(uuid, date) to service_role;

-- Clearing accounts at period end: each account's net and a fingerprint of the
-- lines behind it, so a saved clearing review is invalidated by any change to
-- those lines without the review reading every clearing line since inception.
create or replace function public.books_account_positions(p_org_id uuid, p_as_of date, p_codes text[])
returns table (code text, debit_cents bigint, credit_cents bigint, line_count bigint, lines_digest text)
language sql stable security invoker set search_path = pg_catalog, public as $$
  select account.code,
    coalesce(sum(line.debit_cents), 0)::bigint,
    coalesce(sum(line.credit_cents), 0)::bigint,
    count(line.id),
    md5(coalesce(string_agg(line.id::text || ':' || line.entry_id::text || ':' || line.debit_cents || ':' || line.credit_cents, ',' order by line.id), ''))
  from public.gl_accounts account
  join public.journal_lines line on line.org_id = account.org_id and line.account_id = account.id
  join public.journal_entries entry on entry.id = line.entry_id and entry.org_id = line.org_id
  where account.org_id = p_org_id
    and account.code = any(p_codes)
    and entry.status in ('posted', 'reversed')
    and entry.entry_date <= p_as_of
  group by account.code
$$;
revoke all on function public.books_account_positions(uuid, date, text[]) from public, anon, authenticated;
grant execute on function public.books_account_positions(uuid, date, text[]) to service_role;

-- Which of these projects carry posted job cost by a date: the WIP review needs
-- only that a job has cost, not every cost line it has ever had.
create or replace function public.books_projects_with_posted_cost(p_org_id uuid, p_as_of date, p_project_ids uuid[])
returns setof uuid
language sql stable security invoker set search_path = pg_catalog, public as $$
  select project.id
  from unnest(p_project_ids) as project(id)
  where exists (
    select 1 from public.job_cost_entries cost
    where cost.org_id = p_org_id and cost.project_id = project.id and cost.status = 'posted' and cost.incurred_on <= p_as_of
  )
$$;
revoke all on function public.books_projects_with_posted_cost(uuid, date, uuid[]) from public, anon, authenticated;
grant execute on function public.books_projects_with_posted_cost(uuid, date, uuid[]) to service_role;

-- A ledger proof is either the full rebuild drill or the narrowed proof of what
-- changed since a time. The nightly job runs the narrowed proof and a full drill
-- weekly, so a run records which it was.
alter table public.ledger_rebuild_runs
  add column scope text not null default 'full' check (scope in ('full', 'changed_since')),
  add column changed_since timestamptz,
  add constraint ledger_rebuild_runs_scope_since check ((scope = 'changed_since') = (changed_since is not null));
create index if not exists ledger_rebuild_runs_org_scope_started_idx on public.ledger_rebuild_runs (org_id, scope, started_at desc);
