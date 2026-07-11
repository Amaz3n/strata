alter table public.orgs
  add column if not exists product_tier text not null default 'residential'
  check (product_tier in ('residential', 'commercial', 'production'));

comment on column public.orgs.product_tier is
  'Default posture for new projects + org-surface vocabulary + packaging segment. Never gates data; per-project behavior follows projects.property_type.';
