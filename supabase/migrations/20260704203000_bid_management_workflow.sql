alter table public.bid_submissions
  add column if not exists source text not null default 'portal',
  add column if not exists entered_by uuid,
  add column if not exists entered_at timestamptz,
  add column if not exists leveled_adjustment_cents integer not null default 0,
  add column if not exists leveling_notes text,
  add column if not exists line_items jsonb not null default '[]'::jsonb;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.bid_submissions'::regclass
      and conname = 'bid_submissions_source_check'
  ) then
    alter table public.bid_submissions
      add constraint bid_submissions_source_check
      check (source in ('portal', 'manual', 'email_ingest'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.bid_submissions'::regclass
      and conname = 'bid_submissions_entered_by_fkey'
  ) then
    alter table public.bid_submissions
      add constraint bid_submissions_entered_by_fkey
      foreign key (entered_by) references public.app_users(id) on delete set null;
  end if;
end $$;

alter table public.rfis
  add column if not exists bid_package_id uuid;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.rfis'::regclass
      and conname = 'rfis_bid_package_id_fkey'
  ) then
    alter table public.rfis
      add constraint rfis_bid_package_id_fkey
      foreign key (bid_package_id) references public.bid_packages(id) on delete set null;
  end if;
end $$;

create index if not exists bid_submissions_source_idx
  on public.bid_submissions (org_id, source);

create index if not exists bid_submissions_entered_by_idx
  on public.bid_submissions (org_id, entered_by)
  where entered_by is not null;

create index if not exists rfis_org_bid_package_idx
  on public.rfis (org_id, bid_package_id)
  where bid_package_id is not null;
