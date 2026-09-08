-- Keep the greenfield launch atomic path executable in Supabase, where
-- pgcrypto is installed in `extensions`, and persist the launching actor.

create or replace function public.launch_books_greenfield_atomic(
  p_org_id uuid,
  p_actor_id uuid,
  p_launched_on date,
  p_opening_position text,
  p_attestation text
) returns uuid
language plpgsql
security definer
set search_path = public, pg_catalog, extensions
as $$
declare
  launch_id uuid;
  digest text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':greenfield-launch', 0));
  if p_attestation <> 'I confirm Arc Books contains the complete opening position and will be the sole accounting ledger.' then
    raise exception 'The greenfield launch attestation does not match';
  end if;
  if p_opening_position not in ('zero','posted_opening_balances') then raise exception 'Invalid opening position'; end if;
  if exists (select 1 from public.accounting_connections where org_id = p_org_id and status = 'active') then
    raise exception 'Greenfield launch is unavailable while an external accounting connection is active';
  end if;
  if exists (select 1 from public.bank_accounts where org_id = p_org_id and active and gl_account_id is null) then
    raise exception 'Every active bank account must be mapped to the chart';
  end if;
  if exists (select 1 from public.journal_entries where org_id = p_org_id and status = 'draft') then
    raise exception 'Draft journals must be resolved before launch';
  end if;
  if p_opening_position = 'posted_opening_balances' and not exists (
    select 1 from public.opening_balance_batches where org_id = p_org_id and status = 'posted'
  ) then raise exception 'A posted opening-balance batch is required'; end if;
  if p_opening_position = 'zero' and exists (
    select 1 from public.opening_balance_batches where org_id = p_org_id and status = 'posted'
  ) then raise exception 'Choose posted opening balances for this organization'; end if;
  if not exists (select 1 from public.accounting_periods where org_id = p_org_id and p_launched_on between period_start and period_end) then
    raise exception 'An accounting period must cover the launch date';
  end if;

  digest := encode(extensions.digest(p_org_id::text || ':' || p_actor_id::text || ':' || p_launched_on::text || ':' || p_opening_position, 'sha256'), 'hex');
  insert into public.books_greenfield_launches (org_id, launched_on, opening_position, attestation, launch_digest, launched_by)
  values (p_org_id, p_launched_on, p_opening_position, p_attestation, digest, p_actor_id)
  returning id into launch_id;
  update public.books_settings
  set ledger_authority = 'arc', arc_ledger_mode = 'official', external_sync_posture = 'disconnected',
      authoritative_at = now(), authoritative_by = p_actor_id, updated_by = p_actor_id, updated_at = now()
  where org_id = p_org_id and ledger_authority = 'external';
  if not found then raise exception 'Arc Books must be initialized in external/shadow posture before greenfield launch'; end if;
  return launch_id;
end;
$$;
