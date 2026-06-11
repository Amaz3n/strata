-- Allow deleting a prospect by setting prospect_id to null on related records
-- instead of blocking the delete. Previously these FKs were NO ACTION (RESTRICT),
-- so deleting a prospect that had any estimate/bid_package/file/etc. failed.
-- projects and proposals already use ON DELETE SET NULL; prospect_contacts cascades.

alter table public.bid_packages
  drop constraint bid_packages_prospect_id_fkey,
  add constraint bid_packages_prospect_id_fkey
    foreign key (prospect_id) references public.prospects(id) on delete set null;

alter table public.documents
  drop constraint documents_prospect_id_fkey,
  add constraint documents_prospect_id_fkey
    foreign key (prospect_id) references public.prospects(id) on delete set null;

alter table public.envelopes
  drop constraint envelopes_prospect_id_fkey,
  add constraint envelopes_prospect_id_fkey
    foreign key (prospect_id) references public.prospects(id) on delete set null;

alter table public.estimates
  drop constraint estimates_prospect_id_fkey,
  add constraint estimates_prospect_id_fkey
    foreign key (prospect_id) references public.prospects(id) on delete set null;

alter table public.file_links
  drop constraint file_links_prospect_id_fkey,
  add constraint file_links_prospect_id_fkey
    foreign key (prospect_id) references public.prospects(id) on delete set null;

alter table public.files
  drop constraint files_prospect_id_fkey,
  add constraint files_prospect_id_fkey
    foreign key (prospect_id) references public.prospects(id) on delete set null;
