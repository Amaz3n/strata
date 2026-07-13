-- Master rule 18 completeness for append-only and delivery-tracking Wave 2 tables.

alter table public.spec_revisions
  add column if not exists updated_at timestamptz not null default now();
create trigger spec_revisions_set_updated_at before update on public.spec_revisions
  for each row execute function public.tg_set_updated_at();

alter table public.meeting_distribution_recipients
  add column if not exists updated_at timestamptz not null default now();
create trigger meeting_distribution_recipients_set_updated_at before update on public.meeting_distribution_recipients
  for each row execute function public.tg_set_updated_at();
