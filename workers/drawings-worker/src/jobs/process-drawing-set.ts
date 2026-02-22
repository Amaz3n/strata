import { SupabaseClient } from '@supabase/supabase-js';
import { execFileSync, execSync } from 'child_process';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { createHash } from 'crypto';
import { Job } from '../worker';
import { downloadPdfObject } from '../storage/pdfs';
import { uploadTileObject } from '../storage/tiles';

const SHEET_NUMBER_MAX_LENGTH = 50;
const SHEET_TITLE_MAX_LENGTH = 255;
const PAGE_TEXT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;

const DISCIPLINE_CODES = new Set([
  'A',
  'S',
  'M',
  'E',
  'P',
  'C',
  'L',
  'I',
  'FP',
  'G',
  'T',
  'SP',
  'D',
  'X',
]);

const SHEET_LABEL_PATTERNS = [
  /\b(?:SHEET|SHT)\s*(?:NO|NUMBER|#)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9./-]{1,19})\b/i,
  /\b(?:DWG|DRAWING)\s*(?:NO|NUMBER|#)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9./-]{1,19})\b/i,
];

const SHEET_TITLE_LABEL_PATTERNS = [
  /\b(?:SHEET\s+TITLE|DRAWING\s+TITLE)\s*[:\-]\s*(.+)$/i,
  /\bTITLE\s*[:\-]\s*(.+)$/i,
];

const GENERIC_SHEET_NUMBER_PATTERN = /\b(?:FP|SP|[ASMEPCLIGTDX])[-./]?\d{1,4}(?:\.\d{1,3})?[A-Z]?\b/gi;

type DetectionMethod = 'label' | 'pattern' | 'fallback';
type DetectionConfidence = 'high' | 'medium' | 'low';

type DetectedSheetMetadata = {
  sheetNumber: string;
  sheetTitle: string;
  discipline: string;
  method: DetectionMethod;
  confidence: DetectionConfidence;
  sourceLine: string | null;
};

export async function processDrawingSet(supabase: SupabaseClient, job: Job): Promise<void> {
  const { drawingSetId, projectId, sourceFileId } = job.payload;

  console.log(`📄 Processing drawing set ${drawingSetId}`);

  // Validate required parameters
  if (!drawingSetId || !projectId || !sourceFileId) {
    throw new Error('Missing required payload fields: drawingSetId, projectId, sourceFileId');
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

  const setTitle = normalizeWhitespace(drawingSet.title || '').trim() || 'Drawing Set';

  console.log(`Found drawing set: ${drawingSet.title}`);

  // Get file info
  const { data: fileRecord, error: fileError } = await supabase
    .from('files')
    .select('file_name, storage_path')
    .eq('id', sourceFileId)
    .eq('org_id', drawingSet.org_id)
    .eq('project_id', projectId)
    .single();

  if (fileError || !fileRecord) {
    throw new Error(`File record not found: ${fileError?.message}`);
  }

  // Download PDF to temp file
  const tempDir = tmpdir();
  const tempPdfPath = join(tempDir, `pdf-${drawingSetId}-${Date.now()}.pdf`);

  try {
    const pdfBytes = await downloadPdfObject({
      supabase,
      path: fileRecord.storage_path,
    });
    await fs.writeFile(tempPdfPath, pdfBytes);
    console.log(`Downloaded PDF: ${pdfBytes.length} bytes`);

    // Get page count using MuPDF
    const pageCount = getPdfPageCount(tempPdfPath);
    console.log(`PDF has ${pageCount} pages`);

    const pageTexts = extractPdfTextByPage(tempPdfPath, pageCount);
    const pagesWithText = pageTexts.reduce((count, text) => (text.trim() ? count + 1 : count), 0);
    console.log(`Extracted searchable text for ${pagesWithText}/${pageCount} pages`);

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
        try {
          await uploadTileObject({
            supabase,
            path: storagePngPath,
            bytes: pngBuffer,
            contentType: 'image/png',
            cacheControl: 'public, max-age=3600',
          });
          tempPngPaths.push(storagePngPath);
          console.log(`Uploaded page ${pageIndex + 1}/${pageCount}`);
        } catch (uploadError) {
          console.warn(`Failed to upload PNG for page ${pageIndex}:`, uploadError);
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
    const usedSheetNumbers = new Set<string>();
    for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
      const pageNumber = pageIndex + 1;
      const detectedSheet = detectSheetMetadata({
        pageText: pageTexts[pageIndex] || '',
        setTitle,
        pageNumber,
      });
      const sheetNumber = ensureUniqueSheetNumber(detectedSheet.sheetNumber, pageNumber, usedSheetNumbers);
      const sheetTitle = truncateValue(
        detectedSheet.sheetTitle || `${setTitle} - Page ${pageNumber}`,
        SHEET_TITLE_MAX_LENGTH
      );

      console.log(
        `[SheetDetect] Page ${pageNumber}: ${sheetNumber} (${detectedSheet.method}, ${detectedSheet.confidence})`
      );

      // Create sheet record
      const { data: sheet, error: sheetError } = await supabase
        .from('drawing_sheets')
        .insert({
          org_id: drawingSet.org_id,
          project_id: projectId,
          drawing_set_id: drawingSetId,
          sheet_number: sheetNumber,
          sheet_title: sheetTitle,
          discipline: detectedSheet.discipline,
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
            sheet_detection: {
              method: detectedSheet.method,
              confidence: detectedSheet.confidence,
              source_line: detectedSheet.sourceLine,
            },
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

function extractPdfTextByPage(pdfPath: string, pageCount: number): string[] {
  if (pageCount <= 0) return [];

  try {
    const rawOutput = execFileSync(
      'pdftotext',
      ['-layout', '-enc', 'UTF-8', pdfPath, '-'],
      {
        encoding: 'utf8',
        timeout: 180000,
        maxBuffer: PAGE_TEXT_MAX_BUFFER_BYTES,
      }
    );

    const normalized = rawOutput.replace(/\r/g, '');
    const pages = normalized.split('\f');
    if (pages.length > 0 && !pages[pages.length - 1].trim()) {
      pages.pop();
    }

    return Array.from({ length: pageCount }, (_, index) => pages[index] || '');
  } catch (error) {
    console.warn('Failed to extract PDF text with pdftotext:', error);
    return Array.from({ length: pageCount }, () => '');
  }
}

function detectSheetMetadata(input: {
  pageText: string;
  setTitle: string;
  pageNumber: number;
}): DetectedSheetMetadata {
  const { pageText, setTitle, pageNumber } = input;
  const normalizedText = pageText.replace(/\r/g, '');
  const lines = normalizedText
    .split('\n')
    .map((line) => normalizeWhitespace(line))
    .map((line) => line.trim())
    .filter(Boolean);

  const labeledMatch = detectSheetNumberFromLabel(lines);
  if (labeledMatch) {
    const titleFromLabel = detectSheetTitleFromLabels(lines);
    const titleFromNearby = titleFromLabel || detectSheetTitleNearLine(lines, labeledMatch.sourceLine);
    return {
      sheetNumber: truncateValue(labeledMatch.sheetNumber, SHEET_NUMBER_MAX_LENGTH),
      sheetTitle: truncateValue(titleFromNearby || `${setTitle} - Page ${pageNumber}`, SHEET_TITLE_MAX_LENGTH),
      discipline: detectDiscipline(labeledMatch.sheetNumber),
      method: 'label',
      confidence: 'high',
      sourceLine: labeledMatch.sourceLine,
    };
  }

  const patternMatch = detectSheetNumberByPattern(lines);
  if (patternMatch) {
    const title = detectSheetTitleNearLine(lines, patternMatch.sourceLine);
    return {
      sheetNumber: truncateValue(patternMatch.sheetNumber, SHEET_NUMBER_MAX_LENGTH),
      sheetTitle: truncateValue(title || `${setTitle} - Page ${pageNumber}`, SHEET_TITLE_MAX_LENGTH),
      discipline: detectDiscipline(patternMatch.sheetNumber),
      method: 'pattern',
      confidence: 'medium',
      sourceLine: patternMatch.sourceLine,
    };
  }

  return {
    sheetNumber: truncateValue(`${setTitle} - Page ${pageNumber}`, SHEET_NUMBER_MAX_LENGTH),
    sheetTitle: truncateValue(`${setTitle} - Page ${pageNumber}`, SHEET_TITLE_MAX_LENGTH),
    discipline: 'X',
    method: 'fallback',
    confidence: 'low',
    sourceLine: null,
  };
}

function detectSheetNumberFromLabel(lines: string[]): { sheetNumber: string; sourceLine: string } | null {
  for (const line of lines) {
    for (const pattern of SHEET_LABEL_PATTERNS) {
      const match = line.match(pattern);
      if (!match) continue;
      const sheetNumber = normalizeSheetNumberCandidate(match[1]);
      if (sheetNumber) {
        return { sheetNumber, sourceLine: line };
      }
    }
  }

  return null;
}

function detectSheetNumberByPattern(lines: string[]): { sheetNumber: string; sourceLine: string } | null {
  let best:
    | {
        sheetNumber: string;
        sourceLine: string;
        score: number;
      }
    | null = null;

  for (const line of lines) {
    const candidates = line.match(GENERIC_SHEET_NUMBER_PATTERN) || [];
    for (const candidate of candidates) {
      const normalized = normalizeSheetNumberCandidate(candidate);
      if (!normalized) continue;

      let score = 0;
      if (/[-./]/.test(normalized)) score += 2;
      if (/\b(SHEET|SHT|DWG|DRAWING)\b/i.test(line)) score += 4;
      if (line.length <= 40) score += 1;
      if (/\b(DETAIL|SCALE|DATE|ISSUED|REVISION|PROJECT)\b/i.test(line)) score -= 1;

      const numeric = parseInt(normalized.replace(/^[A-Z]+[-./]?/, ''), 10);
      if (Number.isFinite(numeric) && numeric >= 1900 && numeric <= 2100 && !/[-./]/.test(normalized)) {
        score -= 3;
      }

      if (!best || score > best.score) {
        best = { sheetNumber: normalized, sourceLine: line, score };
      }
    }
  }

  if (!best || best.score < 2) {
    return null;
  }

  return { sheetNumber: best.sheetNumber, sourceLine: best.sourceLine };
}

function detectSheetTitleFromLabels(lines: string[]): string | null {
  for (const line of lines) {
    for (const pattern of SHEET_TITLE_LABEL_PATTERNS) {
      const match = line.match(pattern);
      if (!match) continue;
      const title = sanitizeTitle(match[1]);
      if (title) return title;
    }
  }

  return null;
}

function detectSheetTitleNearLine(lines: string[], sourceLine: string): string | null {
  const index = lines.findIndex((line) => line === sourceLine);
  if (index === -1) return null;

  const nearbyIndexes = [index + 1, index + 2, index - 1, index - 2];
  for (const i of nearbyIndexes) {
    if (i < 0 || i >= lines.length) continue;
    const title = sanitizeTitle(lines[i]);
    if (title) return title;
  }

  return null;
}

function sanitizeTitle(raw: string): string | null {
  const value = normalizeWhitespace(raw).trim();
  if (!value) return null;
  if (value.length < 3 || value.length > SHEET_TITLE_MAX_LENGTH) return null;
  if (!/[A-Za-z]/.test(value)) return null;
  if (/^(SHEET|SHT|DWG|DRAWING|REVISION|PROJECT|SCALE)\b/i.test(value)) return null;
  return truncateValue(value, SHEET_TITLE_MAX_LENGTH);
}

function normalizeSheetNumberCandidate(raw: string): string | null {
  const value = raw
    .toUpperCase()
    .replace(/[^A-Z0-9./-]/g, '')
    .replace(/^[./-]+|[./-]+$/g, '');

  if (!value) return null;

  const valid = /^(?:FP|SP|[ASMEPCLIGTDX])[-./]?\d{1,4}(?:\.\d{1,3})?[A-Z]?$/.test(value);
  return valid ? truncateValue(value, SHEET_NUMBER_MAX_LENGTH) : null;
}

function detectDiscipline(sheetNumber: string): string {
  const normalized = sheetNumber.toUpperCase();
  if (normalized.startsWith('FP')) return 'FP';
  if (normalized.startsWith('SP')) return 'SP';
  const single = normalized[0];
  return DISCIPLINE_CODES.has(single) ? single : 'X';
}

function ensureUniqueSheetNumber(baseSheetNumber: string, pageNumber: number, used: Set<string>): string {
  const base = truncateValue(baseSheetNumber, SHEET_NUMBER_MAX_LENGTH);
  const baseKey = base.toUpperCase();
  if (!used.has(baseKey)) {
    used.add(baseKey);
    return base;
  }

  const firstSuffix = `-P${pageNumber}`;
  const firstCandidate = truncateForSuffix(base, firstSuffix, SHEET_NUMBER_MAX_LENGTH);
  const firstKey = firstCandidate.toUpperCase();
  if (!used.has(firstKey)) {
    used.add(firstKey);
    return firstCandidate;
  }

  let attempt = 2;
  while (attempt < 1000) {
    const suffix = `-${attempt}`;
    const candidate = truncateForSuffix(base, suffix, SHEET_NUMBER_MAX_LENGTH);
    const key = candidate.toUpperCase();
    if (!used.has(key)) {
      used.add(key);
      return candidate;
    }
    attempt += 1;
  }

  const finalFallback = truncateValue(`PAGE-${pageNumber}`, SHEET_NUMBER_MAX_LENGTH);
  used.add(finalFallback.toUpperCase());
  return finalFallback;
}

function truncateForSuffix(base: string, suffix: string, maxLength: number): string {
  const roomForBase = Math.max(1, maxLength - suffix.length);
  return `${base.slice(0, roomForBase)}${suffix}`;
}

function truncateValue(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return value.slice(0, maxLength).trim();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ');
}
