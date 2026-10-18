-- One closing invoice per closing.
--
-- settleClosing looks for this closing's invoice and creates one when none is
-- found. Two settlements started together both found none and both billed the
-- home. The index is the fence: the second insert fails, the service reports
-- that the closing is already being settled, and a retry resumes the invoice
-- that won. Reversal never deletes or re-bills a closing invoice (it credits it
-- and cancels the closing; a re-sale is a new closing), so a plain unique index
-- over every status is correct.
--
-- Production had no closing invoices when this was written, so it builds clean.

create unique index if not exists invoices_closing_source_unique
  on public.invoices (org_id, (metadata ->> 'source_closing_id'))
  where metadata ->> 'invoice_kind' = 'closing';
