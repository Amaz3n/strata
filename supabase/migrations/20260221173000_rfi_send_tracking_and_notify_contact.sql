alter table if exists rfis
  add column if not exists notify_contact_id uuid references contacts(id) on delete set null,
  add column if not exists sent_to_emails text[];

create index if not exists rfis_notify_contact_idx
  on rfis (notify_contact_id)
  where notify_contact_id is not null;
