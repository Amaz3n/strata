do $$ begin
  create type public.cost_type as enum
    ('labor', 'material', 'equipment', 'subcontract', 'other');
exception when duplicate_object then null;
end $$;

alter table public.cost_codes
  add column if not exists cost_type public.cost_type;

alter table public.budget_lines
  add column if not exists cost_type public.cost_type;

comment on column public.cost_codes.cost_type is
  'Optional reporting dimension for labor, material, equipment, subcontract, or other cost.';

comment on column public.budget_lines.cost_type is
  'Optional budget-line override/inherited snapshot of the cost-code cost type.';
