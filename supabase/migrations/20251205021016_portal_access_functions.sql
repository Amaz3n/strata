CREATE OR REPLACE FUNCTION increment_portal_access(token_id_input UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE portal_access_tokens
  SET access_count = COALESCE(access_count, 0) + 1,
      last_accessed_at = now()
  WHERE id = token_id_input;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION photo_timeline_for_portal(p_project_id UUID, p_org_id UUID)
RETURNS TABLE(
  week_start TIMESTAMPTZ,
  week_end TIMESTAMPTZ,
  photos JSONB,
  summaries TEXT[]
) AS $$
  SELECT
    date_trunc('week', p.taken_at) AS week_start,
    date_trunc('week', p.taken_at) + INTERVAL '6 days' AS week_end,
    jsonb_agg(jsonb_build_object(
      'id', p.id,
      'url', f.storage_path,
      'taken_at', p.taken_at,
      'tags', p.tags
    ) ORDER BY p.taken_at) AS photos,
    ARRAY_AGG(dl.summary) FILTER (WHERE dl.summary IS NOT NULL) AS summaries
  FROM photos p
  JOIN files f ON f.id = p.file_id
  LEFT JOIN daily_logs dl ON dl.id = p.daily_log_id
  WHERE p.project_id = p_project_id AND p.org_id = p_org_id
  GROUP BY date_trunc('week', p.taken_at)
  ORDER BY week_start DESC;
$$ LANGUAGE SQL STABLE;;
