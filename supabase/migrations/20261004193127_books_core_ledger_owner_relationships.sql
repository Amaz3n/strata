-- Preserve IDs, cents, posting keys and source payloads. Existing corrupt links
-- must abort this upgrade; they require reviewed correction, never relabeling.
begin;
alter table public.gl_accounts add constraint gl_accounts_owner_identity_key unique(org_id,id);
alter table public.accounting_periods add constraint accounting_periods_owner_identity_key unique(org_id,id);
alter table public.accounting_facts add constraint accounting_facts_owner_identity_key unique(org_id,id);
alter table public.journal_entries add constraint journal_entries_owner_identity_key unique(org_id,id);

alter table public.gl_accounts add constraint gl_accounts_parent_owner_fk foreign key(org_id,parent_id) references public.gl_accounts(org_id,id);
alter table public.accounting_facts add constraint accounting_facts_supersedes_owner_fk foreign key(org_id,supersedes_fact_id) references public.accounting_facts(org_id,id);
alter table public.accounting_facts add constraint accounting_facts_reversal_owner_fk foreign key(org_id,reversal_of_fact_id) references public.accounting_facts(org_id,id);
alter table public.journal_entries add constraint journal_entries_fact_owner_fk foreign key(org_id,fact_id) references public.accounting_facts(org_id,id);
alter table public.journal_entries add constraint journal_entries_period_owner_fk foreign key(org_id,period_id) references public.accounting_periods(org_id,id);
alter table public.journal_entries add constraint journal_entries_reversal_owner_fk foreign key(org_id,reversal_of_entry_id) references public.journal_entries(org_id,id);
alter table public.journal_lines add constraint journal_lines_entry_owner_fk foreign key(org_id,entry_id) references public.journal_entries(org_id,id);
alter table public.journal_lines add constraint journal_lines_account_owner_fk foreign key(org_id,account_id) references public.gl_accounts(org_id,id);
commit;
