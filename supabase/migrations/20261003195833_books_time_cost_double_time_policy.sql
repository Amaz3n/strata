-- Keep the formula used by historical rows; only new time entries adopt the
-- double-time fix by default. Changing legacy policy is a reviewed source
-- correction, not part of this migration. PostgreSQL 17+ preserves the generated
-- column identity and dependent objects with SET EXPRESSION.
alter table public.time_entries add column labor_cost_policy_version smallint not null default 0
 check (labor_cost_policy_version in (0,1));
alter table public.time_entries alter column labor_cost_policy_version set default 1;
alter table public.time_entries alter column cost_cents set expression as (
 round(hours * base_rate_cents::numeric * burden_multiplier *
  case when labor_cost_policy_version=0 then case when is_overtime then ot_multiplier else 1 end
   when is_double_time then dt_multiplier
   when is_overtime then ot_multiplier else 1 end)::integer
);
comment on column public.time_entries.labor_cost_policy_version is
 '0 retains the original overtime-only cost calculation. 1 includes double time. Legacy double-time differences require reviewed correction or payroll reconciliation.';
analyze public.time_entries;
