-- Trigger-only helper: match the service-only grants on the other Books guards.
revoke execute on function public.validate_books_asset_capacity() from public, anon, authenticated;
grant execute on function public.validate_books_asset_capacity() to service_role;
