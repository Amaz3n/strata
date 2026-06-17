"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.processDrawingSet = processDrawingSet;
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const os_1 = require("os");
const path_1 = require("path");
const crypto_1 = require("crypto");
const sharp_1 = __importDefault(require("sharp"));
const pdfs_1 = require("../storage/pdfs");
const tiles_1 = require("../storage/tiles");
const SHEET_NUMBER_MAX_LENGTH = 50;
const SHEET_TITLE_MAX_LENGTH = 255;
const PAGE_TEXT_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
const TILE_RENDER_DPI = Number.parseInt(process.env.DRAWINGS_TILE_RENDER_DPI ?? '96', 10);
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
async function processDrawingSet(supabase, job) {
    const { drawingSetId, projectId, sourceFileId } = job.payload;
    let draftRevisionId = job.payload.draftRevisionId;
    const targetSheetId = job.payload.targetSheetId;
    console.log(`📄 Processing drawing set ${drawingSetId} (draft revision ${draftRevisionId ?? 'none yet'})`);
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
    // Backward compatibility: older app deploys queue jobs without a pre-created
    // draft revision. Create one here so every upload still lands as a draft.
    if (!draftRevisionId) {
        const { count } = await supabase
            .from('drawing_revisions')
            .select('*', { count: 'exact', head: true })
            .eq('org_id', drawingSet.org_id)
            .eq('project_id', projectId)
            .eq('status', 'published');
        const fallbackLabel = !count ? 'Initial Set' : `Revision ${count + 1}`;
        const { data: created, error: createError } = await supabase
            .from('drawing_revisions')
            .insert({
            org_id: drawingSet.org_id,
            project_id: projectId,
            drawing_set_id: drawingSetId,
            revision_label: fallbackLabel,
            status: 'processing',
            processing_stage: 'queued',
            issued_date: new Date().toISOString(),
            source_file_id: sourceFileId,
        })
            .select('id')
            .single();
        if (createError || !created) {
            throw new Error(`Failed to create draft revision: ${createError?.message}`);
        }
        draftRevisionId = created.id;
        console.log(`Created fallback draft revision ${draftRevisionId}`);
    }
    // Download PDF to temp file
    const tempDir = (0, os_1.tmpdir)();
    const tempPdfPath = (0, path_1.join)(tempDir, `pdf-${drawingSetId}-${Date.now()}.pdf`);
    try {
        await updateRevisionStage(supabase, draftRevisionId, {
            status: 'processing',
            processing_stage: 'downloading_pdf',
            processed_pages: 0,
            error_message: null,
        });
        const pdfBytes = await (0, pdfs_1.downloadPdfObject)({
            supabase,
            path: fileRecord.storage_path,
        });
        await fs_1.promises.writeFile(tempPdfPath, pdfBytes);
        console.log(`Downloaded PDF: ${pdfBytes.length} bytes`);
        // Get page count using MuPDF
        await updateRevisionStage(supabase, draftRevisionId, {
            processing_stage: 'counting_pages',
        });
        const pageCount = getPdfPageCount(tempPdfPath);
        console.log(`PDF has ${pageCount} pages`);
        await updateRevisionStage(supabase, draftRevisionId, {
            processing_stage: 'extracting_text',
            total_pages: pageCount,
        });
        const pageTexts = extractPdfTextByPage(tempPdfPath, pageCount);
        const pagesWithText = pageTexts.reduce((count, text) => (text.trim() ? count + 1 : count), 0);
        console.log(`Extracted searchable text for ${pagesWithText}/${pageCount} pages`);
        // Use the draft revision created by the upload action. We process all pages
        // into draft versions under this revision without touching any live sheet —
        // nothing becomes current until the user publishes.
        const { data: revision, error: revisionError } = await supabase
            .from('drawing_revisions')
            .select('id, org_id, project_id')
            .eq('id', draftRevisionId)
            .eq('org_id', drawingSet.org_id)
            .single();
        if (revisionError || !revision) {
            throw new Error(`Draft revision not found: ${revisionError?.message}`);
        }
        console.log(`Processing into draft revision ${revision.id}`);
        let targetSheet = null;
        if (targetSheetId) {
            const { data, error } = await supabase
                .from('drawing_sheets')
                .select('*')
                .eq('org_id', drawingSet.org_id)
                .eq('project_id', projectId)
                .eq('id', targetSheetId)
                .maybeSingle();
            if (error || !data) {
                throw new Error(`Target sheet not found for one-sheet revision: ${error?.message ?? targetSheetId}`);
            }
            targetSheet = data;
            console.log(`One-sheet issuance target: ${targetSheet.sheet_number} (${targetSheet.id})`);
        }
        // Create content hash for deterministic storage paths
        const hash = (0, crypto_1.createHash)('sha256').update(pdfBytes).digest('hex').slice(0, 16);
        const basePath = `${drawingSet.org_id}/${hash}`;
        // Extract all pages as PNGs using MuPDF (do this once for all pages)
        console.log(`Extracting and uploading ${pageCount} pages...`);
        await updateRevisionStage(supabase, draftRevisionId, {
            processing_stage: 'rendering_pages',
        });
        const tempPngDir = (0, path_1.join)(tempDir, `pages-${drawingSetId}`);
        await fs_1.promises.mkdir(tempPngDir, { recursive: true });
        // Extract pages one-by-one (more reliable, doesn't timeout)
        const tempPngPaths = [];
        const tempLocalPngPaths = [];
        for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
            const localPngPath = (0, path_1.join)(tempPngDir, `page-${pageIndex}.png`);
            const storagePngPath = `${basePath}/temp/page-${pageIndex}.png`;
            try {
                // Extract single page with MuPDF (1-based indexing)
                (0, child_process_1.execSync)(`mutool draw -r ${Number.isFinite(TILE_RENDER_DPI) && TILE_RENDER_DPI > 0 ? TILE_RENDER_DPI : 96} -o "${localPngPath}" "${tempPdfPath}" ${pageIndex + 1}`, {
                    timeout: 120000, // 2 minutes per page
                    encoding: 'utf8',
                });
                console.log(`Extracted page ${pageIndex + 1}/${pageCount}`);
                // Upload PNG to drawings-tiles bucket
                const pngBuffer = await fs_1.promises.readFile(localPngPath);
                try {
                    await (0, tiles_1.uploadTileObject)({
                        supabase,
                        path: storagePngPath,
                        bytes: pngBuffer,
                        contentType: 'image/png',
                        cacheControl: 'public, max-age=3600',
                    });
                    tempPngPaths.push(storagePngPath);
                    tempLocalPngPaths.push(localPngPath);
                    console.log(`Uploaded page ${pageIndex + 1}/${pageCount}`);
                }
                catch (uploadError) {
                    console.warn(`Failed to upload PNG for page ${pageIndex}:`, uploadError);
                }
            }
            catch (error) {
                console.error(`Failed to extract page ${pageIndex}:`, error.message);
                // Continue with other pages even if one fails
            }
        }
        console.log(`Processed ${tempPngPaths.length}/${pageCount} pages`);
        // Create drawing sheets and versions
        await updateRevisionStage(supabase, draftRevisionId, {
            processing_stage: 'detecting_sheets',
        });
        const sheetsCreated = [];
        const usedSheetNumbers = new Set();
        for (let pageIndex = 0; pageIndex < pageCount; pageIndex++) {
            const pageNumber = pageIndex + 1;
            const detectedSheet = detectSheetMetadata({
                pageText: pageTexts[pageIndex] || '',
                setTitle,
                pageNumber,
            });
            const visionSheet = shouldUseVisionFallback(detectedSheet, pageTexts[pageIndex] || '', job.payload)
                ? await detectSheetMetadataWithVision({
                    localPngPath: tempLocalPngPaths[pageIndex] || null,
                    pageText: pageTexts[pageIndex] || '',
                    setTitle,
                    pageNumber,
                    initial: detectedSheet,
                    payload: job.payload,
                })
                : null;
            const resolvedSheet = mergeDetectedSheetMetadata(detectedSheet, visionSheet, setTitle, pageNumber);
            const sheetTitle = truncateValue(resolvedSheet.sheetTitle || `${setTitle} - Page ${pageNumber}`, SHEET_TITLE_MAX_LENGTH);
            console.log(`[SheetDetect] Page ${pageNumber}: ${resolvedSheet.sheetNumber} (${resolvedSheet.method}, ${resolvedSheet.confidence})`);
            const targetSheetNumber = targetSheet && pageIndex === 0
                ? truncateValue(targetSheet.sheet_number || resolvedSheet.sheetNumber, SHEET_NUMBER_MAX_LENGTH)
                : ensureUniqueSheetNumber(resolvedSheet.sheetNumber, pageNumber, usedSheetNumbers);
            const proposedSheetTitle = targetSheet && pageIndex === 0
                ? truncateValue(targetSheet.sheet_title || sheetTitle, SHEET_TITLE_MAX_LENGTH)
                : sheetTitle;
            const proposedDiscipline = targetSheet && pageIndex === 0
                ? normalizeDiscipline(targetSheet.discipline || resolvedSheet.discipline)
                : resolvedSheet.discipline;
            usedSheetNumbers.add(targetSheetNumber.toUpperCase());
            // Check if a sheet with this sheet_number already exists in this project
            const { data: existingSheet, error: findError } = targetSheet && pageIndex === 0
                ? { data: targetSheet, error: null }
                : await supabase
                    .from('drawing_sheets')
                    .select('*')
                    .eq('org_id', drawingSet.org_id)
                    .eq('project_id', projectId)
                    .eq('sheet_number', targetSheetNumber)
                    .maybeSingle();
            let sheet = existingSheet;
            let isNewSheet = false;
            if (existingSheet) {
                // Draft: do NOT mutate the live sheet (its current_revision_id, title,
                // discipline and set assignment stay as published). We only attach a new
                // draft version below; the proposed metadata rides on the version and is
                // applied at publish time.
                sheet = existingSheet;
            }
            else {
                // Brand-new sheet number. Create it draft-only: current_revision_id stays
                // NULL so the sheets list MV hides it until this revision is published.
                isNewSheet = true;
                if (pageIndex === 0) {
                    await updateRevisionStage(supabase, draftRevisionId, {
                        processing_stage: 'creating_sheets',
                    });
                }
                const { data: newSheet, error: sheetError } = await supabase
                    .from('drawing_sheets')
                    .insert({
                    org_id: drawingSet.org_id,
                    project_id: projectId,
                    drawing_set_id: drawingSetId,
                    sheet_number: targetSheetNumber,
                    sheet_title: proposedSheetTitle,
                    discipline: proposedDiscipline,
                    current_revision_id: null,
                    sort_order: pageIndex,
                    share_with_clients: false,
                    share_with_subs: false,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                })
                    .select()
                    .single();
                if (sheetError || !newSheet) {
                    console.error(`Failed to create sheet for page ${pageIndex}:`, sheetError);
                    continue;
                }
                sheet = newSheet;
            }
            // Create the draft sheet version. The proposed sheet number/title/discipline
            // are stored on the version so the review screen can show + edit them and
            // publish can apply them to the sheet.
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
                    is_new_sheet: isNewSheet,
                    proposed: {
                        sheet_number: targetSheetNumber,
                        sheet_title: proposedSheetTitle,
                        discipline: proposedDiscipline,
                    },
                    sheet_detection: {
                        method: resolvedSheet.method,
                        confidence: resolvedSheet.confidence,
                        source_line: resolvedSheet.sourceLine,
                        vision_used: Boolean(visionSheet),
                        vision_notes: visionSheet?.notes ?? [],
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
            sheetsCreated.push({ sheet, version });
            console.log(`Created draft version ${version.id} for sheet ${sheet.id} (page ${pageIndex})`);
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
        // The draft is ready for review. Tiles keep generating in the background;
        // the review screen works off thumbnails, so it doesn't need to wait. The
        // live drawing set is intentionally left untouched.
        await updateRevisionStage(supabase, draftRevisionId, {
            status: 'draft',
            processing_stage: 'ready',
            total_pages: pageCount,
            processed_pages: pageCount,
        });
        console.log(`Draft revision ${draftRevisionId} ready for review (${sheetsCreated.length} pages)`);
    }
    catch (error) {
        // Surface the failure on the draft revision so the review UI can react.
        try {
            await updateRevisionStage(supabase, draftRevisionId, {
                processing_stage: 'failed',
                error_message: error instanceof Error ? error.message : String(error),
            });
        }
        catch (stageError) {
            console.warn('Failed to record draft failure:', stageError);
        }
        throw error;
    }
    finally {
        // Clean up temp files
        try {
            await fs_1.promises.unlink(tempPdfPath);
        }
        catch (e) {
            console.warn('Failed to clean up temp PDF:', e);
        }
        try {
            const tempPngDir = (0, path_1.join)((0, os_1.tmpdir)(), `pages-${drawingSetId}`);
            await fs_1.promises.rm(tempPngDir, { recursive: true, force: true });
        }
        catch (e) {
            console.warn('Failed to clean up temp PNG directory:', e);
        }
    }
}
async function updateRevisionStage(supabase, revisionId, updates) {
    const payload = {};
    if (updates.status !== undefined)
        payload.status = updates.status;
    if (updates.total_pages !== undefined)
        payload.total_pages = updates.total_pages;
    if (updates.processed_pages !== undefined)
        payload.processed_pages = updates.processed_pages;
    if (updates.processing_stage !== undefined)
        payload.processing_stage = updates.processing_stage;
    if (updates.error_message !== undefined)
        payload.error_message = updates.error_message;
    await supabase.from('drawing_revisions').update(payload).eq('id', revisionId);
}
function shouldUseVisionFallback(detected, pageText, payload) {
    const provider = getVisionProvider(payload);
    if (!getVisionApiKey(provider))
        return false;
    if (!pageText.trim())
        return true;
    return detected.method !== 'label' || detected.confidence === 'low';
}
async function detectSheetMetadataWithVision(input) {
    const { localPngPath, pageText, setTitle, pageNumber, initial, payload } = input;
    const provider = getVisionProvider(payload);
    const apiKey = getVisionApiKey(provider);
    if (!apiKey || !localPngPath)
        return null;
    try {
        const images = await buildVisionInputs(localPngPath);
        if (images.length === 0)
            return null;
        const model = getVisionModel(provider, payload);
        const prompt = [
            'You are extracting metadata from one construction drawing page.',
            `Project set title: ${setTitle}`,
            `Page number in upload order: ${pageNumber}`,
            `Current text-based guess: sheet_number=${initial.sheetNumber}; sheet_title=${initial.sheetTitle}; discipline=${initial.discipline}; method=${initial.method}; confidence=${initial.confidence}`,
            pageText.trim() ? `Extracted PDF text (may be partial): ${truncateValue(pageText, 4000)}` : 'Extracted PDF text is empty, so rely on the image.',
            'Return only JSON with these keys: sheet_number, sheet_title, discipline, confidence, notes.',
            'discipline must be one of: A, S, M, E, P, FP, C, L, I, G, T, SP, D, X.',
            'confidence must be one of: high, medium, low.',
            'If uncertain, preserve the existing guess unless the image clearly shows a better answer.',
            'Prefer title block values like E1.1, A-101, S2.0, etc.',
        ].join('\n');
        const rawText = await generateVisionResponseText({
            provider,
            apiKey,
            model,
            prompt,
            images,
            pageNumber,
        });
        if (!rawText)
            return null;
        const parsed = parseVisionJson(rawText);
        if (!parsed)
            return null;
        const sheetNumber = normalizeSheetNumberCandidate(parsed.sheet_number ?? '');
        const discipline = typeof parsed.discipline === 'string' && DISCIPLINE_CODES.has(parsed.discipline.toUpperCase())
            ? parsed.discipline.toUpperCase()
            : sheetNumber
                ? detectDiscipline(sheetNumber)
                : null;
        const sheetTitle = sanitizeTitle(parsed.sheet_title ?? '');
        const confidence = normalizeConfidence(parsed.confidence);
        const notes = Array.isArray(parsed.notes)
            ? parsed.notes.filter((note) => typeof note === 'string').slice(0, 6)
            : [];
        return {
            sheetNumber,
            sheetTitle,
            discipline,
            confidence,
            notes,
        };
    }
    catch (error) {
        console.warn(`[Vision] Failed for page ${pageNumber}:`, error);
        return null;
    }
}
function getPayloadVisionConfig(payload) {
    const raw = payload?.aiVision ?? payload?.ai_vision;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return {};
    const record = raw;
    const providerValue = typeof record.provider === 'string' ? record.provider.trim().toLowerCase() : '';
    const modelValue = typeof record.model === 'string' ? record.model.trim() : '';
    const provider = providerValue === 'openai' || providerValue === 'google' ? providerValue : undefined;
    return {
        provider,
        model: modelValue || undefined,
    };
}
function getVisionProvider(payload) {
    const payloadProvider = getPayloadVisionConfig(payload).provider;
    if (payloadProvider)
        return payloadProvider;
    const configured = (process.env.DRAWINGS_VISION_PROVIDER ||
        process.env.AI_DRAWINGS_VISION_PROVIDER ||
        process.env.AI_VISION_PROVIDER ||
        'google')
        .trim()
        .toLowerCase();
    return configured === 'openai' ? 'openai' : 'google';
}
function getVisionApiKey(provider) {
    if (provider === 'openai') {
        return process.env.OPENAI_API_KEY?.trim() || null;
    }
    return (process.env.GOOGLE_GENERATIVE_AI_API_KEY?.trim() ||
        process.env.GEMINI_API_KEY?.trim() ||
        null);
}
function getVisionModel(provider, payload) {
    const payloadModel = getPayloadVisionConfig(payload).model;
    if (payloadModel)
        return payloadModel;
    if (provider === 'openai') {
        return (process.env.DRAWINGS_VISION_MODEL ||
            process.env.AI_DRAWINGS_VISION_MODEL ||
            process.env.OPENAI_DRAWINGS_VISION_MODEL ||
            process.env.OPENAI_VISION_MODEL ||
            'gpt-4.1-mini');
    }
    return (process.env.DRAWINGS_VISION_MODEL ||
        process.env.AI_DRAWINGS_VISION_MODEL ||
        process.env.GOOGLE_DRAWINGS_VISION_MODEL ||
        process.env.GEMINI_VISION_MODEL ||
        process.env.GOOGLE_VISION_MODEL ||
        'gemini-2.5-flash-lite');
}
async function generateVisionResponseText(input) {
    const { provider, apiKey, model, prompt, images, pageNumber } = input;
    if (provider === 'openai') {
        const baseUrl = (process.env.OPENAI_BASE_URL || process.env.OPENAI_COMPAT_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
        const response = await fetch(`${baseUrl}/responses`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${apiKey}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model,
                input: [
                    {
                        role: 'user',
                        content: [
                            { type: 'input_text', text: prompt },
                            ...images.map((image, index) => ({
                                type: 'input_image',
                                image_url: image.dataUrl,
                                detail: index === 0 ? 'low' : 'high',
                            })),
                        ],
                    },
                ],
            }),
        });
        if (!response.ok) {
            const body = await response.text();
            console.warn(`[Vision] OpenAI request failed for page ${pageNumber}: ${response.status} ${body}`);
            return null;
        }
        const payload = await response.json();
        return extractOpenAiResponseText(payload);
    }
    const normalizedModel = model.startsWith('models/') ? model : `models/${model}`;
    const endpoint = process.env.GEMINI_BASE_URL?.replace(/\/$/, '') ||
        'https://generativelanguage.googleapis.com/v1beta';
    const response = await fetch(`${endpoint}/${normalizedModel}:generateContent?key=${encodeURIComponent(apiKey)}`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            contents: [
                {
                    role: 'user',
                    parts: [
                        { text: prompt },
                        ...images.map((image) => {
                            const [, mimeType = 'image/webp', data = ''] = image.dataUrl.match(/^data:(.*?);base64,(.*)$/) || [];
                            return {
                                inline_data: {
                                    mime_type: mimeType,
                                    data,
                                },
                            };
                        }),
                    ],
                },
            ],
            generationConfig: {
                temperature: 0.1,
                responseMimeType: 'application/json',
            },
        }),
    });
    if (!response.ok) {
        const body = await response.text();
        console.warn(`[Vision] Gemini request failed for page ${pageNumber}: ${response.status} ${body}`);
        return null;
    }
    const payload = await response.json();
    return extractGeminiResponseText(payload);
}
async function buildVisionInputs(localPngPath) {
    const page = (0, sharp_1.default)(localPngPath);
    const metadata = await page.metadata();
    const width = metadata.width ?? 0;
    const height = metadata.height ?? 0;
    if (width <= 0 || height <= 0)
        return [];
    const full = await page
        .resize({ width: Math.min(width, 1600), withoutEnlargement: true })
        .webp({ quality: 85 })
        .toBuffer();
    const cornerWidth = Math.max(300, Math.round(width * 0.34));
    const cornerHeight = Math.max(220, Math.round(height * 0.24));
    const crops = await Promise.all([
        (0, sharp_1.default)(localPngPath)
            .extract({ left: Math.max(0, width - cornerWidth), top: 0, width: Math.min(cornerWidth, width), height: Math.min(cornerHeight, height) })
            .resize({ width: 1200, withoutEnlargement: false })
            .webp({ quality: 90 })
            .toBuffer(),
        (0, sharp_1.default)(localPngPath)
            .extract({ left: Math.max(0, width - cornerWidth), top: Math.max(0, height - cornerHeight), width: Math.min(cornerWidth, width), height: Math.min(cornerHeight, height) })
            .resize({ width: 1200, withoutEnlargement: false })
            .webp({ quality: 90 })
            .toBuffer(),
        (0, sharp_1.default)(localPngPath)
            .extract({ left: 0, top: Math.max(0, height - cornerHeight), width: Math.min(cornerWidth, width), height: Math.min(cornerHeight, height) })
            .resize({ width: 1200, withoutEnlargement: false })
            .webp({ quality: 90 })
            .toBuffer(),
    ]);
    return [full, ...crops].map((buffer) => ({
        dataUrl: `data:image/webp;base64,${buffer.toString('base64')}`,
    }));
}
function extractOpenAiResponseText(payload) {
    if (typeof payload?.output_text === 'string' && payload.output_text.trim()) {
        return payload.output_text.trim();
    }
    const output = Array.isArray(payload?.output) ? payload.output : [];
    const texts = [];
    for (const item of output) {
        const content = Array.isArray(item?.content) ? item.content : [];
        for (const entry of content) {
            if (entry?.type === 'output_text' && typeof entry?.text === 'string') {
                texts.push(entry.text);
            }
        }
    }
    return texts.join('\n').trim();
}
function extractGeminiResponseText(payload) {
    const candidates = Array.isArray(payload?.candidates) ? payload.candidates : [];
    const texts = [];
    for (const candidate of candidates) {
        const parts = Array.isArray(candidate?.content?.parts) ? candidate.content.parts : [];
        for (const part of parts) {
            if (typeof part?.text === 'string' && part.text.trim()) {
                texts.push(part.text.trim());
            }
        }
    }
    return texts.join('\n').trim();
}
function parseVisionJson(raw) {
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const candidate = fenced?.[1] ?? raw;
    const jsonMatch = candidate.match(/\{[\s\S]*\}/);
    if (!jsonMatch)
        return null;
    try {
        return JSON.parse(jsonMatch[0]);
    }
    catch {
        return null;
    }
}
function normalizeConfidence(value) {
    if (value === 'high' || value === 'medium' || value === 'low')
        return value;
    return 'low';
}
function mergeDetectedSheetMetadata(detected, vision, setTitle, pageNumber) {
    if (!vision)
        return detected;
    const useVisionSheetNumber = Boolean(vision.sheetNumber) && (detected.method !== 'label' ||
        detected.confidence === 'low' ||
        detected.sheetNumber === `${setTitle} - Page ${pageNumber}`);
    const sheetNumber = useVisionSheetNumber ? vision.sheetNumber : detected.sheetNumber;
    const sheetTitle = vision.sheetTitle || detected.sheetTitle || `${setTitle} - Page ${pageNumber}`;
    const discipline = vision.discipline || detected.discipline || detectDiscipline(sheetNumber);
    const confidence = confidenceRank(vision.confidence) > confidenceRank(detected.confidence)
        ? vision.confidence
        : detected.confidence;
    return {
        sheetNumber,
        sheetTitle,
        discipline,
        method: useVisionSheetNumber ? 'pattern' : detected.method,
        confidence,
        sourceLine: detected.sourceLine,
    };
}
function confidenceRank(value) {
    if (value === 'high')
        return 3;
    if (value === 'medium')
        return 2;
    return 1;
}
function getPdfPageCount(pdfPath) {
    try {
        // Use MuPDF to get page count
        const output = (0, child_process_1.execSync)(`mutool info "${pdfPath}"`, {
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
    }
    catch (error) {
        console.error('Failed to get PDF page count:', error);
        throw new Error(`PDF page count detection failed: ${error instanceof Error ? error.message : String(error)}`);
    }
}
function extractPdfTextByPage(pdfPath, pageCount) {
    if (pageCount <= 0)
        return [];
    try {
        const rawOutput = (0, child_process_1.execFileSync)('pdftotext', ['-layout', '-enc', 'UTF-8', pdfPath, '-'], {
            encoding: 'utf8',
            timeout: 180000,
            maxBuffer: PAGE_TEXT_MAX_BUFFER_BYTES,
        });
        const normalized = rawOutput.replace(/\r/g, '');
        const pages = normalized.split('\f');
        if (pages.length > 0 && !pages[pages.length - 1].trim()) {
            pages.pop();
        }
        return Array.from({ length: pageCount }, (_, index) => pages[index] || '');
    }
    catch (error) {
        console.warn('Failed to extract PDF text with pdftotext:', error);
        return Array.from({ length: pageCount }, () => '');
    }
}
function detectSheetMetadata(input) {
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
function detectSheetNumberFromLabel(lines) {
    for (const line of lines) {
        for (const pattern of SHEET_LABEL_PATTERNS) {
            const match = line.match(pattern);
            if (!match)
                continue;
            const sheetNumber = normalizeSheetNumberCandidate(match[1]);
            if (sheetNumber) {
                return { sheetNumber, sourceLine: line };
            }
        }
    }
    return null;
}
function detectSheetNumberByPattern(lines) {
    let best = null;
    for (const line of lines) {
        const candidates = line.match(GENERIC_SHEET_NUMBER_PATTERN) || [];
        for (const candidate of candidates) {
            const normalized = normalizeSheetNumberCandidate(candidate);
            if (!normalized)
                continue;
            let score = 0;
            if (/[-./]/.test(normalized))
                score += 2;
            if (/\b(SHEET|SHT|DWG|DRAWING)\b/i.test(line))
                score += 4;
            if (line.length <= 40)
                score += 1;
            if (/\b(DETAIL|SCALE|DATE|ISSUED|REVISION|PROJECT)\b/i.test(line))
                score -= 1;
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
function detectSheetTitleFromLabels(lines) {
    for (const line of lines) {
        for (const pattern of SHEET_TITLE_LABEL_PATTERNS) {
            const match = line.match(pattern);
            if (!match)
                continue;
            const title = sanitizeTitle(match[1]);
            if (title)
                return title;
        }
    }
    return null;
}
function detectSheetTitleNearLine(lines, sourceLine) {
    const index = lines.findIndex((line) => line === sourceLine);
    if (index === -1)
        return null;
    const nearbyIndexes = [index + 1, index + 2, index - 1, index - 2];
    for (const i of nearbyIndexes) {
        if (i < 0 || i >= lines.length)
            continue;
        const title = sanitizeTitle(lines[i]);
        if (title)
            return title;
    }
    return null;
}
function sanitizeTitle(raw) {
    const value = normalizeWhitespace(raw).trim();
    if (!value)
        return null;
    if (value.length < 3 || value.length > SHEET_TITLE_MAX_LENGTH)
        return null;
    if (!/[A-Za-z]/.test(value))
        return null;
    if (/^(SHEET|SHT|DWG|DRAWING|REVISION|PROJECT|SCALE)\b/i.test(value))
        return null;
    return truncateValue(value, SHEET_TITLE_MAX_LENGTH);
}
function normalizeSheetNumberCandidate(raw) {
    const value = raw
        .toUpperCase()
        .replace(/[^A-Z0-9./-]/g, '')
        .replace(/^[./-]+|[./-]+$/g, '');
    if (!value)
        return null;
    const valid = /^(?:FP|SP|[ASMEPCLIGTDX])[-./]?\d{1,4}(?:\.\d{1,3})?[A-Z]?$/.test(value);
    return valid ? truncateValue(value, SHEET_NUMBER_MAX_LENGTH) : null;
}
function detectDiscipline(sheetNumber) {
    const normalized = sheetNumber.toUpperCase();
    if (normalized.startsWith('FP'))
        return 'FP';
    if (normalized.startsWith('SP'))
        return 'SP';
    const single = normalized[0];
    return DISCIPLINE_CODES.has(single) ? single : 'X';
}
function normalizeDiscipline(value) {
    const normalized = (value || '').toUpperCase();
    return DISCIPLINE_CODES.has(normalized) ? normalized : 'X';
}
function ensureUniqueSheetNumber(baseSheetNumber, pageNumber, used) {
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
function truncateForSuffix(base, suffix, maxLength) {
    const roomForBase = Math.max(1, maxLength - suffix.length);
    return `${base.slice(0, roomForBase)}${suffix}`;
}
function truncateValue(value, maxLength) {
    if (value.length <= maxLength)
        return value;
    return value.slice(0, maxLength).trim();
}
function normalizeWhitespace(value) {
    return value.replace(/\s+/g, ' ');
}
