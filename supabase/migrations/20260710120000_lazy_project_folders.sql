-- Lazy project folders: stop pre-seeding the 13 default Documents folders.
-- Folders now materialize from files.folder_path (listChildFolders and the
-- list_project_child_folders RPC already union file paths), so empty seeded
-- folder rows are noise. Also renames the plan-PDF auto-file folder from
-- /drawings to /plans so it no longer collides with the Drawings tab.

-- 1. Move auto-filed plan PDFs from /drawings to /plans.
UPDATE files
SET folder_path = '/plans'
WHERE folder_path = '/drawings';

-- 2. File legacy drawing-upload source PDFs that landed at the Documents root
--    (uploads before Feb 2026 predate category-based auto-filing).
UPDATE files
SET folder_path = '/plans'
WHERE folder_path IS NULL
  AND (
    storage_path LIKE '%/drawings/uploads/%'
    OR storage_path LIKE '%/drawings/sets/%'
  );

-- 3. Drop seeded default folder rows that hold no active files. Folders with
--    files keep appearing via the files.folder_path union; empty ones vanish.
DELETE FROM project_file_folders pff
WHERE pff.path IN (
    '/drawings', '/contracts', '/permits', '/submittals', '/rfis', '/safety',
    '/financials', '/photos', '/daily-logs', '/messages', '/closeout',
    '/warranty', '/general'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM files f
    WHERE f.org_id = pff.org_id
      AND f.project_id = pff.project_id
      AND f.archived_at IS NULL
      AND (f.folder_path = pff.path OR f.folder_path LIKE pff.path || '/%')
  );
