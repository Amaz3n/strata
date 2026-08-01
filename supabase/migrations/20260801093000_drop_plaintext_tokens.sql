-- Drops the plaintext token columns now that every row carries its derived
-- columns and the application reads them.
--
-- Ordering matters: 20260801090000 added the columns,
-- scripts/backfill-portal-token-hashes.mjs populated them from the plaintext,
-- and the services were cut over to token_hash (lookup) / token_encrypted
-- (re-display) before this ran. Verified pre-drop: 29/29 portal tokens hashed
-- and encrypted with 29 distinct hashes, 3/3 invites hashed.
--
-- Irreversible: after this, a lost PORTAL_ACCESS_SECRET means no portal link
-- can ever be resolved or re-displayed again.

alter table public.portal_access_tokens drop column token;

alter table public.portal_access_tokens
  alter column token_hash set not null;

drop index if exists public.portal_access_tokens_token_hash_idx;

alter table public.portal_access_tokens
  add constraint portal_access_tokens_token_hash_key unique (token_hash);

alter table public.memberships drop column invite_token;
