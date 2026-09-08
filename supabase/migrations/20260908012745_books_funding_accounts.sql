-- Actual disbursement funding and expense payment coding use native GL identity.
alter table public.org_funding_sources add column if not exists books_gl_account_id uuid references public.gl_accounts(id) on delete restrict;
create index if not exists org_funding_sources_books_account_idx on public.org_funding_sources(org_id,books_gl_account_id) where books_gl_account_id is not null;
create or replace function public.validate_books_funding_account()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.books_gl_account_id is not null and not exists(select 1 from public.gl_accounts where id=new.books_gl_account_id and org_id=new.org_id and account_type='asset' and subtype='cash' and active) then
    raise exception 'Funding source requires an active cash account in its organization';
  end if;
  return new;
end;
$$;
revoke all on function public.validate_books_funding_account() from public,anon,authenticated;
create trigger org_funding_sources_books_account_guard before insert or update of books_gl_account_id on public.org_funding_sources for each row execute function public.validate_books_funding_account();

insert into public.gl_accounts(org_id,code,name,account_type,subtype,normal_balance,cash_flow_category,is_system,active)
select org_id,'2220','Employee reimbursements payable','liability','other_liability','credit','operating',true,true
from public.books_settings on conflict(org_id,code) do nothing;
