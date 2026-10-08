-- 1099 filing packages (B05.2). One paying company's frozen, reviewed list of
-- payees and amounts for one tax year, the filing-partner handoff and its outcome.
-- Full taxpayer IDs never leave Vault except into the filing file of an approved
-- package, built here and handed only to the service.
begin;

-- The paying company's own identity, printed on every 1099 it files.
alter table public.books_legal_entities
  add column payer_tin_last4 text check (payer_tin_last4 is null or payer_tin_last4 ~ '^[0-9]{4}$'),
  add column payer_tin_secret_id uuid,
  add column payer_address jsonb check (payer_address is null or jsonb_typeof(payer_address) = 'object');

create or replace function public.store_legal_entity_payer_tin_atomic(p_org_id uuid, p_legal_entity_id uuid, p_tin text, p_actor_id uuid)
returns text language plpgsql security definer set search_path = public, vault, pg_catalog as $$
declare v_secret uuid;
begin
  if p_tin !~ '^[0-9]{9}$' then raise exception 'A US taxpayer ID must contain exactly nine digits'; end if;
  if not exists (select 1 from public.memberships where org_id = p_org_id and user_id = p_actor_id and status = 'active') then raise exception 'Only an active member can record the payer TIN'; end if;
  select payer_tin_secret_id into v_secret from public.books_legal_entities where org_id = p_org_id and id = p_legal_entity_id for update;
  if not found then raise exception 'Company not found'; end if;
  if v_secret is null then
    v_secret := vault.create_secret(p_tin, 'payer-tin-' || p_legal_entity_id::text, 'Arc Books payer taxpayer identity; legal entity ' || p_legal_entity_id::text);
  else
    perform vault.update_secret(v_secret, p_tin);
  end if;
  update public.books_legal_entities set payer_tin_secret_id = v_secret, payer_tin_last4 = right(p_tin, 4), updated_at = now()
   where org_id = p_org_id and id = p_legal_entity_id;
  return right(p_tin, 4);
end $$;

create table public.books_1099_packages (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id),
  legal_entity_id uuid not null,
  tax_year integer not null check (tax_year between 2000 and 2200),
  form_type text not null default '1099-NEC' check (form_type = '1099-NEC'),
  status text not null default 'prepared' check (status in ('prepared', 'approved', 'submitted', 'accepted', 'rejected', 'withdrawn', 'superseded')),
  threshold_cents bigint not null check (threshold_cents >= 0),
  policy_source text not null,
  snapshot jsonb not null check (jsonb_typeof(snapshot) = 'object' and jsonb_typeof(snapshot->'payees') = 'array'),
  digest text not null check (digest ~ '^[a-f0-9]{64}$'),
  payee_count integer not null check (payee_count >= 0),
  total_cents bigint not null check (total_cents >= 0),
  prepared_by uuid not null references public.app_users(id), prepared_at timestamptz not null default now(),
  reviewed_by uuid references public.app_users(id), reviewed_at timestamptz, review_notes text,
  submitted_by uuid references public.app_users(id), submitted_at timestamptz, partner text, partner_reference text,
  outcome_by uuid references public.app_users(id), outcome_at timestamptz, outcome_notes text,
  closed_by uuid references public.app_users(id), closed_at timestamptz, close_reason text,
  supersedes_id uuid,
  idempotency_key text not null check (length(idempotency_key) between 10 and 200),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id), unique (org_id, idempotency_key),
  foreign key (org_id, legal_entity_id) references public.books_legal_entities(org_id, id),
  foreign key (org_id, supersedes_id) references public.books_1099_packages(org_id, id),
  check (status in ('prepared', 'withdrawn') or (reviewed_by is not null and reviewed_by <> prepared_by and reviewed_at is not null and coalesce(length(trim(review_notes)), 0) >= 10)),
  check (status not in ('submitted', 'accepted', 'rejected') or (submitted_by is not null and submitted_at is not null and coalesce(length(trim(partner)), 0) >= 2)),
  check (status not in ('accepted', 'rejected') or (outcome_by is not null and outcome_at is not null and coalesce(length(trim(outcome_notes)), 0) >= 3)),
  check (status not in ('withdrawn', 'superseded') or (closed_by is not null and closed_at is not null and coalesce(length(trim(close_reason)), 0) >= 10))
);
create index books_1099_packages_year_idx on public.books_1099_packages (org_id, legal_entity_id, tax_year, status);
create index books_1099_packages_supersedes_idx on public.books_1099_packages (org_id, supersedes_id) where supersedes_id is not null;
-- One draft and one live package per payer and year; a correction is prepared
-- beside the live one and replaces it only when approved.
create unique index books_1099_packages_one_draft on public.books_1099_packages (org_id, legal_entity_id, tax_year, form_type) where status = 'prepared';
create unique index books_1099_packages_one_live on public.books_1099_packages (org_id, legal_entity_id, tax_year, form_type) where status in ('approved', 'submitted', 'accepted', 'rejected');
alter table public.books_1099_packages enable row level security;
revoke all on public.books_1099_packages from public, anon, authenticated;
grant select, insert, update on public.books_1099_packages to service_role;

