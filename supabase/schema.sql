-- Arc: Production Schema (Reconciled)
-- This file represents the complete production schema after reconciliation
-- Generated from production database state - DO NOT MODIFY DIRECTLY


-- Extensions
create extension if not exists "pgcrypto";
create extension if not exists "citext";

-- Enums/Types
CREATE TYPE public.approval_status AS ENUM ('rejected', 'approved', 'canceled', 'pending');
CREATE TYPE public.audit_action AS ENUM ('insert', 'delete', 'update');
CREATE TYPE public.conversation_channel AS ENUM ('client', 'internal', 'sub');
CREATE TYPE public.event_channel AS ENUM ('notification', 'integration', 'activity');
CREATE TYPE public.license_status AS ENUM ('suspended', 'issued', 'active', 'expired');
CREATE TYPE public.membership_status AS ENUM ('suspended', 'active', 'invited');
CREATE TYPE public.notification_channel AS ENUM ('sms', 'email', 'in_app', 'webhook');
CREATE TYPE public.pricing_model AS ENUM ('subscription', 'license');
CREATE TYPE public.project_property_type AS ENUM ('residential', 'commercial');
CREATE TYPE public.project_status AS ENUM ('planning', 'active', 'bidding', 'cancelled', 'completed', 'on_hold');
CREATE TYPE public.project_work_type AS ENUM ('addition', 'repair', 'renovation', 'remodel', 'new_construction');
CREATE TYPE public.role_scope AS ENUM ('project', 'org');
CREATE TYPE public.subscription_status AS ENUM ('canceled', 'active', 'trialing', 'past_due');
CREATE TYPE public.task_priority AS ENUM ('low', 'normal', 'urgent', 'high');
CREATE TYPE public.task_status AS ENUM ('done', 'in_progress', 'todo', 'blocked');

-- Functions
CREATE OR REPLACE FUNCTION public.budget_line_lock_guard() RETURNS trigger AS '
declare
  status text;
begin
  select status into status from budgets where id = coalesce(new.budget_id, old.budget_id) limit 1;
  if status = ''locked'' then
    raise exception ''Budget is locked and lines cannot be modified'';
  end if;
  return coalesce(new, old);
end;
' LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.budget_lock_guard() RETURNS trigger AS '
begin
  if old.status = ''locked'' then
    if new.status <> ''locked''
      or new.total_cents is distinct from old.total_cents
      or new.project_id is distinct from old.project_id
      or new.metadata is distinct from old.metadata then
      raise exception ''Budget is locked and cannot be edited'';
    end if;
  end if;
  return new;
end;
' LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.citext(inet) RETURNS citext AS 'network_show' LANGUAGE internal IMMUTABLE;
CREATE OR REPLACE FUNCTION public.citext(boolean) RETURNS citext AS 'booltext' LANGUAGE internal IMMUTABLE;
CREATE OR REPLACE FUNCTION public.citext(character) RETURNS citext AS 'rtrim1' LANGUAGE internal IMMUTABLE;
CREATE OR REPLACE FUNCTION public.citext_cmp(citext, citext) RETURNS integer AS 'citext_cmp' LANGUAGE c IMMUTABLE;
CREATE OR REPLACE FUNCTION public.citext_eq(citext, citext) RETURNS boolean AS 'citext_eq' LANGUAGE c IMMUTABLE;
CREATE OR REPLACE FUNCTION public.citext_ge(citext, citext) RETURNS boolean AS 'citext_ge' LANGUAGE c IMMUTABLE;
CREATE OR REPLACE FUNCTION public.citext_gt(citext, citext) RETURNS boolean AS 'citext_gt' LANGUAGE c IMMUTABLE;
CREATE OR REPLACE FUNCTION public.citext_hash(citext) RETURNS integer AS 'citext_hash' LANGUAGE c IMMUTABLE;
CREATE OR REPLACE FUNCTION public.citext_hash_extended(citext, bigint) RETURNS bigint AS 'citext_hash_extended' LANGUAGE c IMMUTABLE;
CREATE OR REPLACE FUNCTION public.citext_larger(citext, citext) RETURNS citext AS 'citext_larger' LANGUAGE c IMMUTABLE;
CREATE OR REPLACE FUNCTION public.citext_le(citext, citext) RETURNS boolean AS 'citext_le' LANGUAGE c IMMUTABLE;
CREATE OR REPLACE FUNCTION public.citext_lt(citext, citext) RETURNS boolean AS 'citext_lt' LANGUAGE c IMMUTABLE;
CREATE OR REPLACE FUNCTION public.citext_ne(citext, citext) RETURNS boolean AS 'citext_ne' LANGUAGE c IMMUTABLE;
CREATE OR REPLACE FUNCTION public.citext_pattern_cmp(citext, citext) RETURNS integer AS 'citext_pattern_cmp' LANGUAGE c IMMUTABLE;
CREATE OR REPLACE FUNCTION public.citext_pattern_ge(citext, citext) RETURNS boolean AS 'citext_pattern_ge' LANGUAGE c IMMUTABLE;
CREATE OR REPLACE FUNCTION public.citext_pattern_gt(citext, citext) RETURNS boolean AS 'citext_pattern_gt' LANGUAGE c IMMUTABLE;
CREATE OR REPLACE FUNCTION public.citext_pattern_le(citext, citext) RETURNS boolean AS 'citext_pattern_le' LANGUAGE c IMMUTABLE;
CREATE OR REPLACE FUNCTION public.citext_pattern_lt(citext, citext) RETURNS boolean AS 'citext_pattern_lt' LANGUAGE c IMMUTABLE;
CREATE OR REPLACE FUNCTION public.citext_smaller(citext, citext) RETURNS citext AS 'citext_smaller' LANGUAGE c IMMUTABLE;
CREATE OR REPLACE FUNCTION public.citextin(cstring) RETURNS citext AS 'textin' LANGUAGE internal IMMUTABLE;
CREATE OR REPLACE FUNCTION public.citextout(citext) RETURNS cstring AS 'textout' LANGUAGE internal IMMUTABLE;
CREATE OR REPLACE FUNCTION public.citextrecv(internal) RETURNS citext AS 'textrecv' LANGUAGE internal STABLE;
CREATE OR REPLACE FUNCTION public.citextsend(citext) RETURNS bytea AS 'textsend' LANGUAGE internal STABLE;

CREATE OR REPLACE FUNCTION public.get_next_version_number(p_file_id uuid) RETURNS integer AS '
DECLARE
  v_max_version integer;
BEGIN
  SELECT COALESCE(MAX(version_number), 0) + 1
  INTO v_max_version
  FROM doc_versions
  WHERE file_id = p_file_id;

  RETURN v_max_version;
END;
' LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.increment_portal_access(token_id_input uuid) RETURNS void AS '
BEGIN
  UPDATE portal_access_tokens
  SET access_count = COALESCE(access_count, 0) + 1,
      last_accessed_at = now()
  WHERE id = token_id_input;
END;
' LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.is_org_member(check_org_id uuid) RETURNS boolean AS ' select exists (select 1 from memberships m where m.org_id=check_org_id and m.user_id=auth.uid() and m.status=''active''); ' LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION public.is_project_member(check_project_id uuid) RETURNS boolean AS ' select exists (select 1 from project_members pm join projects p on p.id=pm.project_id where pm.project_id=check_project_id and pm.user_id=auth.uid() and pm.status=''active'' and pm.org_id=p.org_id); ' LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION public.max(citext) RETURNS citext AS 'aggregate_dummy' LANGUAGE internal IMMUTABLE;
CREATE OR REPLACE FUNCTION public.min(citext) RETURNS citext AS 'aggregate_dummy' LANGUAGE internal IMMUTABLE;

CREATE OR REPLACE FUNCTION public.next_rfi_number(p_project_id uuid) RETURNS integer AS '
  SELECT COALESCE(MAX(rfi_number), 0) + 1 FROM rfis WHERE project_id = p_project_id;
' LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.next_submittal_number(p_project_id uuid) RETURNS integer AS '
  SELECT COALESCE(MAX(submittal_number), 0) + 1 FROM submittals WHERE project_id = p_project_id;
' LANGUAGE sql;

CREATE OR REPLACE FUNCTION public.photo_timeline_for_portal(p_project_id uuid, p_org_id uuid) RETURNS TABLE(week_start timestamp with time zone, week_end timestamp with time zone, photos jsonb, summaries text[]) AS '
  SELECT
    date_trunc(''week'', p.taken_at) AS week_start,
    date_trunc(''week'', p.taken_at) + INTERVAL ''6 days'' AS week_end,
    jsonb_agg(jsonb_build_object(
      ''id'', p.id,
      ''url'', f.storage_path,
      ''taken_at'', p.taken_at,
      ''tags'', p.tags
    ) ORDER BY p.taken_at) AS photos,
    ARRAY_AGG(dl.summary) FILTER (WHERE dl.summary IS NOT NULL) AS summaries
  FROM photos p
  JOIN files f ON f.id = p.file_id
  LEFT JOIN daily_logs dl ON dl.id = p.daily_log_id
  WHERE p.project_id = p_project_id AND p.org_id = p_org_id
  GROUP BY date_trunc(''week'', p.taken_at)
  ORDER BY week_start DESC;
' LANGUAGE sql STABLE;

CREATE OR REPLACE FUNCTION public.regexp_match(citext, citext) RETURNS text[] AS '
    SELECT pg_catalog.regexp_match( $1::pg_catalog.text, $2::pg_catalog.text, ''i'' );
' LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.regexp_match(citext, citext, text) RETURNS text[] AS '
    SELECT pg_catalog.regexp_match( $1::pg_catalog.text, $2::pg_catalog.text, CASE WHEN pg_catalog.strpos($3, ''c'') = 0 THEN  $3 || ''i'' ELSE $3 END );
' LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.regexp_matches(citext, citext) RETURNS SETOF text[] AS '
    SELECT pg_catalog.regexp_matches( $1::pg_catalog.text, $2::pg_catalog.text, ''i'' );
' LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.regexp_matches(citext, citext, text) RETURNS SETOF text[] AS '
    SELECT pg_catalog.regexp_matches( $1::pg_catalog.text, $2::pg_catalog.text, CASE WHEN pg_catalog.strpos($3, ''c'') = 0 THEN  $3 || ''i'' ELSE $3 END );
' LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.regexp_replace(citext, citext, text, text) RETURNS text AS '
    SELECT pg_catalog.regexp_replace( $1::pg_catalog.text, $2::pg_catalog.text, $3, CASE WHEN pg_catalog.strpos($4, ''c'') = 0 THEN  $4 || ''i'' ELSE $4 END);
' LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.regexp_replace(citext, citext, text) RETURNS text AS '
    SELECT pg_catalog.regexp_replace( $1::pg_catalog.text, $2::pg_catalog.text, $3, ''i'');
' LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.regexp_split_to_array(citext, citext) RETURNS text[] AS '
    SELECT pg_catalog.regexp_split_to_array( $1::pg_catalog.text, $2::pg_catalog.text, ''i'' );
' LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.regexp_split_to_array(citext, citext, text) RETURNS text[] AS '
    SELECT pg_catalog.regexp_split_to_array( $1::pg_catalog.text, $2::pg_catalog.text, CASE WHEN pg_catalog.strpos($3, ''c'') = 0 THEN  $3 || ''i'' ELSE $3 END );
' LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.regexp_split_to_table(citext, citext) RETURNS SETOF text AS '
    SELECT pg_catalog.regexp_split_to_table( $1::pg_catalog.text, $2::pg_catalog.text, ''i'' );
' LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.regexp_split_to_table(citext, citext, text) RETURNS SETOF text AS '
    SELECT pg_catalog.regexp_split_to_table( $1::pg_catalog.text, $2::pg_catalog.text, CASE WHEN pg_catalog.strpos($3, ''c'') = 0 THEN  $3 || ''i'' ELSE $3 END );
' LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.replace(citext, citext, citext) RETURNS text AS E'
    SELECT pg_catalog.regexp_replace( $1::pg_catalog.text, pg_catalog.regexp_replace($2::pg_catalog.text, ''([^a-zA-Z_0-9])'', E''\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\1'', ''g''), $3::pg_catalog.text, ''gi'' );
' LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.split_part(citext, citext, integer) RETURNS text AS E'
    SELECT (pg_catalog.regexp_split_to_array( $1::pg_catalog.text, pg_catalog.regexp_replace($2::pg_catalog.text, ''([^a-zA-Z_0-9])'', E''\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\\1'', ''g''), ''i''))[$3];
' LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.strpos(citext, citext) RETURNS integer AS '
    SELECT pg_catalog.strpos( pg_catalog.lower( $1::pg_catalog.text ), pg_catalog.lower( $2::pg_catalog.text ) );
' LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.texticlike(citext, citext) RETURNS boolean AS 'texticlike' LANGUAGE internal IMMUTABLE;
CREATE OR REPLACE FUNCTION public.texticlike(citext, text) RETURNS boolean AS 'texticlike' LANGUAGE internal IMMUTABLE;
CREATE OR REPLACE FUNCTION public.texticnlike(citext, text) RETURNS boolean AS 'texticnlike' LANGUAGE internal IMMUTABLE;
CREATE OR REPLACE FUNCTION public.texticnlike(citext, citext) RETURNS boolean AS 'texticnlike' LANGUAGE internal IMMUTABLE;
CREATE OR REPLACE FUNCTION public.texticregexeq(citext, citext) RETURNS boolean AS 'texticregexeq' LANGUAGE internal IMMUTABLE;
CREATE OR REPLACE FUNCTION public.texticregexeq(citext, text) RETURNS boolean AS 'texticregexeq' LANGUAGE internal IMMUTABLE;
CREATE OR REPLACE FUNCTION public.texticregexne(citext, text) RETURNS boolean AS 'texticregexne' LANGUAGE internal IMMUTABLE;
CREATE OR REPLACE FUNCTION public.texticregexne(citext, citext) RETURNS boolean AS 'texticregexne' LANGUAGE internal IMMUTABLE;

CREATE OR REPLACE FUNCTION public.tg_set_updated_at() RETURNS trigger AS ' begin new.updated_at = now(); return new; end; ' LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.translate(citext, citext, text) RETURNS text AS '
    SELECT pg_catalog.translate( pg_catalog.translate( $1::pg_catalog.text, pg_catalog.lower($2::pg_catalog.text), $3), pg_catalog.upper($2::pg_catalog.text), $3);
' LANGUAGE sql IMMUTABLE;

CREATE OR REPLACE FUNCTION public.update_drawing_markups_updated_at() RETURNS trigger AS '
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
' LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.update_drawing_pins_updated_at() RETURNS trigger AS '
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
' LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.update_drawing_sets_updated_at() RETURNS trigger AS '
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
' LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION public.update_drawing_sheets_updated_at() RETURNS trigger AS '
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
' LANGUAGE plpgsql;

