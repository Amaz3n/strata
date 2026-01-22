import { SupabaseClient } from '@supabase/supabase-js';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { Job } from '../worker';

export async function processDrawingSet(supabase: SupabaseClient, job: Job): Promise<void> {
  const { drawingSetId, projectId, sourceFileId, storagePath } = job.payload;

  console.log(`📄 Processing drawing set ${drawingSetId}`);

  // Validate required parameters
  if (!drawingSetId || !projectId || !sourceFileId || !storagePath) {
    throw new Error('Missing required payload fields: drawingSetId, projectId, sourceFileId, storagePath');
  }

  // Get drawing set info
  const { data: drawingSet, error: setError } = await supabase
    .from('drawing_sets')
    .select('id, org_id, title')
    .eq('id', drawingSetId)
    .single();

  if (setError || !drawingSet) {
    throw new Error(`Drawing set not found: ${setError?.message}`);
  }

  console.log(`Found drawing set: ${drawingSet.title}`);

  // Get file info
  const { data: fileRecord, error: fileError } = await supabase
    .from('files')
    .select('file_name, storage_path')
    .eq('id', sourceFileId)
    .single();

  if (fileError || !fileRecord) {
    throw new Error(`File record not found: ${fileError?.message}`);
  }

  // Download PDF to temp file
  const tempDir = tmpdir();
  const tempPdfPath = join(tempDir, `pdf-${drawingSetId}-${Date.now()}.pdf`);

  try {
    const { data: pdfData, error: downloadError } = await supabase.storage
      .from('project-files')
      .download(storagePath);

    if (downloadError || !pdfData) {
      throw new Error(`Failed to download PDF: ${downloadError?.message}`);
    }

    const pdfBytes = new Uint8Array(await pdfData.arrayBuffer());
    await fs.writeFile(tempPdfPath, pdfBytes);
    console.log(`Downloaded PDF: ${pdfBytes.length} bytes`);

    // Get page count using MuPDF
    const pageCount = getPdfPageCount(tempPdfPath);
    console.log(`PDF has ${pageCount} pages`);

    // Create a default revision for this drawing set
    const { data: revision, error: revisionError } = await supabase
      .from('drawing_revisions')
      .insert({
        org_id: drawingSet.org_id,
        project_id: projectId,
        drawing_set_id: drawingSetId,
        revision_label: 'Initial',
        issued_date: new Date().toISOString(),
        notes: 'Initial upload',
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (revisionError || !revision) {
      throw new Error(`Failed to create revision: ${revisionError?.message}`);
    }

    console.log(`Created revision ${revision.id}`);

    // Create content hash for deterministic storage paths
    const hash = createHash('sha256').update(pdfBytes).digest('hex').slice(0, 16);
    const basePath = `${drawingSet.org_id}/${hash}`;

    // Extract all pages as PNGs using MuPDF (do this once for all pages)
    console.log(`Extracting and uploading ${pageCount} pages...`);
    const tempPngDir = join(tempDir, `pages-${drawingSetId}`);
    await fs.mkdir(tempPngDir, { recursive: true });

    // Extract pages one-by-one (more reliable, doesn't timeout)
    const tempPngPaths: string[] = [];
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      const localPngPath = join(tempPngDir, `page-${pageIndex}.png`);
      const storagePngPath = `${basePath}/temp/page-${pageIndex}.png`;

      try {
        // Extract single page with MuPDF (1-based indexing)
        execSync(
          `mutool draw -r 100 -o "${localPngPath}" "${tempPdfPath}" ${pageIndex + 1}`,
          {
            timeout: 120000, // 2 minutes per page
            encoding: 'utf8',
          }
        );

        console.log(`Extracted page ${pageIndex + 1}/${pageCount}`);

        // Upload PNG to drawings-tiles bucket
        const pngBuffer = await fs.readFile(localPngPath);
        const { error: uploadError } = await supabase.storage
          .from('drawings-tiles')
          .upload(storagePngPath, pngBuffer, {
            contentType: 'image/png',
            cacheControl: 'public, max-age=3600',
            upsert: true,
          });

        if (uploadError) {
          console.warn(`Failed to upload PNG for page ${pageIndex}:`, uploadError);
        } else {
          tempPngPaths.push(storagePngPath);
          console.log(`Uploaded page ${pageIndex + 1}/${pageCount}`);
        }

        // Clean up local PNG to save disk space
        await fs.unlink(localPngPath).catch(() => {});
      } catch (error: any) {
        console.error(`Failed to extract page ${pageIndex}:`, error.message);
        // Continue with other pages even if one fails
      }
    }

    console.log(`Processed ${tempPngPaths.length}/${pageCount} pages`);

    // Create drawing sheets and versions
    const sheetsCreated = [];
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      const sheetNumber = `${drawingSet.title} - Page ${pageIndex + 1}`;

      // Create sheet record
      const { data: sheet, error: sheetError } = await supabase
        .from('drawing_sheets')
        .insert({
          org_id: drawingSet.org_id,
          project_id: projectId,
          drawing_set_id: drawingSetId,
          sheet_number: sheetNumber,
          sheet_title: `${drawingSet.title} - Page ${pageIndex + 1}`,
          sort_order: pageIndex,
          share_with_clients: false,
          share_with_subs: false,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (sheetError || !sheet) {
        console.error(`Failed to create sheet for page ${pageIndex}:`, sheetError);
        continue;
      }

      // Create sheet version with temp PNG path
      const { data: version, error: versionError } = await supabase
        .from('drawing_sheet_versions')
        .insert({
          org_id: drawingSet.org_id,
          drawing_sheet_id: sheet.id,
          drawing_revision_id: revision.id,
          file_id: sourceFileId,
          page_index: pageIndex,
          extracted_metadata: {
            temp_png_path: tempPngPaths[pageIndex] || null,
            source_hash: hash,
            page_index: pageIndex,
          },
          created_at: new Date().toISOString(),
        })
        .select()
        .single();

      if (versionError || !version) {
        console.error(`Failed to create version for page ${pageIndex}:`, versionError);
        continue;
      }

      // Set the current revision on the sheet
      await supabase
        .from('drawing_sheets')
        .update({ current_revision_id: revision.id })
        .eq('id', sheet.id);

      sheetsCreated.push({ sheet, version });
      console.log(`Created sheet ${sheet.id} and version ${version.id} for page ${pageIndex}`);
    }

    // Queue tile generation jobs for each version
    for (const { version } of sheetsCreated) {
      await supabase.from('outbox').insert({
        org_id: drawingSet.org_id,
        job_type: 'generate_drawing_tiles',
        payload: { sheetVersionId: version.id },
        run_at: new Date().toISOString(),
      });
    }

    console.log(`Queued ${sheetsCreated.length} tile generation jobs`);

    // Update drawing set status
    await supabase
      .from('drawing_sets')
      .update({
        status: 'processing', // Still processing tiles
        total_pages: pageCount,
        processed_pages: 0, // Will be updated when tiles complete
      })
      .eq('id', drawingSetId);

    // Refresh the materialized view
    try {
      await supabase.rpc('refresh_drawing_sheets_list');
    } catch (e) {
      console.error('Failed to refresh drawing sheets list:', e);
    }

    console.log(`Successfully processed ${sheetsCreated.length} pages for drawing set ${drawingSetId}`);

  } finally {
    // Clean up temp files
    try {
      await fs.unlink(tempPdfPath);
    } catch (e) {
      console.warn('Failed to clean up temp PDF:', e);
    }

    try {
      const tempPngDir = join(tmpdir(), `pages-${drawingSetId}`);
      await fs.rm(tempPngDir, { recursive: true, force: true });
    } catch (e) {
      console.warn('Failed to clean up temp PNG directory:', e);
    }
  }
}

function getPdfPageCount(pdfPath: string): number {
  try {
    // Use MuPDF to get page count
    const output = execSync(`mutool info "${pdfPath}"`, {
      encoding: 'utf8',
      timeout: 30000, // 30 second timeout
    });

    // Parse the output to find Pages: X
    const pagesMatch = output.match(/Pages:\s*(\d+)/i);
    if (!pagesMatch) {
      throw new Error('Could not parse page count from MuPDF output');
    }

    const pageCount = parseInt(pagesMatch[1], 10);
    if (pageCount <= 0) {
      throw new Error(`Invalid page count: ${pageCount}`);
    }

    return pageCount;
  } catch (error) {
    console.error('Failed to get PDF page count:', error);
    throw new Error(`PDF page count detection failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}