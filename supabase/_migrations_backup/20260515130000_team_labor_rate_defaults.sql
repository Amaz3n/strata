alter table public.memberships
  add column if not exists labor_cost_rate_cents integer not null default 0 check (labor_cost_rate_cents >= 0),
  add column if not exists labor_bill_rate_cents integer not null default 0 check (labor_bill_rate_cents >= 0),
  add column if not exists labor_burden_multiplier numeric not null default 1.0 check (labor_burden_multiplier >= 1.0),
  add column if not exists labor_is_billable_default boolean not null default true;

comment on column public.memberships.labor_cost_rate_cents is 'Default hourly internal cost rate for time entries, in cents.';
comment on column public.memberships.labor_bill_rate_cents is 'Default hourly billing rate for T&M/client-facing time, in cents. Reserved for billing workflows.';
comment on column public.memberships.labor_burden_multiplier is 'Default labor burden multiplier applied to cost rate for this employee.';
comment on column public.memberships.labor_is_billable_default is 'Whether this employee time defaults to billable on cost-plus/T&M projects.';