create function public.guard_books_1099_package() returns trigger language plpgsql security invoker set search_path = pg_catalog, public as $$
declare
  frozen text[] := array['id', 'org_id', 'legal_entity_id', 'tax_year', 'form_type', 'threshold_cents', 'policy_source', 'snapshot', 'digest', 'payee_count', 'total_cents',
    'prepared_by', 'prepared_at', 'supersedes_id', 'idempotency_key', 'created_at'];
  key text;
  active boolean;
begin
  if tg_op = 'DELETE' then raise exception '1099 package history cannot be deleted'; end if;
  if tg_op = 'INSERT' then
    if new.status <> 'prepared' then raise exception '1099 packages start as prepared'; end if;
    if not exists (select 1 from public.memberships where org_id = new.org_id and user_id = new.prepared_by and status = 'active') then raise exception 'The preparer must be an active member'; end if;
    if new.supersedes_id is not null and not exists (select 1 from public.books_1099_packages where org_id = new.org_id and id = new.supersedes_id
        and legal_entity_id = new.legal_entity_id and tax_year = new.tax_year and status in ('approved', 'submitted', 'accepted', 'rejected')) then
      raise exception 'A correction replaces the live package for the same company and year';
    end if;
    return new;
  end if;
  foreach key in array frozen loop
    if to_jsonb(new) -> key is distinct from to_jsonb(old) -> key then raise exception '1099 package evidence is immutable (%)', key; end if;
  end loop;
  if old.status in ('approved', 'submitted', 'accepted', 'rejected', 'superseded') and (new.reviewed_by, new.reviewed_at, new.review_notes) is distinct from (old.reviewed_by, old.reviewed_at, old.review_notes) then
    raise exception 'The approval of a 1099 package is kept as recorded';
  end if;
  if old.status in ('accepted', 'rejected', 'superseded') and (new.outcome_by, new.outcome_at, new.outcome_notes) is distinct from (old.outcome_by, old.outcome_at, old.outcome_notes)
    and not (old.status = 'rejected' and new.status = 'submitted') then
    raise exception 'A filing outcome is kept as recorded';
  end if;
  if not ((old.status = 'prepared' and new.status in ('approved', 'withdrawn'))
       or (old.status = 'approved' and new.status in ('submitted', 'withdrawn', 'superseded'))
       or (old.status = 'submitted' and new.status in ('accepted', 'rejected', 'superseded'))
       or (old.status = 'rejected' and new.status in ('submitted', 'superseded'))
       or (old.status = 'accepted' and new.status = 'superseded')) then
    raise exception 'A 1099 package cannot move from % to %', old.status, new.status;
  end if;
  select exists (select 1 from public.memberships where org_id = new.org_id and user_id = coalesce(
    case new.status when 'approved' then new.reviewed_by when 'submitted' then new.submitted_by when 'accepted' then new.outcome_by when 'rejected' then new.outcome_by else new.closed_by end, new.prepared_by) and status = 'active') into active;
  if not active then raise exception 'Only an active member can change a 1099 package'; end if;
  if new.status = 'approved' and new.reviewed_by = new.prepared_by then raise exception 'A 1099 package is approved by someone other than the person who prepared it'; end if;
  new.updated_at := now();
  return new;
