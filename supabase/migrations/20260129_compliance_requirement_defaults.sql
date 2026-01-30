-- Org-level default compliance requirements template.
-- Applied automatically to new subcontractor/supplier companies on creation.

alter table orgs
  add column if not exists default_compliance_requirements jsonb not null default '[]'::jsonb;

