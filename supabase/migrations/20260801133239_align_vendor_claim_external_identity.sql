-- Align vendor claims with the global external-identity model. Production was
-- already carrying the new column name, while a fresh migration replay still
-- inherited the old external_portal_account_id name from the payment
-- foundation migration.
set lock_timeout = '5s';

do $migration$
begin
  if exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'vendor_company_claims'
      and column_name = 'external_portal_account_id'
  ) and not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'vendor_company_claims'
      and column_name = 'external_identity_id'
  ) then
    execute 'alter table public.vendor_company_claims rename column external_portal_account_id to external_identity_id';
  end if;

  if not exists (
    select 1
    from information_schema.columns
    where table_schema = 'public'
      and table_name = 'vendor_company_claims'
      and column_name = 'external_identity_id'
  ) then
    raise exception 'vendor_company_claims.external_identity_id is required';
  end if;
end
$migration$;

-- The old trigger checked an org-scoped external_portal_accounts row. External
-- identities are now global, so org authorization belongs to the exact active
-- grant used to create the claim. The grant check runs when that binding is
-- created or changed; an already-verified claim remains valid after its invite
-- naturally expires.
create or replace function public.enforce_vendor_claim_integrity()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  company_org uuid;
  account_identity uuid;
begin
  select org_id into company_org
  from public.companies
  where id = new.company_id;

  if company_org is distinct from new.org_id then
    raise exception 'Vendor claim company must belong to the claim organization';
  end if;

  if new.external_identity_id is not null then
    select vendor_identity_id into account_identity
    from public.external_identities
    where id = new.external_identity_id;

    if not found then
      raise exception 'Vendor claim external identity does not exist';
    end if;

    if account_identity is distinct from new.claimed_by_identity_id then
      raise exception 'Vendor claim external identity must be linked to the claiming identity';
    end if;

    if tg_op = 'INSERT'
       or new.external_identity_id is distinct from old.external_identity_id
       or new.source_portal_token_id is distinct from old.source_portal_token_id
       or new.org_id is distinct from old.org_id
       or new.company_id is distinct from old.company_id then
      if not exists (
        select 1
        from public.external_identity_grants grant_row
        join public.portal_access_tokens portal_token
          on portal_token.id = grant_row.portal_access_token_id
        where grant_row.identity_id = new.external_identity_id
          and grant_row.org_id = new.org_id
          and grant_row.portal_access_token_id = new.source_portal_token_id
          and grant_row.status = 'active'
          and grant_row.paused_at is null
          and grant_row.revoked_at is null
          and portal_token.org_id = new.org_id
          and portal_token.company_id = new.company_id
          and portal_token.portal_type = 'sub'
          and portal_token.paused_at is null
          and portal_token.revoked_at is null
          and (portal_token.expires_at is null or portal_token.expires_at > now())
      ) then
        raise exception 'Vendor claim requires an active grant for this invitation';
      end if;
    end if;
  end if;

  return new;
end;
$$;