end $$;
create trigger books_1099_package_guard before insert or update or delete on public.books_1099_packages for each row execute function public.guard_books_1099_package();

-- Approving a correction replaces the live package it corrects, keeping its evidence.
create or replace function public.approve_books_1099_package(p_org_id uuid, p_package_id uuid, p_actor_id uuid, p_notes text, p_current_digest text)
returns uuid language plpgsql security definer set search_path = public, pg_catalog as $$
declare v public.books_1099_packages%rowtype;
begin
  select * into v from public.books_1099_packages where org_id = p_org_id and id = p_package_id for update;
  if not found then raise exception '1099 package not found'; end if;
  if v.status <> 'prepared' then raise exception 'Only a prepared 1099 package can be approved'; end if;
  if v.digest is distinct from p_current_digest then raise exception 'Payments changed after this package was prepared'; end if;
  if v.supersedes_id is not null then
    update public.books_1099_packages set status = 'superseded', closed_by = p_actor_id, closed_at = now(), close_reason = 'Replaced by corrected package ' || p_package_id::text
     where org_id = p_org_id and id = v.supersedes_id;
  end if;
  update public.books_1099_packages set status = 'approved', reviewed_by = p_actor_id, reviewed_at = now(), review_notes = p_notes where org_id = p_org_id and id = p_package_id;
  return p_package_id;
end $$;

-- Full taxpayer IDs for the filing file of a reviewed package, service-only.
create or replace function public.books_1099_filing_identities(p_org_id uuid, p_package_id uuid)
returns jsonb language plpgsql security definer set search_path = public, vault, pg_catalog as $$
declare v public.books_1099_packages%rowtype; v_payer text; v_payees jsonb;
begin
  select * into v from public.books_1099_packages where org_id = p_org_id and id = p_package_id;
  if not found then raise exception '1099 package not found'; end if;
  if v.status not in ('approved', 'submitted', 'accepted', 'rejected') then raise exception 'Only an approved 1099 package has a filing file'; end if;
  select s.decrypted_secret into v_payer from public.books_legal_entities e join vault.decrypted_secrets s on s.id = e.payer_tin_secret_id
   where e.org_id = p_org_id and e.id = v.legal_entity_id;
  select coalesce(jsonb_object_agg(r.company_id::text, s.decrypted_secret), '{}'::jsonb) into v_payees
    from public.tax_identity_refs r join vault.decrypted_secrets s on s.id = r.vault_reference::uuid
   where r.org_id = p_org_id and r.vault_provider = 'supabase_vault'
     and r.company_id in (select (payee->>'company_id')::uuid from jsonb_array_elements(v.snapshot->'payees') payee);
  return jsonb_build_object('payer', v_payer, 'payees', v_payees);
end $$;

revoke all on function public.store_legal_entity_payer_tin_atomic(uuid, uuid, text, uuid) from public, anon, authenticated;
revoke all on function public.approve_books_1099_package(uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function public.books_1099_filing_identities(uuid, uuid) from public, anon, authenticated;
revoke all on function public.guard_books_1099_package() from public, anon, authenticated;
grant execute on function public.store_legal_entity_payer_tin_atomic(uuid, uuid, text, uuid) to service_role;
grant execute on function public.approve_books_1099_package(uuid, uuid, uuid, text, text) to service_role;
grant execute on function public.books_1099_filing_identities(uuid, uuid) to service_role;

commit;
