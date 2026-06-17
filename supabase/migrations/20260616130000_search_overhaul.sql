-- Search overhaul: typo-tolerant fuzzy matching over the unified search index.
--
-- Context: search_documents is the unified full-text index. pg_trgm is already
-- enabled, and search_embeddings.document_id already cascades on delete, so this
-- migration only adds the trigram index + fuzzy RPC that the new tiered retrieval
-- pipeline (FTS -> fuzzy -> semantic) relies on.

-- Trigram index over the combined title+body so similarity()/% can use an index
-- instead of a sequential scan. title and body are NOT NULL (default ''), so the
-- expression is null-safe and immutable.
CREATE INDEX IF NOT EXISTS idx_search_documents_trgm
  ON public.search_documents
  USING gin ((title || ' ' || body) public.gin_trgm_ops);

-- Fuzzy (trigram similarity) search over the unified index. Mirrors the shape of
-- public.match_search_embeddings so the application can merge results uniformly.
-- The `%` operator uses the trigram GIN index (pg_trgm.similarity_threshold GUC,
-- default 0.3); the explicit similarity floor keeps ranking predictable.
CREATE OR REPLACE FUNCTION public.match_search_documents_fuzzy(
  p_org_id uuid,
  p_query text,
  p_limit integer DEFAULT 20,
  p_entity_types text[] DEFAULT NULL::text[],
  p_threshold real DEFAULT 0.3
) RETURNS TABLE(
  document_id uuid,
  entity_type text,
  entity_id uuid,
  project_id uuid,
  title text,
  metadata jsonb,
  updated_at timestamp with time zone,
  similarity double precision
)
    LANGUAGE sql STABLE
    SET search_path TO 'public'
    AS $$
  select
    d.id as document_id,
    d.entity_type,
    d.entity_id,
    d.project_id,
    d.title,
    d.metadata,
    d.updated_at,
    similarity(d.title || ' ' || d.body, p_query) as similarity
  from public.search_documents d
  where d.org_id = p_org_id
    and (
      coalesce(array_length(p_entity_types, 1), 0) = 0
      or d.entity_type = any(p_entity_types)
    )
    and (d.title || ' ' || d.body) % p_query
    and similarity(d.title || ' ' || d.body, p_query) >= coalesce(p_threshold, 0.3)
  order by similarity(d.title || ' ' || d.body, p_query) desc
  limit greatest(1, least(coalesce(p_limit, 20), 120));
$$;

ALTER FUNCTION public.match_search_documents_fuzzy(uuid, text, integer, text[], real) OWNER TO postgres;

GRANT ALL ON FUNCTION public.match_search_documents_fuzzy(uuid, text, integer, text[], real) TO anon;
GRANT ALL ON FUNCTION public.match_search_documents_fuzzy(uuid, text, integer, text[], real) TO authenticated;
GRANT ALL ON FUNCTION public.match_search_documents_fuzzy(uuid, text, integer, text[], real) TO service_role;
