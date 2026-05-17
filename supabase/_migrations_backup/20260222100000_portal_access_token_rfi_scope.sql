alter table if exists portal_access_tokens
  add column if not exists scoped_rfi_id uuid references rfis(id) on delete set null;

create index if not exists portal_access_tokens_scoped_rfi_idx
  on portal_access_tokens (scoped_rfi_id)
  where scoped_rfi_id is not null;
