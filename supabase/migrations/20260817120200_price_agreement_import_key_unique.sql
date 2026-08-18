-- Price-book imports deduplicate on a content hash stored at
-- `metadata->>'import_key'`. That check used to be "read up to 10,000 existing
-- keys into memory, then insert what is missing" — unbounded past the read cap
-- and racy against a second upload of the same file. The service now looks up
-- only the keys in the batch; this index is what makes the race lose loudly
-- instead of duplicating the price book.
--
-- Verified clean before writing: 30 imported agreements, 0 duplicate keys.

create unique index if not exists vendor_price_agreements_import_key_uidx
  on public.vendor_price_agreements (org_id, (metadata->>'import_key'))
  where source = 'import' and metadata ? 'import_key';
