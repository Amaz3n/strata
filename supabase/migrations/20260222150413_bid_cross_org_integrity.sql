-- Enforce org-scoped referential integrity for bid management tables.
--
-- This prevents cross-tenant links such as:
-- - bid package from org A linked to project in org B
-- - bid invite from org A linked to company/contact in org B
-- - award rows linked to submissions/packages in another org

create unique index if not exists projects_org_id_id_uidx on projects (org_id, id);
create unique index if not exists companies_org_id_id_uidx on companies (org_id, id);
create unique index if not exists contacts_org_id_id_uidx on contacts (org_id, id);
create unique index if not exists bid_packages_org_id_id_uidx on bid_packages (org_id, id);
create unique index if not exists bid_invites_org_id_id_uidx on bid_invites (org_id, id);
create unique index if not exists bid_submissions_org_id_id_uidx on bid_submissions (org_id, id);
create unique index if not exists bid_addenda_org_id_id_uidx on bid_addenda (org_id, id);

-- bid_packages must point at a project in the same org.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bid_packages_org_project_fk'
  ) then
    alter table bid_packages
      add constraint bid_packages_org_project_fk
      foreign key (org_id, project_id)
      references projects (org_id, id)
      on delete cascade
      not valid;
  end if;
end
$$;

-- bid_invites must point at package/company/contact in the same org.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bid_invites_org_package_fk'
  ) then
    alter table bid_invites
      add constraint bid_invites_org_package_fk
      foreign key (org_id, bid_package_id)
      references bid_packages (org_id, id)
      on delete cascade
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'bid_invites_org_company_fk'
  ) then
    alter table bid_invites
      add constraint bid_invites_org_company_fk
      foreign key (org_id, company_id)
      references companies (org_id, id)
      on delete cascade
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'bid_invites_org_contact_fk'
  ) then
    alter table bid_invites
      add constraint bid_invites_org_contact_fk
      foreign key (org_id, contact_id)
      references contacts (org_id, id)
      not valid;
  end if;
end
$$;

-- bid_access_tokens and submissions must point at invites in the same org.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bid_access_tokens_org_invite_fk'
  ) then
    alter table bid_access_tokens
      add constraint bid_access_tokens_org_invite_fk
      foreign key (org_id, bid_invite_id)
      references bid_invites (org_id, id)
      on delete cascade
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'bid_submissions_org_invite_fk'
  ) then
    alter table bid_submissions
      add constraint bid_submissions_org_invite_fk
      foreign key (org_id, bid_invite_id)
      references bid_invites (org_id, id)
      on delete cascade
      not valid;
  end if;
end
$$;

-- bid_awards must reference package/submission in the same org.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bid_awards_org_package_fk'
  ) then
    alter table bid_awards
      add constraint bid_awards_org_package_fk
      foreign key (org_id, bid_package_id)
      references bid_packages (org_id, id)
      on delete cascade
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'bid_awards_org_submission_fk'
  ) then
    alter table bid_awards
      add constraint bid_awards_org_submission_fk
      foreign key (org_id, awarded_submission_id)
      references bid_submissions (org_id, id)
      not valid;
  end if;
end
$$;

-- addenda and acknowledgements must remain org-consistent.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'bid_addenda_org_package_fk'
  ) then
    alter table bid_addenda
      add constraint bid_addenda_org_package_fk
      foreign key (org_id, bid_package_id)
      references bid_packages (org_id, id)
      on delete cascade
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'bid_addendum_ack_org_addendum_fk'
  ) then
    alter table bid_addendum_acknowledgements
      add constraint bid_addendum_ack_org_addendum_fk
      foreign key (org_id, bid_addendum_id)
      references bid_addenda (org_id, id)
      on delete cascade
      not valid;
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'bid_addendum_ack_org_invite_fk'
  ) then
    alter table bid_addendum_acknowledgements
      add constraint bid_addendum_ack_org_invite_fk
      foreign key (org_id, bid_invite_id)
      references bid_invites (org_id, id)
      on delete cascade
      not valid;
  end if;
end
$$;
