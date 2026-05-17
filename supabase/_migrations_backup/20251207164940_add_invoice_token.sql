alter table public.invoices add column if not exists token text;
create unique index if not exists invoices_token_key on public.invoices(token) where token is not null;
update public.invoices
set token = gen_random_uuid()::text
where token is null and (client_visible = true or status in ('sent','paid','overdue'));
;
