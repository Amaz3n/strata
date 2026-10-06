-- Minimal surrounding schema for the isolated Banking RPC test. The test loads
-- Arc's real journal posting/reversal and bank-match functions after this file.
create role anon; create role authenticated; create role service_role;
create table orgs(id uuid primary key,name text);
create table app_users(id uuid primary key);
create table files(id uuid primary key);
create table companies(id uuid primary key,org_id uuid,name text);
create table projects(id uuid primary key,org_id uuid,name text);
create table cost_codes(id uuid primary key,org_id uuid);
create table books_settings(org_id uuid,workspace_enabled boolean,arc_ledger_mode text,active_policy_version integer,functional_currency text default 'usd');
create table gl_accounts(id uuid primary key,org_id uuid,code text,name text,account_type text,active boolean);
create table bank_accounts(id uuid primary key,org_id uuid,name text,gl_account_id uuid);
create table bank_transactions(id uuid primary key,org_id uuid,bank_account_id uuid,transaction_date date,amount_cents bigint,direction text,description text,merchant_name text,lifecycle_status text,excluded boolean default false,currency text default 'usd',updated_at timestamptz default now());
create table accounting_periods(id uuid primary key,org_id uuid,period_start date,period_end date,status text);
create table bank_reconciliations(id uuid primary key,org_id uuid,bank_account_id uuid,status text,statement_end date);
create table journal_entries(id uuid primary key default gen_random_uuid(),org_id uuid,fact_id uuid,period_id uuid,entry_date date,entry_kind text,status text,memo text,posting_key text,projection_version integer,policy_version integer,source_type text,source_id uuid,reversal_of_entry_id uuid,created_by uuid,posted_at timestamptz,posted_by uuid,unique(org_id,posting_key));
create table journal_lines(id uuid primary key default gen_random_uuid(),org_id uuid,entry_id uuid,line_no integer,account_id uuid,project_id uuid,company_id uuid,description text,debit_cents bigint,credit_cents bigint,dimensions jsonb);
create table bank_transaction_matches(id uuid primary key default gen_random_uuid(),org_id uuid,bank_transaction_id uuid,journal_line_id uuid,matched_amount_cents bigint check(matched_amount_cents>0),match_type text,confidence numeric,status text,confirmed_by uuid,confirmed_at timestamptz,reversed_at timestamptz,updated_at timestamptz);
create table job_cost_entries(id uuid primary key default gen_random_uuid(),org_id uuid,project_id uuid,cost_code_id uuid,source_type text,source_id text,incurred_on date,cost_cents bigint,status text,is_billable boolean,metadata jsonb,updated_at timestamptz,unique(org_id,source_type,source_id));
create table bank_rules(id uuid primary key default gen_random_uuid(),org_id uuid,match_kind text,match_value text,direction text,bank_account_id uuid,gl_account_id uuid,vendor_id uuid,project_id uuid,cost_code_id uuid,confidence numeric,hit_count integer,active boolean,created_by uuid,updated_by uuid,unique(org_id,match_kind,match_value,bank_account_id,direction));
