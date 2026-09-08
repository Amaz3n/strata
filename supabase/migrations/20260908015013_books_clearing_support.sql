-- Keep reviewer evidence separate from the checklist's regenerated evidence.
alter table public.books_close_items add column if not exists support_review jsonb;
comment on column public.books_close_items.support_review is 'Approved clearing schedule, reviewer and exact ledger digest; new ledger activity invalidates the review.';
