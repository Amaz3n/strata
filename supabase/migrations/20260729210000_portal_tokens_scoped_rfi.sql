-- portal_access_tokens.scoped_rfi_id — schema drift repair.
--
-- Nine code files (portal-access, portal-links, drawings-distribution, the
-- /s /p /r portal pages) select, filter, and write this column, but no
-- migration ever created it — issuance distribution fails in production with
-- "column portal_access_tokens.scoped_rfi_id does not exist". A token carrying
-- scoped_rfi_id grants a sub access scoped to one RFI instead of the whole
-- portal surface.

alter table public.portal_access_tokens
  add column if not exists scoped_rfi_id uuid references public.rfis(id) on delete cascade;

comment on column public.portal_access_tokens.scoped_rfi_id is
  'When set, the token is scoped to a single RFI (sub RFI-response links). Null = normal portal-wide token.';

-- Lookups filter on it both ways: "tokens for this RFI" and "unscoped tokens".
create index if not exists portal_access_tokens_scoped_rfi_idx
  on public.portal_access_tokens (scoped_rfi_id)
  where scoped_rfi_id is not null;
