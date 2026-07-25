-- Cost codes on/off becomes an org-level decision with a per-project override.
--
-- The org default now lives in org_settings.settings ->> 'cost_codes_enabled'
-- (JSONB, no schema change). The per-project column becomes nullable so that:
--   null        = inherit the org default
--   true/false  = explicit per-project override
--
-- Existing rows: projects currently "on" (true) are switched to inherit (null) so
-- they follow the org master switch going forward; deliberate opt-outs (false) are
-- preserved as explicit overrides. Today's behavior is unchanged because an absent
-- org setting resolves to true.

alter table public.project_financial_settings
  alter column cost_codes_enabled drop not null;

alter table public.project_financial_settings
  alter column cost_codes_enabled drop default;

update public.project_financial_settings
  set cost_codes_enabled = null
  where cost_codes_enabled is true;

comment on column public.project_financial_settings.cost_codes_enabled
  is 'Per-project cost-code override. null = inherit the org default (org_settings.settings.cost_codes_enabled, absent = true); true/false = explicit override.';