-- Tables
CREATE TABLE public.allowances (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid, contract_id uuid NOT NULL, selection_category_id uuid NOT NULL, name text, budget_cents integer, used_cents integer DEFAULT 0, status text DEFAULT 'open'::text, overage_handling text NOT NULL DEFAULT 'co'::text, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.app_users (id uuid, email citext, full_name text NOT NULL, avatar_url text NOT NULL, onboarded_at timestamp with time zone NOT NULL, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.approvals (id uuid DEFAULT gen_random_uuid(), org_id uuid, entity_type text, entity_id uuid, requested_by uuid NOT NULL, approver_id uuid NOT NULL, status approval_status DEFAULT 'pending'::approval_status, due_at timestamp with time zone NOT NULL, decision_at timestamp with time zone NOT NULL, decision_notes text NOT NULL, payload jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now(), signature_data text NOT NULL, signature_ip inet NOT NULL, signed_at timestamp with time zone NOT NULL);
CREATE TABLE public.audit_log (id bigint DEFAULT nextval('audit_log_id_seq'::regclass), org_id uuid, actor_user_id uuid NOT NULL, action audit_action, entity_type text, entity_id uuid NOT NULL, before_data jsonb NOT NULL, after_data jsonb NOT NULL, source text NOT NULL, ip_address inet NOT NULL, created_at timestamp with time zone DEFAULT now());
CREATE TABLE public.bill_lines (id uuid DEFAULT gen_random_uuid(), org_id uuid, bill_id uuid, cost_code_id uuid NOT NULL, description text, quantity numeric DEFAULT 1, unit text NOT NULL, unit_cost_cents integer NOT NULL, metadata jsonb DEFAULT '{}'::jsonb, sort_order integer NOT NULL DEFAULT 0);
CREATE TABLE public.budget_lines (id uuid DEFAULT gen_random_uuid(), org_id uuid, budget_id uuid, cost_code_id uuid NOT NULL, description text, amount_cents integer NOT NULL, metadata jsonb DEFAULT '{}'::jsonb, sort_order integer NOT NULL DEFAULT 0);
CREATE TABLE public.budget_snapshots (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid, budget_id uuid, snapshot_date date, total_budget_cents integer, total_committed_cents integer, total_actual_cents integer, total_invoiced_cents integer, variance_cents integer, margin_percent numeric NOT NULL, by_cost_code jsonb DEFAULT '[]'::jsonb, created_at timestamp with time zone DEFAULT now());
CREATE TABLE public.budgets (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid, version integer DEFAULT 1, status text DEFAULT 'draft'::text, total_cents integer NOT NULL, currency text DEFAULT 'usd'::text, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.change_order_lines (id uuid DEFAULT gen_random_uuid(), org_id uuid, change_order_id uuid, cost_code_id uuid NOT NULL, description text, quantity numeric DEFAULT 1, unit text NOT NULL, unit_cost_cents integer NOT NULL, metadata jsonb DEFAULT '{}'::jsonb, sort_order integer NOT NULL DEFAULT 0);
CREATE TABLE public.change_orders (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid, contract_id uuid NOT NULL, title text, description text NOT NULL, status text DEFAULT 'draft'::text, reason text NOT NULL, total_cents integer NOT NULL, currency text DEFAULT 'usd'::text, requested_by uuid NOT NULL, approved_by uuid NOT NULL, approved_at timestamp with time zone NOT NULL, rejected_at timestamp with time zone NOT NULL, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now(), client_visible boolean DEFAULT false, requires_signature boolean DEFAULT true, days_impact integer NOT NULL, summary text NOT NULL);
CREATE TABLE public.change_requests (id uuid DEFAULT gen_random_uuid(), org_id uuid, requested_by uuid NOT NULL, title text, description text NOT NULL, status text DEFAULT 'open'::text, estimate_cents integer NOT NULL, approved_at timestamp with time zone NOT NULL, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.commitment_lines (id uuid DEFAULT gen_random_uuid(), org_id uuid, commitment_id uuid, cost_code_id uuid NOT NULL, description text, quantity numeric DEFAULT 1, unit text NOT NULL, unit_cost_cents integer NOT NULL, metadata jsonb DEFAULT '{}'::jsonb, sort_order integer NOT NULL DEFAULT 0);
CREATE TABLE public.commitments (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid, company_id uuid NOT NULL, title text, status text DEFAULT 'draft'::text, total_cents integer NOT NULL, currency text DEFAULT 'usd'::text, issued_at timestamp with time zone NOT NULL, start_date date NOT NULL, end_date date NOT NULL, external_reference text NOT NULL, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.companies (id uuid DEFAULT gen_random_uuid(), org_id uuid, name text, company_type text NOT NULL, phone text NOT NULL, email text NOT NULL, website text NOT NULL, address jsonb NOT NULL, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.contact_company_links (id uuid DEFAULT gen_random_uuid(), org_id uuid, contact_id uuid, company_id uuid, relationship text NOT NULL, created_at timestamp with time zone DEFAULT now());
CREATE TABLE public.contacts (id uuid DEFAULT gen_random_uuid(), org_id uuid, primary_company_id uuid NOT NULL, full_name text, email citext NOT NULL, phone text NOT NULL, role text NOT NULL, contact_type text NOT NULL, metadata jsonb DEFAULT '{}'::jsonb, external_crm_id text, crm_source text, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.contracts (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid, proposal_id uuid NOT NULL, title text, status text DEFAULT 'draft'::text, total_cents integer NOT NULL, currency text DEFAULT 'usd'::text, signed_at timestamp with time zone NOT NULL, effective_date date NOT NULL, terms text NOT NULL, snapshot jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now(), number text NOT NULL, contract_type text NOT NULL DEFAULT 'fixed'::text, markup_percent numeric NOT NULL, retainage_percent numeric NOT NULL DEFAULT 0, retainage_release_trigger text NOT NULL, signature_data jsonb NOT NULL);
CREATE TABLE public.conversations (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid NOT NULL, subject text NOT NULL, channel conversation_channel DEFAULT 'internal'::conversation_channel, created_by uuid NOT NULL, created_at timestamp with time zone DEFAULT now());
CREATE TABLE public.cost_codes (id uuid DEFAULT gen_random_uuid(), org_id uuid, parent_id uuid NOT NULL, code text, name text, category text NOT NULL, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now(), division text NOT NULL, standard text NOT NULL DEFAULT 'custom'::text, unit text NOT NULL, default_unit_cost_cents integer NOT NULL, is_active boolean NOT NULL DEFAULT true);
CREATE TABLE public.custom_field_values (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid NOT NULL, field_id uuid, entity_type text, entity_id uuid, value jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.custom_fields (id uuid DEFAULT gen_random_uuid(), org_id uuid, entity_type text, key text, label text, field_type text, required boolean DEFAULT false, options jsonb DEFAULT '{}'::jsonb, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.daily_log_entries (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid, daily_log_id uuid, entry_type text DEFAULT 'note'::text, description text NOT NULL, quantity numeric NOT NULL, hours numeric NOT NULL, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now());
CREATE TABLE public.daily_logs (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid, log_date date, weather jsonb NOT NULL, summary text NOT NULL, created_by uuid NOT NULL, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.doc_versions (id uuid DEFAULT gen_random_uuid(), org_id uuid, file_id uuid, version_number integer DEFAULT 1, label text NOT NULL, notes text NOT NULL, created_by uuid NOT NULL, created_at timestamp with time zone DEFAULT now(), storage_path text NOT NULL, mime_type text NOT NULL, size_bytes bigint NOT NULL, checksum text NOT NULL, file_name text NOT NULL);
CREATE TABLE public.draw_schedules (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid, invoice_id uuid NOT NULL, contract_id uuid NOT NULL, draw_number integer, title text, description text NOT NULL, amount_cents integer, percent_of_contract numeric NOT NULL, due_date date NOT NULL, due_trigger text NOT NULL, milestone_id uuid NOT NULL, status text DEFAULT 'pending'::text, invoiced_at timestamp with time zone NOT NULL, paid_at timestamp with time zone NOT NULL, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.drawing_markups (id uuid DEFAULT gen_random_uuid(), org_id uuid, drawing_sheet_id uuid, sheet_version_id uuid NOT NULL, data jsonb DEFAULT '{}'::jsonb, label text NOT NULL, is_private boolean DEFAULT false, share_with_clients boolean DEFAULT false, share_with_subs boolean DEFAULT false, created_by uuid NOT NULL, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.drawing_pins (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid, drawing_sheet_id uuid, sheet_version_id uuid NOT NULL, x_position numeric(10,8), y_position numeric(10,8), entity_type text, entity_id uuid, label text NOT NULL, style jsonb DEFAULT '{}'::jsonb, status text NOT NULL, share_with_clients boolean DEFAULT false, share_with_subs boolean DEFAULT false, created_by uuid NOT NULL, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.drawing_revisions (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid, drawing_set_id uuid NOT NULL, revision_label text, issued_date date NOT NULL, notes text NOT NULL, created_by uuid NOT NULL, created_at timestamp with time zone DEFAULT now());
CREATE TABLE public.drawing_sets (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid, title text, description text NOT NULL, status text DEFAULT 'processing'::text, source_file_id uuid NOT NULL, total_pages integer NOT NULL, processed_pages integer NOT NULL DEFAULT 0, error_message text NOT NULL, created_by uuid NOT NULL, created_at timestamp with time zone DEFAULT now(), processed_at timestamp with time zone NOT NULL, updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.drawing_sheet_versions (id uuid DEFAULT gen_random_uuid(), org_id uuid, drawing_sheet_id uuid, drawing_revision_id uuid, file_id uuid NOT NULL, thumbnail_file_id uuid NOT NULL, page_index integer NOT NULL, extracted_metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now());
CREATE TABLE public.drawing_sheets (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid, drawing_set_id uuid, sheet_number text, sheet_title text NOT NULL, discipline text NOT NULL, current_revision_id uuid NOT NULL, sort_order integer NOT NULL DEFAULT 0, share_with_clients boolean DEFAULT false, share_with_subs boolean DEFAULT false, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.entitlements (id uuid DEFAULT gen_random_uuid(), org_id uuid, feature_key text, limit_type text NOT NULL, limit_value numeric NOT NULL, source text DEFAULT 'plan'::text, expires_at timestamp with time zone NOT NULL, created_at timestamp with time zone DEFAULT now());
CREATE TABLE public.estimate_items (id uuid DEFAULT gen_random_uuid(), org_id uuid, estimate_id uuid, cost_code_id uuid NOT NULL, item_type text DEFAULT 'line'::text, description text, quantity numeric DEFAULT 1, unit text NOT NULL, unit_cost_cents integer NOT NULL, markup_pct numeric NOT NULL, sort_order integer NOT NULL DEFAULT 0, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now());
CREATE TABLE public.estimate_templates (id uuid DEFAULT gen_random_uuid(), org_id uuid, name text, description text NOT NULL, lines jsonb DEFAULT '[]'::jsonb, is_default boolean NOT NULL DEFAULT false, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.estimates (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid NULL, recipient_contact_id uuid, title text, status text DEFAULT 'draft'::text, version integer DEFAULT 1, subtotal_cents integer NOT NULL, tax_cents integer NOT NULL, total_cents integer NOT NULL, currency text DEFAULT 'usd'::text, metadata jsonb DEFAULT '{}'::jsonb, created_by uuid NOT NULL, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now(), valid_until date, approved_at timestamp with time zone, approved_by uuid);
CREATE TABLE public.events (id uuid DEFAULT gen_random_uuid(), org_id uuid, event_type text, entity_type text NOT NULL, entity_id uuid NOT NULL, payload jsonb DEFAULT '{}'::jsonb, channel event_channel DEFAULT 'activity'::event_channel, created_at timestamp with time zone DEFAULT now(), processed_at timestamp with time zone NOT NULL);
CREATE TABLE public.feature_flags (id uuid DEFAULT gen_random_uuid(), org_id uuid, flag_key text, enabled boolean DEFAULT true, config jsonb DEFAULT '{}'::jsonb, expires_at timestamp with time zone NOT NULL, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.file_access_events (id uuid DEFAULT gen_random_uuid(), org_id uuid, file_id uuid, actor_user_id uuid NOT NULL, portal_token_id uuid NOT NULL, action text, ip_address inet NOT NULL, user_agent text NOT NULL, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now());
CREATE TABLE public.file_links (id uuid DEFAULT gen_random_uuid(), org_id uuid, file_id uuid, project_id uuid NOT NULL, entity_type text, entity_id uuid, created_by uuid NOT NULL, created_at timestamp with time zone DEFAULT now(), link_role text NOT NULL);
CREATE TABLE public.files (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid NOT NULL, file_name text, storage_path text, mime_type text NOT NULL, size_bytes bigint NOT NULL, checksum text NOT NULL, visibility text DEFAULT 'private'::text, uploaded_by uuid NOT NULL, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now(), share_with_subs boolean DEFAULT false, metadata jsonb DEFAULT '{}'::jsonb, category text NOT NULL, folder_path text NOT NULL, description text NOT NULL, tags text[] DEFAULT '{}'::text[], archived_at timestamp with time zone NOT NULL, source text NOT NULL, current_version_id uuid NOT NULL, share_with_clients boolean DEFAULT false);
CREATE TABLE public.form_instances (id uuid DEFAULT gen_random_uuid(), org_id uuid, template_id uuid NOT NULL, entity_type text NOT NULL, entity_id uuid NOT NULL, status text DEFAULT 'draft'::text, created_by uuid NOT NULL, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.form_responses (id uuid DEFAULT gen_random_uuid(), org_id uuid, form_instance_id uuid NOT NULL, responder_id uuid NOT NULL, responses jsonb DEFAULT '{}'::jsonb, submitted_at timestamp with time zone DEFAULT now());
CREATE TABLE public.form_templates (id uuid DEFAULT gen_random_uuid(), org_id uuid, name text, entity_type text NOT NULL, version integer DEFAULT 1, schema jsonb DEFAULT '{}'::jsonb, is_active boolean DEFAULT true, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.invoice_lines (id uuid DEFAULT gen_random_uuid(), org_id uuid, invoice_id uuid, cost_code_id uuid NOT NULL, description text, quantity numeric DEFAULT 1, unit text NOT NULL, unit_price_cents integer NOT NULL, metadata jsonb DEFAULT '{}'::jsonb, sort_order integer NOT NULL DEFAULT 0);
CREATE TABLE public.invoice_views (id uuid DEFAULT gen_random_uuid(), org_id uuid, invoice_id uuid, token text NOT NULL, user_agent text NOT NULL, ip_address text NOT NULL, viewed_at timestamp with time zone DEFAULT now(), created_at timestamp with time zone DEFAULT now());
CREATE TABLE public.invoices (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid NOT NULL, invoice_number text NOT NULL, status text DEFAULT 'draft'::text, issue_date date NOT NULL, due_date date NOT NULL, total_cents integer NOT NULL, currency text DEFAULT 'usd'::text, recipient_contact_id uuid NOT NULL, file_id uuid NOT NULL, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now(), title text NOT NULL, notes text NOT NULL, client_visible boolean DEFAULT false, subtotal_cents integer NOT NULL, tax_cents integer NOT NULL, balance_due_cents integer NOT NULL, token text NOT NULL, viewed_at timestamp with time zone NOT NULL, tax_rate numeric NOT NULL, sent_at timestamp with time zone NOT NULL, sent_to_emails text[] NOT NULL, qbo_id text NOT NULL, qbo_synced_at timestamp with time zone NOT NULL, qbo_sync_status text NOT NULL);
CREATE TABLE public.late_fee_applications (id uuid DEFAULT gen_random_uuid(), org_id uuid, invoice_id uuid, late_fee_rule_id uuid, invoice_line_id uuid NOT NULL, amount_cents integer, applied_at timestamp with time zone DEFAULT now(), application_number integer, metadata jsonb DEFAULT '{}'::jsonb);
CREATE TABLE public.late_fees (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid NOT NULL, strategy text DEFAULT 'fixed'::text, amount_cents integer NOT NULL, percent_rate numeric NOT NULL, grace_days integer NOT NULL DEFAULT 0, repeat_days integer NOT NULL, max_applications integer NOT NULL, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.licenses (id uuid DEFAULT gen_random_uuid(), org_id uuid, plan_code text NOT NULL, status license_status DEFAULT 'issued'::license_status, license_key text, purchased_at timestamp with time zone DEFAULT now(), maintenance_expires_at timestamp with time zone NOT NULL, support_tier text NOT NULL, notes text NOT NULL, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.lien_waivers (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid, payment_id uuid NOT NULL, company_id uuid NOT NULL, contact_id uuid NOT NULL, waiver_type text, status text DEFAULT 'pending'::text, amount_cents integer, through_date date, claimant_name text, property_description text NOT NULL, document_file_id uuid NOT NULL, signed_file_id uuid NOT NULL, signature_data jsonb NOT NULL, sent_at timestamp with time zone NOT NULL, signed_at timestamp with time zone NOT NULL, expires_at timestamp with time zone NOT NULL, token_hash text NOT NULL, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.memberships (id uuid DEFAULT gen_random_uuid(), org_id uuid, user_id uuid, role_id uuid, status membership_status DEFAULT 'active'::membership_status, invited_by uuid NOT NULL, last_active_at timestamp with time zone NOT NULL, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.mentions (id uuid DEFAULT gen_random_uuid(), org_id uuid, message_id uuid, user_id uuid NOT NULL, contact_id uuid NOT NULL, created_at timestamp with time zone DEFAULT now());
CREATE TABLE public.messages (id uuid DEFAULT gen_random_uuid(), org_id uuid, conversation_id uuid, sender_id uuid NOT NULL, message_type text DEFAULT 'text'::text, body text NOT NULL, payload jsonb DEFAULT '{}'::jsonb, sent_at timestamp with time zone DEFAULT now());
CREATE TABLE public.notification_deliveries (id uuid DEFAULT gen_random_uuid(), org_id uuid, notification_id uuid, channel notification_channel DEFAULT 'in_app'::notification_channel, status text DEFAULT 'pending'::text, sent_at timestamp with time zone NOT NULL, response jsonb DEFAULT '{}'::jsonb);
CREATE TABLE public.notifications (id uuid DEFAULT gen_random_uuid(), org_id uuid, user_id uuid, notification_type text, payload jsonb DEFAULT '{}'::jsonb, read_at timestamp with time zone NOT NULL, created_at timestamp with time zone DEFAULT now());
CREATE TABLE public.org_settings (org_id uuid, settings jsonb DEFAULT '{}'::jsonb, storage_bucket text NOT NULL, region text NOT NULL, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.orgs (id uuid DEFAULT gen_random_uuid(), name text, slug citext NOT NULL, billing_model pricing_model DEFAULT 'subscription'::pricing_model, status text DEFAULT 'active'::text, billing_email text NOT NULL, locale text NOT NULL DEFAULT 'en-US'::text, created_by uuid NOT NULL, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now(), address jsonb NOT NULL);
CREATE TABLE public.outbox (id bigint DEFAULT nextval('outbox_id_seq'::regclass), org_id uuid, event_id uuid NOT NULL, job_type text, status text DEFAULT 'pending'::text, run_at timestamp with time zone DEFAULT now(), retry_count integer DEFAULT 0, last_error text NOT NULL, payload jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.payment_intents (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid NOT NULL, invoice_id uuid NOT NULL, provider text DEFAULT 'stripe'::text, provider_intent_id text NOT NULL, status text DEFAULT 'requires_payment_method'::text, amount_cents integer, currency text DEFAULT 'usd'::text, client_secret text NOT NULL, idempotency_key text NOT NULL, expires_at timestamp with time zone NOT NULL, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.payment_links (id uuid DEFAULT gen_random_uuid(), org_id uuid, invoice_id uuid, token_hash text, nonce text, expires_at timestamp with time zone NOT NULL, max_uses integer NOT NULL, used_count integer DEFAULT 0, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.payment_methods (id uuid DEFAULT gen_random_uuid(), org_id uuid, contact_id uuid NOT NULL, provider text DEFAULT 'stripe'::text, provider_method_id text NOT NULL, type text DEFAULT 'ach'::text, fingerprint text NOT NULL, last4 text NOT NULL, bank_brand text NOT NULL, exp_last4 text NOT NULL, status text DEFAULT 'active'::text, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.payment_schedules (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid, contact_id uuid NOT NULL, payment_method_id uuid NOT NULL, total_amount_cents integer, installment_amount_cents integer, installments_total integer, installments_paid integer DEFAULT 0, frequency text DEFAULT 'monthly'::text, next_charge_date date NOT NULL, status text DEFAULT 'active'::text, auto_charge boolean DEFAULT false, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.payments (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid NOT NULL, invoice_id uuid NOT NULL, bill_id uuid NOT NULL, amount_cents integer, currency text DEFAULT 'usd'::text, method text NOT NULL, reference text NOT NULL, received_at timestamp with time zone DEFAULT now(), metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), status text DEFAULT 'pending'::text, provider text NOT NULL, provider_payment_id text NOT NULL, fee_cents integer NOT NULL DEFAULT 0, net_cents integer NOT NULL, idempotency_key text NOT NULL, updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.permissions (key text, description text NOT NULL);
CREATE TABLE public.photos (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid NOT NULL, daily_log_id uuid NOT NULL, task_id uuid NOT NULL, file_id uuid, captured_by uuid NOT NULL, taken_at timestamp with time zone NOT NULL, tags text[] NOT NULL, created_at timestamp with time zone DEFAULT now());
CREATE TABLE public.plan_feature_limits (id uuid DEFAULT gen_random_uuid(), plan_code text NOT NULL, feature_key text NOT NULL, limit_type text, limit_value numeric NOT NULL, metadata jsonb DEFAULT '{}'::jsonb);
CREATE TABLE public.plan_features (feature_key text, name text, description text NOT NULL, category text NOT NULL, metadata jsonb DEFAULT '{}'::jsonb);
CREATE TABLE public.plans (code text, name text, pricing_model pricing_model DEFAULT 'subscription'::pricing_model, interval text NOT NULL DEFAULT 'monthly'::text, amount_cents integer NOT NULL, currency text NOT NULL DEFAULT 'usd'::text, is_active boolean DEFAULT true, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now());
CREATE TABLE public.portal_access_tokens (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid, contact_id uuid NOT NULL, company_id uuid NOT NULL, token text DEFAULT encode(gen_random_bytes(32), 'hex'::text), portal_type text, can_view_schedule boolean DEFAULT true, can_view_photos boolean DEFAULT true, can_view_documents boolean DEFAULT true, can_view_daily_logs boolean DEFAULT false, can_view_budget boolean DEFAULT false, can_approve_change_orders boolean DEFAULT true, can_submit_selections boolean DEFAULT true, can_create_punch_items boolean DEFAULT false, can_message boolean DEFAULT true, created_by uuid NOT NULL, created_at timestamp with time zone DEFAULT now(), expires_at timestamp with time zone NOT NULL, last_accessed_at timestamp with time zone NOT NULL, revoked_at timestamp with time zone NOT NULL, access_count integer DEFAULT 0, can_view_invoices boolean DEFAULT true, can_pay_invoices boolean DEFAULT false, can_view_rfis boolean DEFAULT true, can_view_submittals boolean DEFAULT true, can_respond_rfis boolean DEFAULT true, can_submit_submittals boolean DEFAULT true, can_download_files boolean DEFAULT true, max_access_count integer NOT NULL, pin_hash text NOT NULL, pin_required boolean DEFAULT false, pin_attempts integer DEFAULT 0, pin_locked_until timestamp with time zone NOT NULL, can_submit_invoices boolean DEFAULT true, can_view_commitments boolean DEFAULT true, can_view_bills boolean DEFAULT true);
CREATE TABLE public.project_members (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid, user_id uuid, role_id uuid, status membership_status DEFAULT 'active'::membership_status, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.project_selections (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid, category_id uuid, selected_option_id uuid NOT NULL, status text DEFAULT 'pending'::text, due_date date NOT NULL, selected_at timestamp with time zone NOT NULL, confirmed_at timestamp with time zone NOT NULL, selected_by_user_id uuid NOT NULL, selected_by_contact_id uuid NOT NULL, notes text NOT NULL, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.project_settings (project_id uuid, org_id uuid, settings jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.project_vendors (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid, company_id uuid NOT NULL, contact_id uuid NOT NULL, role text DEFAULT 'subcontractor'::text, scope text NOT NULL, status text DEFAULT 'active'::text, notes text NOT NULL, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.projects (id uuid DEFAULT gen_random_uuid(), org_id uuid, name text, status project_status DEFAULT 'active'::project_status, start_date date NOT NULL, end_date date NOT NULL, location jsonb NOT NULL, created_by uuid NOT NULL, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now(), total_value integer NOT NULL, property_type project_property_type NOT NULL, project_type project_work_type NOT NULL, description text NOT NULL, client_id uuid NOT NULL);
CREATE TABLE public.proposal_lines (id uuid DEFAULT gen_random_uuid(), org_id uuid, proposal_id uuid, cost_code_id uuid NOT NULL, line_type text DEFAULT 'item'::text, description text, quantity numeric DEFAULT 1, unit text NOT NULL, unit_cost_cents integer NOT NULL, markup_percent numeric NOT NULL, is_optional boolean NOT NULL DEFAULT false, is_selected boolean NOT NULL DEFAULT true, allowance_cents integer NOT NULL, notes text NOT NULL, sort_order integer NOT NULL DEFAULT 0, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now());
CREATE TABLE public.proposals (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid NULL, estimate_id uuid NULL, recipient_contact_id uuid NOT NULL, status text DEFAULT 'draft'::text, sent_at timestamp with time zone NOT NULL, accepted_at timestamp with time zone NOT NULL, rejected_at timestamp with time zone NOT NULL, snapshot jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now(), number text NOT NULL, title text NOT NULL, summary text NOT NULL, terms text NOT NULL, valid_until date NOT NULL, total_cents integer NOT NULL, signature_required boolean NOT NULL DEFAULT true, signature_data jsonb NOT NULL, token_hash text NOT NULL, viewed_at timestamp with time zone NOT NULL);
CREATE TABLE public.punch_items (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid, title text, description text NOT NULL, status text DEFAULT 'open'::text, due_date date NOT NULL, severity text NOT NULL, location text NOT NULL, assigned_to uuid NOT NULL, created_by uuid NOT NULL, resolved_by uuid NOT NULL, resolved_at timestamp with time zone NOT NULL, file_id uuid NOT NULL, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now(), created_via_portal boolean NOT NULL DEFAULT false, portal_token_id uuid NOT NULL);
CREATE TABLE public.qbo_connections (id uuid DEFAULT gen_random_uuid(), org_id uuid, realm_id text, access_token text, refresh_token text, token_expires_at timestamp with time zone, company_name text NOT NULL, connected_by uuid NOT NULL, connected_at timestamp with time zone DEFAULT now(), disconnected_at timestamp with time zone NOT NULL, status text DEFAULT 'active'::text, last_sync_at timestamp with time zone NOT NULL, last_error text NOT NULL, settings jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.qbo_invoice_reservations (id uuid DEFAULT gen_random_uuid(), org_id uuid, reserved_number text, reserved_by uuid NOT NULL, reserved_at timestamp with time zone DEFAULT now(), expires_at timestamp with time zone DEFAULT (now() + '00:30:00'::interval), used_by_invoice_id uuid NOT NULL, status text DEFAULT 'reserved'::text);
CREATE TABLE public.qbo_sync_records (id uuid DEFAULT gen_random_uuid(), org_id uuid, connection_id uuid, entity_type text, entity_id uuid, qbo_id text, qbo_sync_token text NOT NULL, last_synced_at timestamp with time zone DEFAULT now(), sync_direction text DEFAULT 'outbound'::text, status text DEFAULT 'synced'::text, error_message text NOT NULL, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now());
CREATE TABLE public.receipts (id uuid DEFAULT gen_random_uuid(), org_id uuid, payment_id uuid NOT NULL, file_id uuid NOT NULL, issued_at timestamp with time zone DEFAULT now(), metadata jsonb DEFAULT '{}'::jsonb);
CREATE TABLE public.reminder_deliveries (id uuid DEFAULT gen_random_uuid(), org_id uuid, reminder_id uuid, invoice_id uuid, channel text, status text DEFAULT 'pending'::text, sent_at timestamp with time zone NOT NULL, delivered_at timestamp with time zone NOT NULL, clicked_at timestamp with time zone NOT NULL, error_message text NOT NULL, provider_message_id text NOT NULL, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), created_on date NOT NULL DEFAULT ((created_at AT TIME ZONE 'utc'::text))::date);
CREATE TABLE public.reminders (id uuid DEFAULT gen_random_uuid(), org_id uuid, invoice_id uuid NOT NULL, channel text DEFAULT 'email'::text, schedule text DEFAULT 'before_due'::text, offset_days integer DEFAULT 0, template_id text NOT NULL, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.retainage (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid, contract_id uuid, invoice_id uuid NOT NULL, amount_cents integer, status text DEFAULT 'held'::text, held_at timestamp with time zone DEFAULT now(), released_at timestamp with time zone NOT NULL, release_invoice_id uuid NOT NULL, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.rfi_responses (id uuid DEFAULT gen_random_uuid(), org_id uuid, rfi_id uuid, response_type text, body text, responder_user_id uuid NOT NULL, responder_contact_id uuid NOT NULL, created_at timestamp with time zone DEFAULT now(), file_id uuid NOT NULL, portal_token_id uuid NOT NULL, created_via_portal boolean DEFAULT false, actor_ip inet NOT NULL);
CREATE TABLE public.rfis (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid, rfi_number integer, subject text, question text, status text DEFAULT 'open'::text, priority text NOT NULL, submitted_by uuid NOT NULL, submitted_by_company_id uuid NOT NULL, assigned_to uuid NOT NULL, submitted_at timestamp with time zone NOT NULL, due_date date NOT NULL, answered_at timestamp with time zone NOT NULL, closed_at timestamp with time zone NOT NULL, cost_impact_cents integer NOT NULL, schedule_impact_days integer NOT NULL, drawing_reference text NOT NULL, spec_reference text NOT NULL, location text NOT NULL, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now(), decision_status text NOT NULL, decision_note text NOT NULL, decided_by_user_id uuid NOT NULL, decided_by_contact_id uuid NOT NULL, decided_at timestamp with time zone NOT NULL, decided_via_portal boolean NOT NULL DEFAULT false, decision_portal_token_id uuid NOT NULL, last_response_at timestamp with time zone NOT NULL, attachment_file_id uuid NOT NULL, assigned_company_id uuid NOT NULL);
CREATE TABLE public.role_permissions (role_id uuid, permission_key text);
CREATE TABLE public.roles (id uuid DEFAULT gen_random_uuid(), key text, label text, scope role_scope, description text NOT NULL, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.schedule_assignments (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid, schedule_item_id uuid, user_id uuid NOT NULL, contact_id uuid NOT NULL, company_id uuid NOT NULL, role text NOT NULL DEFAULT 'assigned'::text, planned_hours numeric NOT NULL, actual_hours numeric NOT NULL DEFAULT 0, hourly_rate_cents integer NOT NULL, notes text NOT NULL, confirmed_at timestamp with time zone NOT NULL, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.schedule_baselines (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid, name text, description text NOT NULL, snapshot_at timestamp with time zone DEFAULT now(), items jsonb DEFAULT '[]'::jsonb, is_active boolean NOT NULL DEFAULT false, created_by uuid NOT NULL, created_at timestamp with time zone DEFAULT now());
CREATE TABLE public.schedule_dependencies (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid, item_id uuid, depends_on_item_id uuid, dependency_type text NOT NULL DEFAULT 'FS'::text, lag_days integer NOT NULL DEFAULT 0);
CREATE TABLE public.schedule_items (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid, name text, item_type text DEFAULT 'task'::text, status text DEFAULT 'planned'::text, start_date date NOT NULL, end_date date NOT NULL, progress integer NOT NULL DEFAULT 0, assigned_to uuid NOT NULL, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now(), phase text NOT NULL, trade text NOT NULL, location text NOT NULL, planned_hours numeric NOT NULL, actual_hours numeric NOT NULL, constraint_type text NOT NULL DEFAULT 'asap'::text, constraint_date date NOT NULL, is_critical_path boolean NOT NULL DEFAULT false, float_days integer NOT NULL DEFAULT 0, color text NOT NULL, sort_order integer NOT NULL DEFAULT 0);
CREATE TABLE public.schedule_templates (id uuid DEFAULT gen_random_uuid(), org_id uuid, name text, description text NOT NULL, project_type text NOT NULL, property_type text NOT NULL, items jsonb DEFAULT '[]'::jsonb, is_public boolean NOT NULL DEFAULT false, created_by uuid NOT NULL, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.selection_categories (id uuid DEFAULT gen_random_uuid(), org_id uuid, name text, description text NOT NULL, sort_order integer NOT NULL DEFAULT 0, is_template boolean DEFAULT false, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.selection_options (id uuid DEFAULT gen_random_uuid(), org_id uuid, category_id uuid, name text, description text NOT NULL, price_cents integer NOT NULL, price_type text NOT NULL, price_delta_cents integer NOT NULL, image_url text NOT NULL, file_id uuid NOT NULL, sku text NOT NULL, vendor text NOT NULL, lead_time_days integer NOT NULL, sort_order integer NOT NULL DEFAULT 0, is_default boolean DEFAULT false, is_available boolean DEFAULT true, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.submittal_items (id uuid DEFAULT gen_random_uuid(), org_id uuid, submittal_id uuid, item_number integer, description text, manufacturer text NOT NULL, model_number text NOT NULL, file_id uuid NOT NULL, status text NOT NULL, created_at timestamp with time zone DEFAULT now(), notes text NOT NULL, portal_token_id uuid NOT NULL, created_via_portal boolean DEFAULT false, responder_user_id uuid NOT NULL, responder_contact_id uuid NOT NULL);
CREATE TABLE public.submittals (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid, submittal_number integer, title text, description text NOT NULL, spec_section text NOT NULL, submittal_type text NOT NULL, status text DEFAULT 'pending'::text, submitted_by_company_id uuid NOT NULL, submitted_by_contact_id uuid NOT NULL, reviewed_by uuid NOT NULL, submitted_at timestamp with time zone NOT NULL, due_date date NOT NULL, reviewed_at timestamp with time zone NOT NULL, review_notes text NOT NULL, lead_time_days integer NOT NULL, required_on_site date NOT NULL, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now(), decision_status text NOT NULL, decision_note text NOT NULL, decision_by_user_id uuid NOT NULL, decision_by_contact_id uuid NOT NULL, decision_at timestamp with time zone NOT NULL, decision_via_portal boolean NOT NULL DEFAULT false, decision_portal_token_id uuid NOT NULL, attachment_file_id uuid NOT NULL, last_item_submitted_at timestamp with time zone NOT NULL, assigned_company_id uuid NOT NULL);
CREATE TABLE public.subscriptions (id uuid DEFAULT gen_random_uuid(), org_id uuid, plan_code text NOT NULL, status subscription_status DEFAULT 'trialing'::subscription_status, current_period_start timestamp with time zone DEFAULT now(), current_period_end timestamp with time zone NOT NULL, trial_ends_at timestamp with time zone NOT NULL, cancel_at timestamp with time zone NOT NULL, external_customer_id text NOT NULL, external_subscription_id text NOT NULL, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.support_contracts (id uuid DEFAULT gen_random_uuid(), org_id uuid, status text DEFAULT 'active'::text, starts_at timestamp with time zone DEFAULT now(), ends_at timestamp with time zone NOT NULL, details jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.task_assignments (id uuid DEFAULT gen_random_uuid(), org_id uuid, task_id uuid, user_id uuid NOT NULL, contact_id uuid NOT NULL, assigned_by uuid NOT NULL, role text NOT NULL, due_date date NOT NULL, created_at timestamp with time zone DEFAULT now());
CREATE TABLE public.tasks (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid, title text, description text NOT NULL, status task_status DEFAULT 'todo'::task_status, priority task_priority DEFAULT 'normal'::task_priority, start_date date NOT NULL, due_date date NOT NULL, completed_at timestamp with time zone NOT NULL, created_by uuid NOT NULL, assigned_by uuid NOT NULL, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.user_notification_prefs (id uuid DEFAULT gen_random_uuid(), org_id uuid, user_id uuid, email_enabled boolean DEFAULT true, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.variance_alerts (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid, budget_id uuid NOT NULL, cost_code_id uuid NOT NULL, alert_type text, threshold_percent integer NOT NULL, current_percent integer NOT NULL, budget_cents integer NOT NULL, actual_cents integer NOT NULL, variance_cents integer NOT NULL, status text DEFAULT 'active'::text, acknowledged_by uuid NOT NULL, acknowledged_at timestamp with time zone NOT NULL, notified_at timestamp with time zone NOT NULL, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now());
CREATE TABLE public.vendor_bills (id uuid DEFAULT gen_random_uuid(), org_id uuid, project_id uuid, commitment_id uuid NOT NULL, bill_number text NOT NULL, status text DEFAULT 'pending'::text, bill_date date NOT NULL, due_date date NOT NULL, total_cents integer NOT NULL, currency text DEFAULT 'usd'::text, submitted_by_contact_id uuid NOT NULL, file_id uuid NOT NULL, metadata jsonb DEFAULT '{}'::jsonb, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());
CREATE TABLE public.workflow_runs (id uuid DEFAULT gen_random_uuid(), org_id uuid, workflow_id uuid, status text DEFAULT 'pending'::text, payload jsonb DEFAULT '{}'::jsonb, result jsonb DEFAULT '{}'::jsonb, started_at timestamp with time zone DEFAULT now(), completed_at timestamp with time zone NOT NULL);
CREATE TABLE public.workflows (id uuid DEFAULT gen_random_uuid(), org_id uuid, name text, trigger text, conditions jsonb DEFAULT '{}'::jsonb, actions jsonb DEFAULT '{}'::jsonb, is_active boolean DEFAULT true, created_by uuid NOT NULL, created_at timestamp with time zone DEFAULT now(), updated_at timestamp with time zone DEFAULT now());

-- Indexes
CREATE INDEX allowances_org_idx ON public.allowances USING btree (org_id);
CREATE UNIQUE INDEX allowances_pkey ON public.allowances USING btree (id);
CREATE INDEX allowances_project_idx ON public.allowances USING btree (project_id);
CREATE UNIQUE INDEX app_users_email_idx ON public.app_users USING btree (lower((email)::text));
CREATE UNIQUE INDEX app_users_pkey ON public.app_users USING btree (id);
CREATE INDEX approvals_org_idx ON public.approvals USING btree (org_id);
CREATE UNIQUE INDEX approvals_pkey ON public.approvals USING btree (id);
CREATE INDEX audit_log_org_idx ON public.audit_log USING btree (org_id);
CREATE UNIQUE INDEX audit_log_pkey ON public.audit_log USING btree (id);
CREATE INDEX bill_lines_bill_idx ON public.bill_lines USING btree (bill_id);
CREATE INDEX bill_lines_cost_code_idx ON public.bill_lines USING btree (cost_code_id);
CREATE INDEX bill_lines_org_idx ON public.bill_lines USING btree (org_id);
CREATE UNIQUE INDEX bill_lines_pkey ON public.bill_lines USING btree (id);
CREATE INDEX budget_lines_budget_idx ON public.budget_lines USING btree (budget_id);
CREATE INDEX budget_lines_org_idx ON public.budget_lines USING btree (org_id);
CREATE UNIQUE INDEX budget_lines_pkey ON public.budget_lines USING btree (id);
CREATE INDEX budget_snapshots_org_idx ON public.budget_snapshots USING btree (org_id);
CREATE UNIQUE INDEX budget_snapshots_pkey ON public.budget_snapshots USING btree (id);
CREATE INDEX budget_snapshots_project_date_idx ON public.budget_snapshots USING btree (project_id, snapshot_date);
CREATE UNIQUE INDEX budget_snapshots_unique_idx ON public.budget_snapshots USING btree (budget_id, snapshot_date);
CREATE INDEX budgets_org_idx ON public.budgets USING btree (org_id);
CREATE UNIQUE INDEX budgets_pkey ON public.budgets USING btree (id);
CREATE INDEX budgets_project_idx ON public.budgets USING btree (project_id);
CREATE INDEX change_order_lines_change_order_idx ON public.change_order_lines USING btree (change_order_id);
CREATE INDEX change_order_lines_cost_code_idx ON public.change_order_lines USING btree (cost_code_id);
CREATE INDEX change_order_lines_org_idx ON public.change_order_lines USING btree (org_id);
CREATE UNIQUE INDEX change_order_lines_pkey ON public.change_order_lines USING btree (id);
CREATE INDEX change_orders_org_idx ON public.change_orders USING btree (org_id);
CREATE UNIQUE INDEX change_orders_pkey ON public.change_orders USING btree (id);
CREATE INDEX change_orders_project_idx ON public.change_orders USING btree (project_id);
CREATE UNIQUE INDEX change_requests_pkey ON public.change_requests USING btree (id);
CREATE INDEX commitment_lines_commitment_idx ON public.commitment_lines USING btree (commitment_id);
CREATE INDEX commitment_lines_cost_code_idx ON public.commitment_lines USING btree (cost_code_id);
CREATE INDEX commitment_lines_org_idx ON public.commitment_lines USING btree (org_id);
CREATE UNIQUE INDEX commitment_lines_pkey ON public.commitment_lines USING btree (id);
CREATE INDEX commitments_org_idx ON public.commitments USING btree (org_id);
CREATE UNIQUE INDEX commitments_pkey ON public.commitments USING btree (id);
CREATE INDEX commitments_project_idx ON public.commitments USING btree (project_id);
CREATE INDEX companies_org_idx ON public.companies USING btree (org_id);
CREATE UNIQUE INDEX companies_pkey ON public.companies USING btree (id);
CREATE UNIQUE INDEX contact_company_links_contact_id_company_id_key ON public.contact_company_links USING btree (contact_id, company_id);
CREATE INDEX contact_company_links_org_idx ON public.contact_company_links USING btree (org_id);
CREATE UNIQUE INDEX contact_company_links_pkey ON public.contact_company_links USING btree (id);
CREATE INDEX contacts_org_idx ON public.contacts USING btree (org_id);
CREATE UNIQUE INDEX contacts_pkey ON public.contacts USING btree (id);
CREATE INDEX contracts_org_idx ON public.contracts USING btree (org_id);
CREATE UNIQUE INDEX contracts_org_number_idx ON public.contracts USING btree (org_id, number) WHERE (number IS NOT NULL);
CREATE UNIQUE INDEX contracts_pkey ON public.contracts USING btree (id);
CREATE INDEX contracts_project_idx ON public.contracts USING btree (project_id);
CREATE INDEX conversations_org_idx ON public.conversations USING btree (org_id);
CREATE UNIQUE INDEX conversations_pkey ON public.conversations USING btree (id);
CREATE INDEX conversations_project_idx ON public.conversations USING btree (project_id);
CREATE UNIQUE INDEX cost_codes_org_id_code_key ON public.cost_codes USING btree (org_id, code);
CREATE INDEX cost_codes_org_idx ON public.cost_codes USING btree (org_id);
CREATE UNIQUE INDEX cost_codes_pkey ON public.cost_codes USING btree (id);
CREATE UNIQUE INDEX custom_field_values_field_id_entity_id_key ON public.custom_field_values USING btree (field_id, entity_id);
CREATE INDEX custom_field_values_org_idx ON public.custom_field_values USING btree (org_id);
CREATE UNIQUE INDEX custom_field_values_pkey ON public.custom_field_values USING btree (id);
CREATE UNIQUE INDEX custom_fields_org_id_entity_type_key_key ON public.custom_fields USING btree (org_id, entity_type, key);
CREATE INDEX custom_fields_org_idx ON public.custom_fields USING btree (org_id);
CREATE UNIQUE INDEX custom_fields_pkey ON public.custom_fields USING btree (id);
CREATE INDEX daily_log_entries_org_idx ON public.daily_log_entries USING btree (org_id);
CREATE UNIQUE INDEX daily_log_entries_pkey ON public.daily_log_entries USING btree (id);
CREATE INDEX daily_log_entries_project_idx ON public.daily_log_entries USING btree (project_id);
CREATE INDEX daily_logs_org_idx ON public.daily_logs USING btree (org_id);
CREATE UNIQUE INDEX daily_logs_pkey ON public.daily_logs USING btree (id);
CREATE INDEX daily_logs_project_idx ON public.daily_logs USING btree (project_id);
CREATE UNIQUE INDEX doc_versions_file_id_version_number_key ON public.doc_versions USING btree (file_id, version_number);
CREATE INDEX doc_versions_file_version_idx ON public.doc_versions USING btree (org_id, file_id, version_number DESC);
CREATE INDEX doc_versions_org_idx ON public.doc_versions USING btree (org_id);
CREATE UNIQUE INDEX doc_versions_pkey ON public.doc_versions USING btree (id);
CREATE INDEX draw_schedules_org_idx ON public.draw_schedules USING btree (org_id);
CREATE UNIQUE INDEX draw_schedules_pkey ON public.draw_schedules USING btree (id);
CREATE INDEX draw_schedules_project_idx ON public.draw_schedules USING btree (project_id);
CREATE UNIQUE INDEX draw_schedules_project_number_idx ON public.draw_schedules USING btree (project_id, draw_number);
CREATE INDEX draw_schedules_status_idx ON public.draw_schedules USING btree (status);
CREATE INDEX drawing_markups_creator_idx ON public.drawing_markups USING btree (org_id, created_by);
CREATE INDEX drawing_markups_data_idx ON public.drawing_markups USING gin (data);
CREATE UNIQUE INDEX drawing_markups_pkey ON public.drawing_markups USING btree (id);
CREATE INDEX drawing_markups_sheet_idx ON public.drawing_markups USING btree (org_id, drawing_sheet_id);
CREATE INDEX drawing_markups_version_idx ON public.drawing_markups USING btree (org_id, sheet_version_id);
CREATE INDEX drawing_pins_entity_idx ON public.drawing_pins USING btree (org_id, entity_type, entity_id);
CREATE UNIQUE INDEX drawing_pins_entity_sheet_unique ON public.drawing_pins USING btree (org_id, drawing_sheet_id, entity_type, entity_id);
CREATE UNIQUE INDEX drawing_pins_pkey ON public.drawing_pins USING btree (id);
CREATE INDEX drawing_pins_project_idx ON public.drawing_pins USING btree (org_id, project_id);
CREATE INDEX drawing_pins_sheet_idx ON public.drawing_pins USING btree (org_id, drawing_sheet_id);
CREATE INDEX drawing_pins_status_idx ON public.drawing_pins USING btree (org_id, status);
CREATE INDEX drawing_pins_version_idx ON public.drawing_pins USING btree (org_id, sheet_version_id);
CREATE UNIQUE INDEX drawing_revisions_pkey ON public.drawing_revisions USING btree (id);
CREATE INDEX drawing_revisions_project_idx ON public.drawing_revisions USING btree (org_id, project_id);
CREATE INDEX drawing_revisions_set_idx ON public.drawing_revisions USING btree (org_id, drawing_set_id);
CREATE INDEX drawing_sets_created_at_idx ON public.drawing_sets USING btree (org_id, created_at DESC);
CREATE INDEX drawing_sets_org_project_idx ON public.drawing_sets USING btree (org_id, project_id);
CREATE UNIQUE INDEX drawing_sets_pkey ON public.drawing_sets USING btree (id);
CREATE INDEX drawing_sets_status_idx ON public.drawing_sets USING btree (org_id, status);
CREATE UNIQUE INDEX drawing_sheet_versions_pkey ON public.drawing_sheet_versions USING btree (id);
CREATE INDEX drawing_sheet_versions_revision_idx ON public.drawing_sheet_versions USING btree (org_id, drawing_revision_id);
CREATE INDEX drawing_sheet_versions_sheet_idx ON public.drawing_sheet_versions USING btree (org_id, drawing_sheet_id);
CREATE INDEX drawing_sheets_discipline_idx ON public.drawing_sheets USING btree (org_id, project_id, discipline);
CREATE INDEX drawing_sheets_number_idx ON public.drawing_sheets USING btree (org_id, project_id, sheet_number);
CREATE UNIQUE INDEX drawing_sheets_pkey ON public.drawing_sheets USING btree (id);
CREATE INDEX drawing_sheets_project_idx ON public.drawing_sheets USING btree (org_id, project_id);
CREATE INDEX drawing_sheets_set_idx ON public.drawing_sheets USING btree (org_id, drawing_set_id);
CREATE UNIQUE INDEX entitlements_org_feature_limit_idx ON public.entitlements USING btree (org_id, feature_key, COALESCE(limit_type, 'default'::text));
CREATE UNIQUE INDEX entitlements_pkey ON public.entitlements USING btree (id);
CREATE INDEX estimate_items_estimate_idx ON public.estimate_items USING btree (estimate_id);
CREATE INDEX estimate_items_org_idx ON public.estimate_items USING btree (org_id);
CREATE UNIQUE INDEX estimate_items_pkey ON public.estimate_items USING btree (id);
CREATE INDEX estimate_templates_org_idx ON public.estimate_templates USING btree (org_id);
CREATE UNIQUE INDEX estimate_templates_pkey ON public.estimate_templates USING btree (id);
CREATE INDEX estimates_org_idx ON public.estimates USING btree (org_id);
CREATE UNIQUE INDEX estimates_pkey ON public.estimates USING btree (id);
CREATE INDEX estimates_project_idx ON public.estimates USING btree (project_id);
CREATE INDEX events_org_idx ON public.events USING btree (org_id);
CREATE UNIQUE INDEX events_pkey ON public.events USING btree (id);
CREATE UNIQUE INDEX feature_flags_org_id_flag_key_key ON public.feature_flags USING btree (org_id, flag_key);
CREATE UNIQUE INDEX feature_flags_pkey ON public.feature_flags USING btree (id);
CREATE INDEX file_access_events_created_idx ON public.file_access_events USING btree (org_id, created_at DESC);
CREATE INDEX file_access_events_file_idx ON public.file_access_events USING btree (org_id, file_id, created_at DESC);
CREATE UNIQUE INDEX file_access_events_pkey ON public.file_access_events USING btree (id);
CREATE INDEX file_access_events_user_idx ON public.file_access_events USING btree (org_id, actor_user_id, created_at DESC);
CREATE INDEX file_links_entity_idx ON public.file_links USING btree (org_id, entity_type, entity_id);
CREATE INDEX file_links_org_idx ON public.file_links USING btree (org_id);
CREATE UNIQUE INDEX file_links_pkey ON public.file_links USING btree (id);
CREATE INDEX file_links_project_idx ON public.file_links USING btree (project_id);
CREATE INDEX files_archived_idx ON public.files USING btree (org_id, archived_at) WHERE (archived_at IS NOT NULL);
CREATE INDEX files_folder_path_idx ON public.files USING btree (org_id, folder_path);
CREATE INDEX files_metadata_idx ON public.files USING gin (metadata);
CREATE INDEX files_org_idx ON public.files USING btree (org_id);
CREATE INDEX files_org_project_category_idx ON public.files USING btree (org_id, project_id, category);
CREATE INDEX files_org_project_created_idx ON public.files USING btree (org_id, project_id, created_at DESC);
CREATE UNIQUE INDEX files_pkey ON public.files USING btree (id);
CREATE INDEX files_project_idx ON public.files USING btree (project_id);
CREATE INDEX files_share_with_clients_idx ON public.files USING btree (project_id, share_with_clients) WHERE (share_with_clients = true);
CREATE INDEX files_share_with_subs_idx ON public.files USING btree (project_id, share_with_subs) WHERE (share_with_subs = true);
CREATE INDEX files_tags_idx ON public.files USING gin (tags);
CREATE INDEX form_instances_org_idx ON public.form_instances USING btree (org_id);
CREATE UNIQUE INDEX form_instances_pkey ON public.form_instances USING btree (id);
CREATE INDEX form_responses_org_idx ON public.form_responses USING btree (org_id);
CREATE UNIQUE INDEX form_responses_pkey ON public.form_responses USING btree (id);
CREATE INDEX form_templates_org_idx ON public.form_templates USING btree (org_id);
CREATE UNIQUE INDEX form_templates_pkey ON public.form_templates USING btree (id);
CREATE INDEX invoice_lines_cost_code_idx ON public.invoice_lines USING btree (cost_code_id);
CREATE INDEX invoice_lines_invoice_idx ON public.invoice_lines USING btree (invoice_id);
CREATE INDEX invoice_lines_org_idx ON public.invoice_lines USING btree (org_id);
CREATE UNIQUE INDEX invoice_lines_pkey ON public.invoice_lines USING btree (id);
CREATE INDEX invoice_views_invoice_idx ON public.invoice_views USING btree (invoice_id);
CREATE INDEX invoice_views_org_idx ON public.invoice_views USING btree (org_id);
CREATE UNIQUE INDEX invoice_views_pkey ON public.invoice_views USING btree (id);
CREATE INDEX invoice_views_viewed_at_idx ON public.invoice_views USING btree (viewed_at);
CREATE INDEX invoices_org_idx ON public.invoices USING btree (org_id);
CREATE UNIQUE INDEX invoices_pkey ON public.invoices USING btree (id);
CREATE INDEX invoices_project_idx ON public.invoices USING btree (project_id);
CREATE INDEX invoices_qbo_sync_idx ON public.invoices USING btree (org_id, qbo_sync_status) WHERE (qbo_sync_status IS NOT NULL);
CREATE INDEX invoices_status_idx ON public.invoices USING btree (status);
CREATE UNIQUE INDEX invoices_token_key ON public.invoices USING btree (token) WHERE (token IS NOT NULL);
CREATE INDEX invoices_viewed_at_idx ON public.invoices USING btree (viewed_at);
CREATE INDEX late_fee_applications_invoice_idx ON public.late_fee_applications USING btree (invoice_id);
CREATE INDEX late_fee_applications_org_idx ON public.late_fee_applications USING btree (org_id);
CREATE UNIQUE INDEX late_fee_applications_pkey ON public.late_fee_applications USING btree (id);
CREATE UNIQUE INDEX late_fee_applications_unique_idx ON public.late_fee_applications USING btree (invoice_id, late_fee_rule_id, application_number);
CREATE INDEX late_fees_org_idx ON public.late_fees USING btree (org_id);
CREATE UNIQUE INDEX late_fees_pkey ON public.late_fees USING btree (id);
CREATE INDEX late_fees_project_idx ON public.late_fees USING btree (project_id);
CREATE UNIQUE INDEX licenses_license_key_key ON public.licenses USING btree (license_key);
CREATE UNIQUE INDEX licenses_pkey ON public.licenses USING btree (id);
CREATE INDEX lien_waivers_org_idx ON public.lien_waivers USING btree (org_id);
CREATE INDEX lien_waivers_payment_idx ON public.lien_waivers USING btree (payment_id);
CREATE UNIQUE INDEX lien_waivers_pkey ON public.lien_waivers USING btree (id);
CREATE INDEX lien_waivers_project_idx ON public.lien_waivers USING btree (project_id);
CREATE INDEX lien_waivers_status_idx ON public.lien_waivers USING btree (status);
CREATE UNIQUE INDEX lien_waivers_token_idx ON public.lien_waivers USING btree (token_hash) WHERE (token_hash IS NOT NULL);
CREATE INDEX memberships_org_user_idx ON public.memberships USING btree (org_id, user_id);
CREATE UNIQUE INDEX memberships_pkey ON public.memberships USING btree (id);
CREATE INDEX mentions_org_idx ON public.mentions USING btree (org_id);
CREATE UNIQUE INDEX mentions_pkey ON public.mentions USING btree (id);
CREATE INDEX messages_conversation_idx ON public.messages USING btree (conversation_id);
CREATE INDEX messages_org_idx ON public.messages USING btree (org_id);
CREATE UNIQUE INDEX messages_pkey ON public.messages USING btree (id);
CREATE INDEX notification_deliveries_org_idx ON public.notification_deliveries USING btree (org_id);
CREATE UNIQUE INDEX notification_deliveries_pkey ON public.notification_deliveries USING btree (id);
CREATE INDEX notifications_org_idx ON public.notifications USING btree (org_id);
CREATE UNIQUE INDEX notifications_pkey ON public.notifications USING btree (id);
CREATE INDEX notifications_user_idx ON public.notifications USING btree (user_id);
CREATE UNIQUE INDEX org_settings_pkey ON public.org_settings USING btree (org_id);
CREATE UNIQUE INDEX orgs_pkey ON public.orgs USING btree (id);
CREATE UNIQUE INDEX orgs_slug_key ON public.orgs USING btree (slug);
CREATE INDEX outbox_org_idx ON public.outbox USING btree (org_id);
CREATE UNIQUE INDEX outbox_pkey ON public.outbox USING btree (id);
CREATE UNIQUE INDEX payment_intents_idempotency_idx ON public.payment_intents USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);
CREATE INDEX payment_intents_invoice_idx ON public.payment_intents USING btree (invoice_id);
CREATE INDEX payment_intents_org_idx ON public.payment_intents USING btree (org_id);
CREATE UNIQUE INDEX payment_intents_pkey ON public.payment_intents USING btree (id);
CREATE UNIQUE INDEX payment_intents_provider_intent_idx ON public.payment_intents USING btree (provider_intent_id) WHERE (provider_intent_id IS NOT NULL);
CREATE INDEX payment_intents_status_idx ON public.payment_intents USING btree (status);
CREATE INDEX payment_links_invoice_idx ON public.payment_links USING btree (invoice_id);
CREATE INDEX payment_links_org_idx ON public.payment_links USING btree (org_id);
CREATE UNIQUE INDEX payment_links_pkey ON public.payment_links USING btree (id);
CREATE UNIQUE INDEX payment_links_token_hash_idx ON public.payment_links USING btree (token_hash);
CREATE INDEX payment_methods_contact_idx ON public.payment_methods USING btree (contact_id);
CREATE INDEX payment_methods_org_idx ON public.payment_methods USING btree (org_id);
CREATE UNIQUE INDEX payment_methods_pkey ON public.payment_methods USING btree (id);
CREATE UNIQUE INDEX payment_methods_provider_method_idx ON public.payment_methods USING btree (provider, provider_method_id) WHERE (provider_method_id IS NOT NULL);
CREATE INDEX payment_schedules_next_charge_idx ON public.payment_schedules USING btree (next_charge_date) WHERE (status = 'active'::text);
CREATE INDEX payment_schedules_org_idx ON public.payment_schedules USING btree (org_id);
CREATE UNIQUE INDEX payment_schedules_pkey ON public.payment_schedules USING btree (id);
CREATE UNIQUE INDEX payments_idempotency_idx ON public.payments USING btree (idempotency_key) WHERE (idempotency_key IS NOT NULL);
CREATE INDEX payments_org_idx ON public.payments USING btree (org_id);
CREATE UNIQUE INDEX payments_pkey ON public.payments USING btree (id);
CREATE INDEX payments_project_idx ON public.payments USING btree (project_id);
CREATE INDEX payments_provider_idx ON public.payments USING btree (provider_payment_id);
CREATE INDEX payments_status_idx ON public.payments USING btree (status);
CREATE UNIQUE INDEX permissions_pkey ON public.permissions USING btree (key);
CREATE INDEX photos_org_idx ON public.photos USING btree (org_id);
CREATE UNIQUE INDEX photos_pkey ON public.photos USING btree (id);
CREATE INDEX photos_project_idx ON public.photos USING btree (project_id);
CREATE UNIQUE INDEX plan_feature_limits_pkey ON public.plan_feature_limits USING btree (id);
CREATE UNIQUE INDEX plan_feature_limits_plan_code_feature_key_limit_type_key ON public.plan_feature_limits USING btree (plan_code, feature_key, limit_type);
CREATE UNIQUE INDEX plan_features_pkey ON public.plan_features USING btree (feature_key);
CREATE UNIQUE INDEX plans_pkey ON public.plans USING btree (code);
CREATE INDEX portal_access_tokens_company_idx ON public.portal_access_tokens USING btree (company_id) WHERE (company_id IS NOT NULL);
CREATE INDEX portal_access_tokens_org_idx ON public.portal_access_tokens USING btree (org_id);
CREATE UNIQUE INDEX portal_access_tokens_pkey ON public.portal_access_tokens USING btree (id);
CREATE INDEX portal_access_tokens_portal_type_idx ON public.portal_access_tokens USING btree (portal_type);
CREATE INDEX portal_access_tokens_project_idx ON public.portal_access_tokens USING btree (project_id);
CREATE INDEX portal_access_tokens_token_idx ON public.portal_access_tokens USING btree (token) WHERE (revoked_at IS NULL);
CREATE UNIQUE INDEX portal_access_tokens_token_key ON public.portal_access_tokens USING btree (token);
CREATE INDEX project_members_org_idx ON public.project_members USING btree (org_id);
CREATE UNIQUE INDEX project_members_pkey ON public.project_members USING btree (id);
CREATE UNIQUE INDEX project_members_project_id_user_id_key ON public.project_members USING btree (project_id, user_id);
CREATE INDEX project_selections_org_idx ON public.project_selections USING btree (org_id);
CREATE UNIQUE INDEX project_selections_pkey ON public.project_selections USING btree (id);
CREATE UNIQUE INDEX project_selections_project_id_category_id_key ON public.project_selections USING btree (project_id, category_id);
CREATE INDEX project_selections_project_idx ON public.project_selections USING btree (project_id);
CREATE UNIQUE INDEX project_settings_pkey ON public.project_settings USING btree (project_id);
CREATE INDEX idx_project_vendors_company ON public.project_vendors USING btree (company_id);
CREATE INDEX idx_project_vendors_contact ON public.project_vendors USING btree (contact_id);
CREATE INDEX idx_project_vendors_project ON public.project_vendors USING btree (project_id);
CREATE UNIQUE INDEX project_vendors_pkey ON public.project_vendors USING btree (id);
CREATE UNIQUE INDEX project_vendors_project_id_company_id_key ON public.project_vendors USING btree (project_id, company_id);
CREATE UNIQUE INDEX project_vendors_project_id_contact_id_key ON public.project_vendors USING btree (project_id, contact_id);
CREATE INDEX idx_projects_client_id ON public.projects USING btree (client_id);
CREATE INDEX projects_org_idx ON public.projects USING btree (org_id);
CREATE UNIQUE INDEX projects_pkey ON public.projects USING btree (id);
CREATE INDEX proposal_lines_org_idx ON public.proposal_lines USING btree (org_id);
CREATE UNIQUE INDEX proposal_lines_pkey ON public.proposal_lines USING btree (id);
CREATE INDEX proposal_lines_proposal_idx ON public.proposal_lines USING btree (proposal_id);
CREATE INDEX proposals_org_idx ON public.proposals USING btree (org_id);
CREATE UNIQUE INDEX proposals_org_number_idx ON public.proposals USING btree (org_id, number) WHERE (number IS NOT NULL);
CREATE UNIQUE INDEX proposals_pkey ON public.proposals USING btree (id);
CREATE INDEX proposals_project_idx ON public.proposals USING btree (project_id);
CREATE UNIQUE INDEX proposals_token_hash_idx ON public.proposals USING btree (token_hash) WHERE (token_hash IS NOT NULL);
CREATE INDEX punch_items_org_idx ON public.punch_items USING btree (org_id);
CREATE UNIQUE INDEX punch_items_pkey ON public.punch_items USING btree (id);
CREATE INDEX punch_items_project_idx ON public.punch_items USING btree (project_id);
CREATE UNIQUE INDEX qbo_connections_org_active_idx ON public.qbo_connections USING btree (org_id) WHERE (status = 'active'::text);
CREATE UNIQUE INDEX qbo_connections_pkey ON public.qbo_connections USING btree (id);
CREATE UNIQUE INDEX qbo_invoice_reservations_active_idx ON public.qbo_invoice_reservations USING btree (org_id, reserved_number) WHERE (status = 'reserved'::text);
CREATE INDEX qbo_invoice_reservations_expires_idx ON public.qbo_invoice_reservations USING btree (expires_at) WHERE (status = 'reserved'::text);
CREATE UNIQUE INDEX qbo_invoice_reservations_pkey ON public.qbo_invoice_reservations USING btree (id);
CREATE UNIQUE INDEX qbo_sync_records_entity_idx ON public.qbo_sync_records USING btree (org_id, entity_type, entity_id);
CREATE UNIQUE INDEX qbo_sync_records_pkey ON public.qbo_sync_records USING btree (id);
CREATE INDEX qbo_sync_records_qbo_idx ON public.qbo_sync_records USING btree (connection_id, qbo_id);
CREATE INDEX receipts_org_idx ON public.receipts USING btree (org_id);
CREATE UNIQUE INDEX receipts_pkey ON public.receipts USING btree (id);
CREATE INDEX reminder_deliveries_invoice_idx ON public.reminder_deliveries USING btree (invoice_id);
CREATE INDEX reminder_deliveries_org_idx ON public.reminder_deliveries USING btree (org_id);
CREATE UNIQUE INDEX reminder_deliveries_pkey ON public.reminder_deliveries USING btree (id);
CREATE UNIQUE INDEX reminder_deliveries_unique_idx ON public.reminder_deliveries USING btree (reminder_id, invoice_id, channel, created_on);
CREATE INDEX reminders_invoice_idx ON public.reminders USING btree (invoice_id);
CREATE INDEX reminders_org_idx ON public.reminders USING btree (org_id);
CREATE UNIQUE INDEX reminders_pkey ON public.reminders USING btree (id);
CREATE INDEX retainage_contract_idx ON public.retainage USING btree (contract_id);
CREATE INDEX retainage_org_idx ON public.retainage USING btree (org_id);
CREATE UNIQUE INDEX retainage_pkey ON public.retainage USING btree (id);
CREATE INDEX retainage_project_idx ON public.retainage USING btree (project_id);
CREATE INDEX retainage_status_idx ON public.retainage USING btree (status);
CREATE UNIQUE INDEX rfi_responses_pkey ON public.rfi_responses USING btree (id);
CREATE INDEX rfi_responses_rfi_idx ON public.rfi_responses USING btree (rfi_id);
CREATE INDEX rfis_assigned_company_idx ON public.rfis USING btree (assigned_company_id);
CREATE INDEX rfis_org_idx ON public.rfis USING btree (org_id);
CREATE UNIQUE INDEX rfis_pkey ON public.rfis USING btree (id);
CREATE UNIQUE INDEX rfis_project_id_rfi_number_key ON public.rfis USING btree (project_id, rfi_number);
CREATE INDEX rfis_project_idx ON public.rfis USING btree (project_id);
CREATE UNIQUE INDEX role_permissions_pkey ON public.role_permissions USING btree (role_id, permission_key);
CREATE UNIQUE INDEX roles_key_key ON public.roles USING btree (key);
CREATE UNIQUE INDEX roles_pkey ON public.roles USING btree (id);
CREATE INDEX schedule_assignments_company_idx ON public.schedule_assignments USING btree (company_id) WHERE (company_id IS NOT NULL);
CREATE INDEX schedule_assignments_item_idx ON public.schedule_assignments USING btree (schedule_item_id);
CREATE INDEX schedule_assignments_org_idx ON public.schedule_assignments USING btree (org_id);
CREATE UNIQUE INDEX schedule_assignments_pkey ON public.schedule_assignments USING btree (id);
CREATE INDEX schedule_assignments_project_idx ON public.schedule_assignments USING btree (project_id);
CREATE INDEX schedule_assignments_user_idx ON public.schedule_assignments USING btree (user_id) WHERE (user_id IS NOT NULL);
CREATE UNIQUE INDEX schedule_baselines_active_idx ON public.schedule_baselines USING btree (project_id) WHERE (is_active = true);
CREATE INDEX schedule_baselines_org_idx ON public.schedule_baselines USING btree (org_id);
CREATE UNIQUE INDEX schedule_baselines_pkey ON public.schedule_baselines USING btree (id);
CREATE INDEX schedule_baselines_project_idx ON public.schedule_baselines USING btree (project_id);
CREATE INDEX schedule_dependencies_org_idx ON public.schedule_dependencies USING btree (org_id);
CREATE UNIQUE INDEX schedule_dependencies_pkey ON public.schedule_dependencies USING btree (id);
CREATE INDEX schedule_dependencies_project_idx ON public.schedule_dependencies USING btree (project_id);
CREATE UNIQUE INDEX schedule_dependencies_unique ON public.schedule_dependencies USING btree (item_id, depends_on_item_id);
CREATE INDEX schedule_items_org_idx ON public.schedule_items USING btree (org_id);
CREATE UNIQUE INDEX schedule_items_pkey ON public.schedule_items USING btree (id);
CREATE INDEX schedule_items_project_idx ON public.schedule_items USING btree (project_id);
CREATE INDEX schedule_templates_org_idx ON public.schedule_templates USING btree (org_id);
CREATE UNIQUE INDEX schedule_templates_pkey ON public.schedule_templates USING btree (id);
CREATE INDEX selection_categories_org_idx ON public.selection_categories USING btree (org_id);
CREATE UNIQUE INDEX selection_categories_pkey ON public.selection_categories USING btree (id);
CREATE INDEX selection_options_category_idx ON public.selection_options USING btree (category_id);
CREATE INDEX selection_options_org_idx ON public.selection_options USING btree (org_id);
CREATE UNIQUE INDEX selection_options_pkey ON public.selection_options USING btree (id);
CREATE UNIQUE INDEX submittal_items_pkey ON public.submittal_items USING btree (id);
CREATE UNIQUE INDEX submittal_items_submittal_id_item_number_key ON public.submittal_items USING btree (submittal_id, item_number);
CREATE INDEX submittal_items_submittal_idx ON public.submittal_items USING btree (submittal_id);
CREATE INDEX submittals_assigned_company_idx ON public.submittals USING btree (assigned_company_id);
CREATE INDEX submittals_org_idx ON public.submittals USING btree (org_id);
CREATE UNIQUE INDEX submittals_pkey ON public.submittals USING btree (id);
CREATE UNIQUE INDEX submittals_project_id_submittal_number_key ON public.submittals USING btree (project_id, submittal_number);
CREATE INDEX submittals_project_idx ON public.submittals USING btree (project_id);
CREATE UNIQUE INDEX subscriptions_org_active_idx ON public.subscriptions USING btree (org_id) WHERE (status = 'active'::subscription_status);
CREATE UNIQUE INDEX subscriptions_pkey ON public.subscriptions USING btree (id);
CREATE UNIQUE INDEX support_contracts_pkey ON public.support_contracts USING btree (id);
CREATE UNIQUE INDEX task_assignments_contact_unique ON public.task_assignments USING btree (task_id, contact_id) WHERE (contact_id IS NOT NULL);
CREATE INDEX task_assignments_org_idx ON public.task_assignments USING btree (org_id);
CREATE UNIQUE INDEX task_assignments_pkey ON public.task_assignments USING btree (id);
CREATE UNIQUE INDEX task_assignments_user_unique ON public.task_assignments USING btree (task_id, user_id) WHERE (user_id IS NOT NULL);
CREATE INDEX tasks_org_idx ON public.tasks USING btree (org_id);
CREATE UNIQUE INDEX tasks_pkey ON public.tasks USING btree (id);
CREATE INDEX tasks_project_idx ON public.tasks USING btree (project_id);
CREATE UNIQUE INDEX user_notification_prefs_pkey ON public.user_notification_prefs USING btree (id);
CREATE UNIQUE INDEX user_notification_prefs_user_org_idx ON public.user_notification_prefs USING btree (user_id, org_id);
CREATE INDEX variance_alerts_org_idx ON public.variance_alerts USING btree (org_id);
CREATE UNIQUE INDEX variance_alerts_pkey ON public.variance_alerts USING btree (id);
CREATE INDEX variance_alerts_project_idx ON public.variance_alerts USING btree (project_id);
CREATE INDEX variance_alerts_status_idx ON public.variance_alerts USING btree (status) WHERE (status = 'active'::text);
CREATE INDEX vendor_bills_org_idx ON public.vendor_bills USING btree (org_id);
CREATE UNIQUE INDEX vendor_bills_pkey ON public.vendor_bills USING btree (id);
CREATE INDEX vendor_bills_project_idx ON public.vendor_bills USING btree (project_id);
CREATE INDEX workflow_runs_org_idx ON public.workflow_runs USING btree (org_id);
CREATE UNIQUE INDEX workflow_runs_pkey ON public.workflow_runs USING btree (id);
CREATE INDEX workflow_runs_workflow_idx ON public.workflow_runs USING btree (workflow_id);
CREATE INDEX workflows_org_idx ON public.workflows USING btree (org_id);
CREATE UNIQUE INDEX workflows_pkey ON public.workflows USING btree (id);

-- Triggers
CREATE TRIGGER allowances_set_updated_at BEFORE UPDATE ON public.allowances FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER app_users_set_updated_at BEFORE UPDATE ON public.app_users FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER approvals_set_updated_at BEFORE UPDATE ON public.approvals FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER trg_budget_line_lock_guard BEFORE INSERT OR DELETE OR UPDATE ON public.budget_lines FOR EACH ROW EXECUTE FUNCTION public.budget_line_lock_guard();
CREATE TRIGGER budgets_set_updated_at BEFORE UPDATE ON public.budgets FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER trg_budget_lock_guard BEFORE UPDATE ON public.budgets FOR EACH ROW EXECUTE FUNCTION public.budget_lock_guard();
CREATE TRIGGER change_orders_set_updated_at BEFORE UPDATE ON public.change_orders FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER change_requests_set_updated_at BEFORE UPDATE ON public.change_requests FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER commitments_set_updated_at BEFORE UPDATE ON public.commitments FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER companies_set_updated_at BEFORE UPDATE ON public.companies FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER contacts_set_updated_at BEFORE UPDATE ON public.contacts FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER contracts_set_updated_at BEFORE UPDATE ON public.contracts FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER cost_codes_set_updated_at BEFORE UPDATE ON public.cost_codes FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER custom_field_values_set_updated_at BEFORE UPDATE ON public.custom_field_values FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER custom_fields_set_updated_at BEFORE UPDATE ON public.custom_fields FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER daily_logs_set_updated_at BEFORE UPDATE ON public.daily_logs FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER draw_schedules_set_updated_at BEFORE UPDATE ON public.draw_schedules FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER drawing_markups_updated_at BEFORE UPDATE ON public.drawing_markups FOR EACH ROW EXECUTE FUNCTION public.update_drawing_markups_updated_at();
CREATE TRIGGER drawing_pins_updated_at BEFORE UPDATE ON public.drawing_pins FOR EACH ROW EXECUTE FUNCTION public.update_drawing_pins_updated_at();
CREATE TRIGGER drawing_sets_updated_at BEFORE UPDATE ON public.drawing_sets FOR EACH ROW EXECUTE FUNCTION public.update_drawing_sets_updated_at();
CREATE TRIGGER drawing_sheets_updated_at BEFORE UPDATE ON public.drawing_sheets FOR EACH ROW EXECUTE FUNCTION public.update_drawing_sheets_updated_at();
CREATE TRIGGER estimate_templates_set_updated_at BEFORE UPDATE ON public.estimate_templates FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER estimates_set_updated_at BEFORE UPDATE ON public.estimates FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER feature_flags_set_updated_at BEFORE UPDATE ON public.feature_flags FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER files_set_updated_at BEFORE UPDATE ON public.files FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER form_instances_set_updated_at BEFORE UPDATE ON public.form_instances FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER form_templates_set_updated_at BEFORE UPDATE ON public.form_templates FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER invoices_set_updated_at BEFORE UPDATE ON public.invoices FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER late_fees_set_updated_at BEFORE UPDATE ON public.late_fees FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER licenses_set_updated_at BEFORE UPDATE ON public.licenses FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER lien_waivers_set_updated_at BEFORE UPDATE ON public.lien_waivers FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER memberships_set_updated_at BEFORE UPDATE ON public.memberships FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER org_settings_set_updated_at BEFORE UPDATE ON public.org_settings FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER orgs_set_updated_at BEFORE UPDATE ON public.orgs FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER outbox_set_updated_at BEFORE UPDATE ON public.outbox FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER payment_intents_set_updated_at BEFORE UPDATE ON public.payment_intents FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER payment_links_set_updated_at BEFORE UPDATE ON public.payment_links FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER payment_methods_set_updated_at BEFORE UPDATE ON public.payment_methods FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER payment_schedules_set_updated_at BEFORE UPDATE ON public.payment_schedules FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER payments_set_updated_at BEFORE UPDATE ON public.payments FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER project_members_set_updated_at BEFORE UPDATE ON public.project_members FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER project_selections_set_updated_at BEFORE UPDATE ON public.project_selections FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER project_settings_set_updated_at BEFORE UPDATE ON public.project_settings FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER projects_set_updated_at BEFORE UPDATE ON public.projects FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER proposals_set_updated_at BEFORE UPDATE ON public.proposals FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER punch_items_set_updated_at BEFORE UPDATE ON public.punch_items FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER qbo_connections_set_updated_at BEFORE UPDATE ON public.qbo_connections FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER reminders_set_updated_at BEFORE UPDATE ON public.reminders FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER retainage_set_updated_at BEFORE UPDATE ON public.retainage FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER rfis_set_updated_at BEFORE UPDATE ON public.rfis FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER roles_set_updated_at BEFORE UPDATE ON public.roles FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER schedule_assignments_set_updated_at BEFORE UPDATE ON public.schedule_assignments FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER schedule_items_set_updated_at BEFORE UPDATE ON public.schedule_items FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER schedule_templates_set_updated_at BEFORE UPDATE ON public.schedule_templates FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER selection_categories_set_updated_at BEFORE UPDATE ON public.selection_categories FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER selection_options_set_updated_at BEFORE UPDATE ON public.selection_options FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER submittals_set_updated_at BEFORE UPDATE ON public.submittals FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER subscriptions_set_updated_at BEFORE UPDATE ON public.subscriptions FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER support_contracts_set_updated_at BEFORE UPDATE ON public.support_contracts FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER tasks_set_updated_at BEFORE UPDATE ON public.tasks FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER vendor_bills_set_updated_at BEFORE UPDATE ON public.vendor_bills FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
CREATE TRIGGER workflows_set_updated_at BEFORE UPDATE ON public.workflows FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();

-- RLS Policies
CREATE POLICY allowances_access ON public.allowances FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY app_users_owner_access ON public.app_users FOR SELECT USING ((auth.role() = 'service_role'::text) OR (id = auth.uid()));
CREATE POLICY app_users_self_update ON public.app_users FOR UPDATE USING ((auth.role() = 'service_role'::text) OR (id = auth.uid()));
CREATE POLICY approvals_access ON public.approvals FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY audit_log_read ON public.audit_log FOR SELECT USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY bill_lines_access ON public.bill_lines FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY budget_lines_access ON public.budget_lines FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY budget_snapshots_access ON public.budget_snapshots FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY budgets_access ON public.budgets FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY change_order_lines_access ON public.change_order_lines FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY change_orders_access ON public.change_orders FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY change_requests_access ON public.change_requests FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY commitment_lines_access ON public.commitment_lines FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY commitments_access ON public.commitments FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY companies_access ON public.companies FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY contact_company_links_access ON public.contact_company_links FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY contacts_access ON public.contacts FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY contracts_access ON public.contracts FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY conversations_access ON public.conversations FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY cost_codes_access ON public.cost_codes FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY custom_field_values_access ON public.custom_field_values FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY custom_fields_access ON public.custom_fields FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY daily_log_entries_access ON public.daily_log_entries FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY daily_logs_access ON public.daily_logs FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY doc_versions_access ON public.doc_versions FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY draw_schedules_access ON public.draw_schedules FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY "Org members can delete drawing markups" ON public.drawing_markups FOR DELETE USING (is_org_member(org_id));
CREATE POLICY "Org members can insert drawing markups" ON public.drawing_markups FOR INSERT WITH CHECK (is_org_member(org_id));
CREATE POLICY "Org members can update drawing markups" ON public.drawing_markups FOR UPDATE USING (is_org_member(org_id)) WITH CHECK (is_org_member(org_id));
CREATE POLICY "Org members can view drawing markups" ON public.drawing_markups FOR SELECT USING (is_org_member(org_id));
CREATE POLICY "Org members can delete drawing pins" ON public.drawing_pins FOR DELETE USING (is_org_member(org_id));
CREATE POLICY "Org members can insert drawing pins" ON public.drawing_pins FOR INSERT WITH CHECK (is_org_member(org_id));
CREATE POLICY "Org members can update drawing pins" ON public.drawing_pins FOR UPDATE USING (is_org_member(org_id)) WITH CHECK (is_org_member(org_id));
CREATE POLICY "Org members can view drawing pins" ON public.drawing_pins FOR SELECT USING (is_org_member(org_id));
CREATE POLICY "Org members can delete drawing revisions" ON public.drawing_revisions FOR DELETE USING (is_org_member(org_id));
CREATE POLICY "Org members can insert drawing revisions" ON public.drawing_revisions FOR INSERT WITH CHECK (is_org_member(org_id));
CREATE POLICY "Org members can update drawing revisions" ON public.drawing_revisions FOR UPDATE USING (is_org_member(org_id)) WITH CHECK (is_org_member(org_id));
CREATE POLICY "Org members can view drawing revisions" ON public.drawing_revisions FOR SELECT USING (is_org_member(org_id));
CREATE POLICY "Org members can delete drawing sets" ON public.drawing_sets FOR DELETE USING (is_org_member(org_id));
CREATE POLICY "Org members can insert drawing sets" ON public.drawing_sets FOR INSERT WITH CHECK (is_org_member(org_id));
CREATE POLICY "Org members can update drawing sets" ON public.drawing_sets FOR UPDATE USING (is_org_member(org_id)) WITH CHECK (is_org_member(org_id));
CREATE POLICY "Org members can view drawing sets" ON public.drawing_sets FOR SELECT USING (is_org_member(org_id));
CREATE POLICY "Org members can delete drawing sheet versions" ON public.drawing_sheet_versions FOR DELETE USING (is_org_member(org_id));
CREATE POLICY "Org members can insert drawing sheet versions" ON public.drawing_sheet_versions FOR INSERT WITH CHECK (is_org_member(org_id));
CREATE POLICY "Org members can update drawing sheet versions" ON public.drawing_sheet_versions FOR UPDATE USING (is_org_member(org_id)) WITH CHECK (is_org_member(org_id));
CREATE POLICY "Org members can view drawing sheet versions" ON public.drawing_sheet_versions FOR SELECT USING (is_org_member(org_id));
CREATE POLICY "Org members can delete drawing sheets" ON public.drawing_sheets FOR DELETE USING (is_org_member(org_id));
CREATE POLICY "Org members can insert drawing sheets" ON public.drawing_sheets FOR INSERT WITH CHECK (is_org_member(org_id));
CREATE POLICY "Org members can update drawing sheets" ON public.drawing_sheets FOR UPDATE USING (is_org_member(org_id)) WITH CHECK (is_org_member(org_id));
CREATE POLICY "Org members can view drawing sheets" ON public.drawing_sheets FOR SELECT USING (is_org_member(org_id));
CREATE POLICY entitlements_access ON public.entitlements FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY estimate_items_access ON public.estimate_items FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY estimate_templates_access ON public.estimate_templates FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY estimates_access ON public.estimates FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY events_access ON public.events FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY feature_flags_access ON public.feature_flags FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY "Org members can insert file access events" ON public.file_access_events FOR INSERT WITH CHECK (is_org_member(org_id));
CREATE POLICY "Org members can view file access events" ON public.file_access_events FOR SELECT USING (is_org_member(org_id));
CREATE POLICY file_links_access ON public.file_links FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY files_access ON public.files FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY form_instances_access ON public.form_instances FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY form_responses_access ON public.form_responses FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY form_templates_access ON public.form_templates FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY invoice_lines_access ON public.invoice_lines FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY invoice_views_access ON public.invoice_views FOR SELECT USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY invoices_access ON public.invoices FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY late_fee_applications_access ON public.late_fee_applications FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY late_fees_access ON public.late_fees FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY licenses_access ON public.licenses FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY lien_waivers_access ON public.lien_waivers FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY memberships_access ON public.memberships FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY mentions_access ON public.mentions FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY messages_access ON public.messages FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY notification_deliveries_access ON public.notification_deliveries FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY notifications_access ON public.notifications FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY org_settings_access ON public.org_settings FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY orgs_access ON public.orgs FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(id)) WITH CHECK ((auth.role() = 'service_role'::text) OR (auth.uid() IS NOT NULL));
CREATE POLICY outbox_access ON public.outbox FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY payment_intents_access ON public.payment_intents FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY payment_links_access ON public.payment_links FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY payment_methods_access ON public.payment_methods FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY payment_schedules_access ON public.payment_schedules FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY payments_access ON public.payments FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY permissions_access ON public.permissions FOR SELECT USING (true);
CREATE POLICY photos_access ON public.photos FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY plan_feature_limits_read ON public.plan_feature_limits FOR SELECT USING (true);
CREATE POLICY plan_features_read ON public.plan_features FOR SELECT USING (true);
CREATE POLICY plans_read ON public.plans FOR SELECT USING (true);
CREATE POLICY portal_tokens_service_role ON public.portal_access_tokens FOR ALL USING ((auth.role() = 'service_role'::text));
CREATE POLICY project_members_access ON public.project_members FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY project_selections_access ON public.project_selections FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY project_settings_access ON public.project_settings FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY "Users can manage project vendors in their org" ON public.project_vendors FOR ALL USING ((org_id IN ( SELECT memberships.org_id
   FROM memberships
  WHERE ((memberships.user_id = auth.uid()) AND (memberships.status = 'active'::membership_status)))));
CREATE POLICY "Users can view project vendors in their org" ON public.project_vendors FOR SELECT USING ((org_id IN ( SELECT memberships.org_id
   FROM memberships
  WHERE ((memberships.user_id = auth.uid()) AND (memberships.status = 'active'::membership_status)))));
CREATE POLICY projects_access ON public.projects FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY proposal_lines_access ON public.proposal_lines FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY proposals_access ON public.proposals FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY punch_items_access ON public.punch_items FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY qbo_connections_access ON public.qbo_connections FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY qbo_invoice_reservations_access ON public.qbo_invoice_reservations FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY qbo_sync_records_access ON public.qbo_sync_records FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY receipts_access ON public.receipts FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY reminder_deliveries_access ON public.reminder_deliveries FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY reminders_access ON public.reminders FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY retainage_access ON public.retainage FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY rfi_responses_access ON public.rfi_responses FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY rfis_access ON public.rfis FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY role_permissions_access ON public.role_permissions FOR ALL USING ((auth.role() = 'service_role'::text));
CREATE POLICY roles_access ON public.roles FOR ALL USING ((auth.role() = 'service_role'::text));
CREATE POLICY schedule_assignments_access ON public.schedule_assignments FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY schedule_baselines_access ON public.schedule_baselines FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY schedule_dependencies_access ON public.schedule_dependencies FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY schedule_items_access ON public.schedule_items FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY schedule_templates_access ON public.schedule_templates FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY selection_categories_access ON public.selection_categories FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY selection_options_access ON public.selection_options FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY submittal_items_access ON public.submittal_items FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY submittals_access ON public.submittals FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY subscriptions_access ON public.subscriptions FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY support_contracts_access ON public.support_contracts FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY task_assignments_access ON public.task_assignments FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY tasks_access ON public.tasks FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY user_notification_prefs_access ON public.user_notification_prefs FOR ALL USING ((auth.role() = 'service_role'::text) OR ((auth.uid() = user_id) AND is_org_member(org_id))) WITH CHECK ((auth.role() = 'service_role'::text) OR ((auth.uid() = user_id) AND is_org_member(org_id)));
CREATE POLICY variance_alerts_access ON public.variance_alerts FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY vendor_bills_access ON public.vendor_bills FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY workflow_runs_access ON public.workflow_runs FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
CREATE POLICY workflows_access ON public.workflows FOR ALL USING ((auth.role() = 'service_role'::text) OR is_org_member(org_id)) WITH CHECK ((auth.role() = 'service_role'::text) OR is_org_member(org_id));
