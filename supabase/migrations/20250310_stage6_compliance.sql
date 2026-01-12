-- Stage 6: Compliance rules + company compliance fields

alter table orgs add column if not exists compliance_rules jsonb default '{}'::jsonb;

alter table companies add column if not exists license_number text;
alter table companies add column if not exists license_expiry date;
alter table companies add column if not exists license_verified boolean default false;
alter table companies add column if not exists insurance_expiry date;
alter table companies add column if not exists insurance_provider text;
alter table companies add column if not exists insurance_document_id uuid;
alter table companies add column if not exists w9_on_file boolean default false;
alter table companies add column if not exists w9_file_id uuid;
alter table companies add column if not exists prequalified boolean default false;
alter table companies add column if not exists prequalified_at timestamptz;
alter table companies add column if not exists rating integer;
alter table companies add column if not exists default_payment_terms text;
alter table companies add column if not exists internal_notes text;
alter table companies add column if not exists notes text;
