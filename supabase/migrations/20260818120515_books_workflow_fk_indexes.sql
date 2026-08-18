-- Cover foreign-key lookups reported by the database advisor for the Books
-- workflow tables. These tables are new and currently empty, so creating the
-- indexes is inexpensive and avoids later delete/update scans.

create index if not exists receivable_payment_groups_created_by_idx
  on public.receivable_payment_groups (created_by);

create index if not exists receivable_payment_group_items_invoice_idx
  on public.receivable_payment_group_items (invoice_id);

create index if not exists receivable_payment_group_items_project_idx
  on public.receivable_payment_group_items (project_id);

create index if not exists books_overhead_budgets_created_by_idx
  on public.books_overhead_budgets (created_by);

create index if not exists books_overhead_budgets_updated_by_idx
  on public.books_overhead_budgets (updated_by);

create index if not exists books_overhead_budget_lines_account_idx
  on public.books_overhead_budget_lines (account_id);

create index if not exists books_deposit_batches_bank_transaction_idx
  on public.books_deposit_batches (bank_transaction_id);

create index if not exists books_deposit_batches_bank_account_idx
  on public.books_deposit_batches (bank_account_id);

create index if not exists books_deposit_batches_journal_entry_idx
  on public.books_deposit_batches (journal_entry_id);

create index if not exists books_deposit_batches_created_by_idx
  on public.books_deposit_batches (created_by);

create index if not exists books_deposit_batch_items_payment_idx
  on public.books_deposit_batch_items (payment_id);
