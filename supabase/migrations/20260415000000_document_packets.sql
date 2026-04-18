-- Document Packets
CREATE TABLE IF NOT EXISTS public.document_packets (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  description text,
  packet_type text NOT NULL, -- 'client', 'sub', 'permit', 'closeout', 'custom'
  is_shared_with_clients boolean DEFAULT false,
  is_shared_with_subs boolean DEFAULT false,
  created_by uuid NOT NULL REFERENCES public.app_users(id),
  created_at timestamp with time zone DEFAULT now(),
  updated_at timestamp with time zone DEFAULT now()
);

-- Packet Items (junction table)
CREATE TABLE IF NOT EXISTS public.document_packet_items (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  org_id uuid NOT NULL REFERENCES public.orgs(id) ON DELETE CASCADE,
  packet_id uuid NOT NULL REFERENCES public.document_packets(id) ON DELETE CASCADE,
  file_id uuid NOT NULL REFERENCES public.files(id) ON DELETE CASCADE,
  sort_order integer DEFAULT 0,
  created_at timestamp with time zone DEFAULT now(),
  UNIQUE(packet_id, file_id)
);

-- Enable RLS
ALTER TABLE public.document_packets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.document_packet_items ENABLE ROW LEVEL SECURITY;

-- Policies for document_packets
CREATE POLICY document_packets_access ON public.document_packets
  FOR ALL USING (auth.role() = 'service_role' or is_org_member(org_id));

-- Policies for document_packet_items
CREATE POLICY document_packet_items_access ON public.document_packet_items
  FOR ALL USING (auth.role() = 'service_role' or is_org_member(org_id));

-- Add triggers for updated_at
CREATE TRIGGER tg_document_packets_set_updated_at
BEFORE UPDATE ON public.document_packets
FOR EACH ROW EXECUTE FUNCTION public.tg_set_updated_at();
