-- Durable, org-scoped AI coding assessments. A completed row with nullable
-- suggestions is an intentional abstention and prevents repeated model work.
create table public.bank_transaction_ai_suggestions (
  transaction_id uuid primary key references public.bank_transactions(id) on delete cascade,
  org_id uuid not null references public.orgs(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','completed','failed')),
  suggested_gl_account_id uuid references public.gl_accounts(id) on delete set null,
  suggested_vendor_id uuid references public.companies(id) on delete set null,
  confidence numeric(4,3) check (confidence between 0 and 1),
  rationale text,
  attempt_count integer not null default 0 check (attempt_count between 0 and 3),
  claim_token uuid,
  lease_expires_at timestamptz,
  model_provider text,
  model_id text,
  assessed_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index bank_transaction_ai_suggestions_org_status_idx
  on public.bank_transaction_ai_suggestions (org_id, status, updated_at);

create trigger bank_transaction_ai_suggestions_set_updated_at
  before update on public.bank_transaction_ai_suggestions
  for each row execute function public.tg_set_updated_at();

alter table public.bank_transaction_ai_suggestions enable row level security;
revoke all on public.bank_transaction_ai_suggestions from anon, authenticated;
grant all on public.bank_transaction_ai_suggestions to service_role;

-- Claim only transactions that still need a human decision and have no saved
-- draft. The row lock and claim token make overlapping webhook/manual syncs safe.
create function public.claim_bank_transaction_ai_suggestions(
  p_org_id uuid,
  p_transaction_ids uuid[],
  p_claim_token uuid,
  p_limit integer default 20
)
returns table (
  transaction_id uuid,
  bank_account_id uuid,
  transaction_date date,
  amount_cents bigint,
  direction text,
  merchant_name text,
  description text
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_limit not between 1 and 20 then raise exception 'AI bank suggestion claim limit must be 1 to 20'; end if;

  insert into public.bank_transaction_ai_suggestions (transaction_id, org_id)
  select t.id, t.org_id
  from public.bank_transactions t
  where t.org_id = p_org_id and t.id = any(p_transaction_ids)
  on conflict on constraint bank_transaction_ai_suggestions_pkey do nothing;

  update public.bank_transaction_ai_suggestions s
  set status = 'completed', assessed_at = now(), rationale = 'no_longer_eligible', updated_at = now()
  where s.org_id = p_org_id and s.transaction_id = any(p_transaction_ids)
    and s.status <> 'completed'
    and exists (
      select 1 from public.bank_transactions t
      left join public.bank_transaction_details d on d.transaction_id = t.id and d.org_id = t.org_id
      where t.id = s.transaction_id and t.org_id = s.org_id
        and (t.lifecycle_status <> 'posted' or t.excluded
          or jsonb_path_exists(coalesce(d.coding, '{}'::jsonb), '$.lines[*] ? (@.accountId != null)')
          or coalesce(jsonb_array_length(d.coding->'lines'), 0) > 1
          or exists (select 1 from public.bank_transaction_matches m
            where m.org_id = t.org_id and m.bank_transaction_id = t.id and m.status = 'confirmed'))
    );

  return query
  with claimable as (
    select s.transaction_id
    from public.bank_transaction_ai_suggestions s
    join public.bank_transactions t on t.id = s.transaction_id and t.org_id = s.org_id
    left join public.bank_transaction_details d on d.transaction_id = t.id and d.org_id = t.org_id
    where s.org_id = p_org_id
      and s.transaction_id = any(p_transaction_ids)
      and s.attempt_count < 3
      and ((s.status = 'failed' and s.updated_at < now() - interval '5 minutes')
        or (s.status = 'pending' and (s.lease_expires_at is null or s.lease_expires_at < now())))
      and t.lifecycle_status = 'posted'
      and not t.excluded
      and not jsonb_path_exists(coalesce(d.coding, '{}'::jsonb), '$.lines[*] ? (@.accountId != null)')
      and coalesce(jsonb_array_length(d.coding->'lines'), 0) <= 1
      and not exists (
        select 1 from public.bank_transaction_matches m
        where m.org_id = t.org_id and m.bank_transaction_id = t.id and m.status = 'confirmed'
      )
    order by t.transaction_date, t.id
    for update of s skip locked
    limit p_limit
  ), updated as (
    update public.bank_transaction_ai_suggestions s
    set status = 'pending', claim_token = p_claim_token,
        lease_expires_at = now() + interval '2 minutes',
        attempt_count = s.attempt_count + 1, last_error = null, updated_at = now()
    from claimable c
    where s.transaction_id = c.transaction_id
    returning s.transaction_id
  )
  select t.id, t.bank_account_id, t.transaction_date, t.amount_cents,
         t.direction::text, t.merchant_name, t.description
  from updated u
  join public.bank_transactions t on t.id = u.transaction_id and t.org_id = p_org_id;
end;
$$;

revoke all on function public.claim_bank_transaction_ai_suggestions(uuid,uuid[],uuid,integer) from public,anon,authenticated;
grant execute on function public.claim_bank_transaction_ai_suggestions(uuid,uuid[],uuid,integer) to service_role;

create function public.release_bank_transaction_ai_suggestion_claim(
  p_org_id uuid,
  p_claim_token uuid,
  p_error text,
  p_without_penalty boolean default false
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.bank_transaction_ai_suggestions
  set status = case when p_without_penalty then 'pending' else 'failed' end,
      attempt_count = case when p_without_penalty then greatest(attempt_count - 1, 0) else attempt_count end,
      claim_token = null, lease_expires_at = null, last_error = left(p_error, 1000), updated_at = now()
  where org_id = p_org_id and claim_token = p_claim_token and status = 'pending';
end;
$$;
revoke all on function public.release_bank_transaction_ai_suggestion_claim(uuid,uuid,text,boolean) from public,anon,authenticated;
grant execute on function public.release_bank_transaction_ai_suggestion_claim(uuid,uuid,text,boolean) to service_role;

-- Existing review work enters the same durable queue. Learned rules are removed
-- from it by the worker without a model call.
insert into public.bank_transaction_ai_suggestions (transaction_id, org_id)
select t.id, t.org_id
from public.bank_transactions t
where t.lifecycle_status = 'posted' and not t.excluded
  and not exists (
    select 1 from public.bank_transaction_matches m
    where m.org_id = t.org_id and m.bank_transaction_id = t.id and m.status = 'confirmed'
  )
  and not exists (
    select 1 from public.bank_transaction_details d
    where d.org_id = t.org_id and d.transaction_id = t.id
      and (jsonb_path_exists(coalesce(d.coding, '{}'::jsonb), '$.lines[*] ? (@.accountId != null)')
        or coalesce(jsonb_array_length(d.coding->'lines'), 0) > 1)
  )
on conflict (transaction_id) do nothing;
