create table if not exists public.platform_settings (
  key text primary key,
  value jsonb not null default '{}'::jsonb,
  updated_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

drop trigger if exists platform_settings_set_updated_at on public.platform_settings;
create trigger platform_settings_set_updated_at
before update on public.platform_settings
for each row execute function public.tg_set_updated_at();

alter table public.platform_settings enable row level security;

drop policy if exists platform_settings_service_role_only on public.platform_settings;
create policy platform_settings_service_role_only
on public.platform_settings
for all
using (auth.role() = 'service_role')
with check (auth.role() = 'service_role');
