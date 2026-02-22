-- Add covering indexes for org-scoped bid composite foreign keys.
-- These keep inserts/updates/deletes fast after adding composite FKs.

create index if not exists bid_packages_org_project_idx
  on bid_packages (org_id, project_id);

create index if not exists bid_invites_org_package_idx
  on bid_invites (org_id, bid_package_id);

create index if not exists bid_invites_org_company_idx
  on bid_invites (org_id, company_id);

create index if not exists bid_invites_org_contact_idx
  on bid_invites (org_id, contact_id)
  where contact_id is not null;

create index if not exists bid_access_tokens_org_invite_idx
  on bid_access_tokens (org_id, bid_invite_id);

create index if not exists bid_submissions_org_invite_idx
  on bid_submissions (org_id, bid_invite_id);

create index if not exists bid_awards_org_package_idx
  on bid_awards (org_id, bid_package_id);

create index if not exists bid_awards_org_submission_idx
  on bid_awards (org_id, awarded_submission_id);

create index if not exists bid_addenda_org_package_idx
  on bid_addenda (org_id, bid_package_id);

create index if not exists bid_addendum_ack_org_addendum_idx
  on bid_addendum_acknowledgements (org_id, bid_addendum_id);

create index if not exists bid_addendum_ack_org_invite_idx
  on bid_addendum_acknowledgements (org_id, bid_invite_id);
