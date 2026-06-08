-- QBO inbound-only imports (journal entries) + sync pushability guard.
--
-- `pushable` distinguishes records Arc can safely round-trip back to QuickBooks (1:1 with a native
-- QBO transaction) from inbound-only "shadow" records (e.g. expenses projected from a journal entry,
-- where many Arc rows map to one QBO entity). The outbound sync refuses to push rows that are not
-- pushable, so importing them can never corrupt the customer's books. Existing rows default to true,
-- preserving today's two-way behavior.
ALTER TABLE "public"."qbo_sync_records"
  ADD COLUMN IF NOT EXISTS "pushable" boolean NOT NULL DEFAULT true;

-- Journal-entry-derived expenses are tagged so the sync layer and UI can recognize them.
ALTER TABLE "public"."project_expenses"
  DROP CONSTRAINT IF EXISTS "project_expenses_qbo_transaction_type_check";

ALTER TABLE "public"."project_expenses"
  ADD CONSTRAINT "project_expenses_qbo_transaction_type_check"
  CHECK (
    ("qbo_transaction_type" IS NULL)
    OR ("qbo_transaction_type" = ANY (ARRAY['purchase'::text, 'bill'::text, 'journal_entry'::text]))
  );
