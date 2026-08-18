-- Preserve provider invoice-line identity independently from Arc's chart-of-accounts coding.
-- This is intentionally additive and contains no customer-data repair/backfill.
set lock_timeout = '5s';
set statement_timeout = '120s';

create table public.accounting_invoice_line_links (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.orgs(id) on delete cascade,
  connection_id uuid not null references public.accounting_connections(id) on delete cascade,
  provider text not null,
  invoice_id uuid not null references public.invoices(id) on delete cascade,
  invoice_line_id uuid not null references public.invoice_lines(id) on delete cascade,
  external_invoice_id text not null,
  external_line_id text,
  external_item_id text not null,
  external_item_name text,
  external_income_account_id text,
  external_income_account_name text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint accounting_invoice_line_links_provider_check check (btrim(provider) <> ''),
  constraint accounting_invoice_line_links_external_item_id_check check (btrim(external_item_id) <> ''),
  unique (org_id, connection_id, invoice_line_id)
);

create index accounting_invoice_line_links_connection_external_idx
  on public.accounting_invoice_line_links (connection_id, external_invoice_id, external_line_id);
create index accounting_invoice_line_links_invoice_idx
  on public.accounting_invoice_line_links (org_id, invoice_id);
create index accounting_invoice_line_links_invoice_fk_idx
  on public.accounting_invoice_line_links (invoice_id);
create index accounting_invoice_line_links_invoice_line_idx
  on public.accounting_invoice_line_links (invoice_line_id);
create index accounting_invoice_line_links_item_idx
  on public.accounting_invoice_line_links (connection_id, external_item_id);

create trigger accounting_invoice_line_links_set_updated_at
  before update on public.accounting_invoice_line_links
  for each row execute function public.tg_set_updated_at();

create or replace function public.validate_accounting_invoice_line_link()
returns trigger language plpgsql set search_path = public as $$
begin
  if not exists (
    select 1
    from public.accounting_connections c
    where c.id = new.connection_id
      and c.org_id = new.org_id
      and c.provider = new.provider
  ) then
    raise exception 'Accounting connection must belong to the line-link organization and provider';
  end if;

  if not exists (
    select 1
    from public.invoice_lines il
    join public.invoices i on i.id = il.invoice_id
    where il.id = new.invoice_line_id
      and il.invoice_id = new.invoice_id
      and il.org_id = new.org_id
      and i.org_id = new.org_id
  ) then
    raise exception 'Invoice line must belong to the linked invoice and organization';
  end if;

  return new;
end;
$$;

create trigger accounting_invoice_line_links_validate
  before insert or update on public.accounting_invoice_line_links
  for each row execute function public.validate_accounting_invoice_line_link();

revoke all on function public.validate_accounting_invoice_line_link() from public, anon, authenticated;

alter table public.accounting_invoice_line_links enable row level security;
create policy accounting_invoice_line_links_org_access on public.accounting_invoice_line_links
  for all to authenticated
  using (public.is_org_member(org_id))
  with check (public.is_org_member(org_id));

revoke all on public.accounting_invoice_line_links from anon;
grant select, insert, update, delete on public.accounting_invoice_line_links to authenticated;
grant all on public.accounting_invoice_line_links to service_role;
