-- RLS performance sweep (July 2026 DB access review).
--
-- 1. project_vendors had two identical permissive policies evaluated on every
--    SELECT (advisor: multiple_permissive_policies) — the ALL policy already
--    covers SELECT, so the view-only duplicate is dropped.
-- 2. Four legacy policies embedded the memberships subquery inline instead of
--    using the tuned is_org_member() helper (backed by memberships_org_user_idx).
--    They are rewritten to the standard policy shape.
-- 3. Initplan sweep (advisor: auth_rls_initplan, 220 warnings): every policy
--    calling auth.uid()/auth.role() bare re-evaluated the function per row.
--    Wrapping the call in (SELECT ...) lets the planner hoist it to an initplan
--    evaluated once per query. Done as a catalog-driven rewrite because the
--    policies are templated; the SELECT-auth exclusion keeps it idempotent.

-- 1. Duplicate permissive policy ------------------------------------------------

drop policy if exists "Users can view project vendors in their org" on public.project_vendors;

-- 2. Legacy inline membership subqueries → is_org_member() ----------------------

alter policy "Users can manage project vendors in their org" on public.project_vendors
  using ((( select auth.role() ) = 'service_role') or is_org_member(org_id));

alter policy company_compliance_req_org_access on public.company_compliance_requirements
  using ((( select auth.role() ) = 'service_role') or is_org_member(org_id));

alter policy compliance_doc_types_org_access on public.compliance_document_types
  using ((( select auth.role() ) = 'service_role') or is_org_member(org_id));

alter policy compliance_docs_org_access on public.compliance_documents
  using ((( select auth.role() ) = 'service_role') or is_org_member(org_id));

-- 3. Initplan sweep --------------------------------------------------------------

do $$
declare
  p record;
  new_qual text;
  new_check text;
begin
  for p in
    select tablename, policyname, qual, with_check
    from pg_policies
    where schemaname = 'public'
      and (coalesce(qual, '') ~ 'auth\.(uid|role)\(\)'
        or coalesce(with_check, '') ~ 'auth\.(uid|role)\(\)')
      -- already-wrapped calls render as "( SELECT auth.uid() AS uid)"; skip them
      and coalesce(qual, '') not like '%SELECT auth.%'
      and coalesce(with_check, '') not like '%SELECT auth.%'
  loop
    new_qual := replace(replace(p.qual,
      'auth.uid()', '( SELECT auth.uid() )'),
      'auth.role()', '( SELECT auth.role() )');
    new_check := replace(replace(p.with_check,
      'auth.uid()', '( SELECT auth.uid() )'),
      'auth.role()', '( SELECT auth.role() )');

    execute format(
      'alter policy %I on public.%I%s%s',
      p.policyname,
      p.tablename,
      case when p.qual is not null then format(' using (%s)', new_qual) else '' end,
      case when p.with_check is not null then format(' with check (%s)', new_check) else '' end
    );
  end loop;
end $$;
