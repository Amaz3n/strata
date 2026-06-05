alter table public.project_financial_settings
  add column if not exists cost_codes_enabled boolean not null default true;

comment on column public.project_financial_settings.cost_codes_enabled
  is 'Controls whether project financial workflows expose and require cost code coding.';
