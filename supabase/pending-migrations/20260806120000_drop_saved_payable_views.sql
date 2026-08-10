-- Drop the saved payables views table.
--
-- GATED, DESTRUCTIVE: this deletes user data. It lives in pending-migrations and
-- must not be applied, moved into migrations/, or swept in by a blanket db push
-- until a human approves it.
--
-- Saved views were retired in the payables pipeline rework: a view stored only
-- {queue, search, pageSize} — one tab click and a search string — which nobody
-- names and saves, while the picker and its Save button held permanent space on
-- both payables toolbars. Every reader of this table (lib/services/payable-views.ts
-- and its two actions) was deleted in the same change, so the table is now
-- unreferenced by the application.
--
-- If named filters return, they should be re-introduced as shareable org-level
-- filters over a real filter model (vendor, project, amount, due window, approver),
-- not restored from this schema.

drop table if exists public.saved_payable_views;
