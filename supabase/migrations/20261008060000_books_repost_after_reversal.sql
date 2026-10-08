-- B15.4: repairing what the ledger proof finds. A bookkeeper reverses a source's
-- entry that no longer matches its source; the projector then posts the source
-- again. The reversed entry keeps the original posting key, so the repost takes
-- the next `:repost:N` key instead of returning the reversed entry as done.

create or replace function public.project_books_fact_and_journal_atomic(
  p_org_id uuid,
  p_expected_fact_id uuid,
  p_fact jsonb,
  p_entry jsonb,
  p_lines jsonb,
  p_reversal_date date,
  p_reversal_reason text
) returns jsonb
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  latest_fact public.accounting_facts%rowtype;
  projected_fact_id uuid;
  projected_journal_id uuid;
  prior_entry record;
  reversal_entry jsonb;
  reversal_lines jsonb;
  resolved_reversal_date date;
  created boolean := false;
  superseded boolean := false;
  journal_created boolean := false;
  v_posting_key text;
  v_reposts integer;
begin
  if jsonb_typeof(p_fact) <> 'object' or jsonb_typeof(p_entry) <> 'object'
    or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'Projection requires fact, entry and line payloads';
  end if;

  -- One projector may revise a source at a time, even when both workers read the
  -- same prior version before entering this function.
  perform pg_advisory_xact_lock(hashtextextended(
    p_org_id::text || ':' || (p_fact ->> 'source_type') || ':' || (p_fact ->> 'source_id'),
    0
  ));

  select * into latest_fact
  from public.accounting_facts
  where org_id = p_org_id
    and source_type = p_fact ->> 'source_type'
    and source_id = (p_fact ->> 'source_id')::uuid
  order by source_version desc
  limit 1
  for update;

  if latest_fact.id is not null and latest_fact.payload_hash = p_fact ->> 'payload_hash' then
    projected_fact_id := latest_fact.id;
  else
    if latest_fact.id is distinct from p_expected_fact_id then
      raise exception 'Projection source changed concurrently; retry from the latest fact';
    end if;

    if latest_fact.id is not null then
      superseded := true;
      for prior_entry in
        select entry.*, period.status as period_status
        from public.journal_entries entry
        left join public.accounting_periods period on period.id = entry.period_id
        where entry.org_id = p_org_id
          and entry.fact_id = latest_fact.id
          and entry.status = 'posted'
        order by entry.created_at
      loop
        resolved_reversal_date := case
          when prior_entry.period_status = 'closed' then p_reversal_date
          else prior_entry.entry_date
        end;
        select jsonb_agg(jsonb_build_object(
          'line_no', line.line_no,
          'account_id', line.account_id,
          'project_id', line.project_id,
          'company_id', line.company_id,
          'description', line.description,
          'debit_cents', line.credit_cents,
          'credit_cents', line.debit_cents,
          'dimensions', line.dimensions
        ) order by line.line_no)
        into reversal_lines
        from public.journal_lines line
        where line.org_id = p_org_id and line.entry_id = prior_entry.id;

        reversal_entry := jsonb_build_object(
          'fact_id', null,
          'entry_date', resolved_reversal_date,
          'entry_kind', 'reversal',
          'memo', 'Reversal of ' || prior_entry.memo || ': ' || p_reversal_reason,
          'posting_key', 'reversal:' || prior_entry.id || ':' || md5(resolved_reversal_date::text || ':' || p_reversal_reason),
          'projection_version', prior_entry.projection_version,
          'policy_version', prior_entry.policy_version,
          'source_type', null,
          'source_id', null,
          'reversal_of_entry_id', prior_entry.id,
          'created_by', null
        );
        perform public.reverse_books_journal_entry(
          p_org_id,
          prior_entry.id,
          reversal_entry,
          coalesce(reversal_lines, '[]'::jsonb)
        );
      end loop;
    end if;

    insert into public.accounting_facts (
      org_id, source_type, source_id, source_version, fact_kind, occurred_at,
      accounting_date, payload, payload_hash, policy_version,
      supersedes_fact_id, idempotency_key, created_by
    ) values (
      p_org_id,
      p_fact ->> 'source_type',
      (p_fact ->> 'source_id')::uuid,
      (p_fact ->> 'source_version')::integer,
      p_fact ->> 'fact_kind',
      (p_fact ->> 'occurred_at')::timestamptz,
      (p_fact ->> 'accounting_date')::date,
      p_fact -> 'payload',
      p_fact ->> 'payload_hash',
      (p_fact ->> 'policy_version')::integer,
      latest_fact.id,
      p_fact ->> 'idempotency_key',
      nullif(p_fact ->> 'created_by', '')::uuid
    )
    returning id into projected_fact_id;
    created := true;
  end if;

  select entry.id into projected_journal_id
  from public.journal_entries entry
  where entry.org_id = p_org_id and entry.fact_id = projected_fact_id and entry.status = 'posted'
  order by created_at desc
  limit 1;
  if projected_journal_id is null then
    -- The source's entry was reversed while its fact still stands (a bookkeeper
    -- reversing an entry the ledger proof found wrong): post it again under the
    -- next repost key, since the reversed entry keeps the original one.
    v_posting_key := p_entry ->> 'posting_key';
    if exists (select 1 from public.journal_entries where org_id = p_org_id and journal_entries.posting_key = p_entry ->> 'posting_key' and status = 'reversed') then
      select count(*) into v_reposts from public.journal_entries
       where org_id = p_org_id and journal_entries.posting_key like (p_entry ->> 'posting_key') || ':repost:%';
      v_posting_key := (p_entry ->> 'posting_key') || ':repost:' || (v_reposts + 1);
    end if;
    projected_journal_id := public.post_books_journal_entry(
      p_org_id,
      jsonb_set(jsonb_set(p_entry, '{fact_id}', to_jsonb(projected_fact_id::text), true), '{posting_key}', to_jsonb(v_posting_key), true),
      p_lines
    );
    journal_created := true;
  end if;

  return jsonb_build_object(
    'fact_id', projected_fact_id,
    'journal_id', projected_journal_id,
    'created', created,
    'journal_created', journal_created,
    'superseded', superseded,
    'source_version', (select source_version from public.accounting_facts where id = projected_fact_id)
  );
end;
$$;

