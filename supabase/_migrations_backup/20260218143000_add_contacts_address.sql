alter table if exists contacts
  add column if not exists address jsonb;
