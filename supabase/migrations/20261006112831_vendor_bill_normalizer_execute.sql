-- vendor_bills computes invoice_number_normalized and vendor_name_normalized from
-- these functions, so inserting or updating a bill evaluates them as the writing
-- role. 20260902144509 revoked EXECUTE from authenticated, which made every
-- in-app bill creation fail with "permission denied for function". Both are pure
-- IMMUTABLE string normalizers with no table access.
grant execute on function public.normalize_vendor_invoice_number(text) to authenticated;
grant execute on function public.normalize_vendor_name(text) to authenticated;
