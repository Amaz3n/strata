# Drawings OCR + Vision AI Spec

## Current State (No OCR)

**What we have:**
- Basic regex pattern matching on assumed sheet numbers (A-101 → Architectural)
- Hardcoded names: "Sheet-001", "Page 1"
- `extracted_metadata` column exists but unused

**What we need:**
- Extract sheet number from title block
- Extract sheet title/description
- Auto-classify discipline with confidence
- Extract key metadata (scale, revision, date, project name)
- Optional: detect and warn about common issues (missing details, outdated revisions)

---

## Architecture Options

### Option A: Claude Vision API (Recommended)

**Why Claude:**
- Excellent at understanding structured documents
- Can follow complex extraction instructions
- Handles poor quality scans well
- Cheaper than GPT-4 Vision for batch processing
- Returns structured JSON reliably

**Cost:** ~$0.03-0.05 per sheet (using Haiku for most, Sonnet for complex cases)

### Option B: Google Document AI (Construction Drawings Parser)

**Pros:**
- Pre-trained on construction drawings
- Very accurate for standard title blocks
- Built-in field extraction

**Cons:**
- More expensive (~$0.10-0.15 per page)
- Requires separate Google Cloud setup
- Less flexible for custom fields

### Option C: Open Source (Tesseract + Layout Analysis)

**Pros:**
- Free compute
- No API dependencies

**Cons:**
- Poor quality on angled/scanned drawings
- Requires significant tuning
- No understanding of drawing context
- Would need custom ML model for classification

**Recommendation: Go with Claude Vision API (Option A)**

---

## Implementation Plan

### Step 1: Add Vision Processing to Edge Function

```typescript
// supabase/functions/process-drawing-set/index.ts

import Anthropic from "https://esm.sh/@anthropic-ai/sdk@0.20.0"

const anthropic = new Anthropic({
  apiKey: Deno.env.get("ANTHROPIC_API_KEY")!
})

interface ExtractedMetadata {
  sheet_number: string | null
  sheet_title: string | null
  discipline: string | null
  discipline_confidence: number
  scale: string | null
  revision: string | null
  date: string | null
  project_name: string | null
  raw_text: string  // Full OCR text for search
  title_block_detected: boolean
  extraction_confidence: "high" | "medium" | "low"
  warnings: string[]
}

async function extractSheetMetadata(
  imageBuffer: Uint8Array,
  pageNumber: number
): Promise<ExtractedMetadata> {
  // Convert image to base64
  const base64Image = btoa(String.fromCharCode(...imageBuffer))

  const message = await anthropic.messages.create({
    model: "claude-3-5-haiku-20241022",  // Cheap and fast for OCR
    max_tokens: 2000,
    messages: [{
      role: "user",
      content: [
        {
          type: "image",
          source: {
            type: "base64",
            media_type: "image/png",
            data: base64Image
          }
        },
        {
          type: "text",
          text: `You are analyzing a construction drawing. Extract the following metadata from the title block:

REQUIRED FIELDS (look carefully in corners/edges for title block):
1. Sheet Number (e.g., "A-101", "S-2.1", "M-301") - typically top-right or bottom-right
2. Sheet Title/Description (e.g., "First Floor Plan", "Foundation Details")
3. Discipline (one of: Architectural, Structural, Mechanical, Electrical, Plumbing, Civil, Landscape, Interior, Fire Protection, General, Title, Specifications, Details, Other)
4. Scale (e.g., "1/4\" = 1'-0\"", "1:100")
5. Revision (e.g., "Rev 3", "A", "For Construction")
6. Date (e.g., "12/15/2023")
7. Project Name

ADDITIONAL TASKS:
8. Extract ALL visible text for full-text search (title blocks, labels, notes)
9. Identify any warnings:
   - "NO_TITLE_BLOCK" if no title block found
   - "UNCLEAR_SHEET_NUMBER" if sheet number is ambiguous
   - "OUTDATED_REVISION" if revision shows "For Review Only", "Preliminary", "Not for Construction"
   - "MISSING_SCALE" if no scale indicator found
   - "SUPERSEDED" if marked as superseded/void

Return JSON in this exact format:
{
  "sheet_number": "string or null",
  "sheet_title": "string or null",
  "discipline": "Architectural|Structural|...|Other|null",
  "discipline_confidence": 0.0-1.0,
  "scale": "string or null",
  "revision": "string or null",
  "date": "string or null",
  "project_name": "string or null",
  "raw_text": "all extracted text...",
  "title_block_detected": true/false,
  "extraction_confidence": "high|medium|low",
  "warnings": ["array of warning strings"]
}

If you cannot find a field with confidence, set it to null. Be conservative - only return "high" confidence if the title block is clear and standard.`
        }
      ]
    })
  })

  // Parse Claude's response
  const textContent = message.content.find(c => c.type === "text")
  if (!textContent || textContent.type !== "text") {
    throw new Error("No text response from Claude")
  }

  // Extract JSON from markdown code blocks if present
  let jsonText = textContent.text.trim()
  const jsonMatch = jsonText.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/)
  if (jsonMatch) {
    jsonText = jsonMatch[1]
  }

  const metadata = JSON.parse(jsonText) as ExtractedMetadata

  // Fallback discipline classification if Claude didn't find it
  if (!metadata.discipline && metadata.sheet_number) {
    metadata.discipline = classifyDiscipline(metadata.sheet_number)
    metadata.discipline_confidence = 0.5
  }

  return metadata
}
```

### Step 2: Integrate into Processing Pipeline

```typescript
// In the page processing loop (around line 250):

for (let i = 0; i < numPages; i++) {
  const pageNumber = i + 1

  // ... existing PDF extraction code ...

  // NEW: Generate temporary image for vision API
  let extractedMetadata: ExtractedMetadata | null = null
  try {
    // Render page to PNG at medium resolution (balance speed/accuracy)
    const viewport = page.getViewport({ scale: 2 })
    const canvas = new OffscreenCanvas(viewport.width, viewport.height)
    const context = canvas.getContext("2d")!

    await page.render({
      canvasContext: context,
      viewport: viewport
    }).promise

    const blob = await canvas.convertToBlob({ type: "image/png" })
    const arrayBuffer = await blob.arrayBuffer()
    const imageBuffer = new Uint8Array(arrayBuffer)

    // Extract metadata with vision AI
    extractedMetadata = await extractSheetMetadata(imageBuffer, pageNumber)

    console.log(`[Vision] Page ${pageNumber} metadata:`, {
      sheet_number: extractedMetadata.sheet_number,
      title: extractedMetadata.sheet_title,
      discipline: extractedMetadata.discipline,
      confidence: extractedMetadata.extraction_confidence
    })
  } catch (error) {
    console.error(`[Vision] Failed to extract metadata for page ${pageNumber}:`, error)
    // Fall back to defaults
  }

  // Use extracted data or fall back to defaults
  const sheetNumber = extractedMetadata?.sheet_number || `Sheet-${String(pageNumber).padStart(3, "0")}`
  const sheetTitle = extractedMetadata?.sheet_title || `Page ${pageNumber}`
  const discipline = extractedMetadata?.discipline || classifyDiscipline(sheetNumber)

  // Create sheet record
  const { data: sheet, error: sheetError } = await supabase
    .from("drawing_sheets")
    .insert({
      org_id: orgId,
      project_id: projectId,
      drawing_set_id: drawingSetId,
      sheet_number: sheetNumber,
      sheet_title: sheetTitle,
      discipline: discipline,
      current_revision_id: revision.id,
      sort_order: pageNumber,
      share_with_clients: false,
      share_with_subs: false,
    })
    .select("id")
    .single()

  // Store full extracted metadata in sheet_version
  const { data: sheetVersion, error: versionError } = await supabase
    .from("drawing_sheet_versions")
    .insert({
      org_id: orgId,
      drawing_sheet_id: sheet.id,
      drawing_revision_id: revision.id,
      file_id: fileRecord.id,
      page_index: i,
      extracted_metadata: extractedMetadata || {
        original_page: pageNumber,
        auto_classified: true,
        pdf_width: pdfWidth,
        pdf_height: pdfHeight,
        extraction_failed: true
      },
    })
    .select("id")
    .single()

  // Store warnings if any
  if (extractedMetadata?.warnings && extractedMetadata.warnings.length > 0) {
    console.warn(`[Vision] Page ${pageNumber} warnings:`, extractedMetadata.warnings)
    // Could emit events or notifications here
  }
}
```

### Step 3: Add Full-Text Search

```sql
-- Migration: Add full-text search to sheets
ALTER TABLE drawing_sheet_versions
  ADD COLUMN search_vector tsvector
  GENERATED ALWAYS AS (
    to_tsvector('english',
      COALESCE(extracted_metadata->>'raw_text', '') || ' ' ||
      COALESCE(extracted_metadata->>'sheet_title', '') || ' ' ||
      COALESCE(extracted_metadata->>'project_name', '')
    )
  ) STORED;

CREATE INDEX idx_drawing_sheet_versions_search
  ON drawing_sheet_versions
  USING gin(search_vector);

-- Now you can search inside drawings:
SELECT
  s.sheet_number,
  s.sheet_title,
  sv.extracted_metadata->>'raw_text' as context
FROM drawing_sheets s
JOIN drawing_sheet_versions sv ON sv.drawing_sheet_id = s.id
WHERE sv.search_vector @@ to_tsquery('english', 'kitchen & island')
ORDER BY ts_rank(sv.search_vector, to_tsquery('english', 'kitchen & island')) DESC;
```

### Step 4: UI for Reviewing/Editing Extractions

```typescript
// components/drawings/sheet-metadata-editor.tsx
"use client"

import { useState } from "react"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Badge } from "@/components/ui/badge"
import { AlertCircle, CheckCircle2 } from "lucide-react"

interface SheetMetadataEditorProps {
  sheet: DrawingSheet
  extractedMetadata: ExtractedMetadata
  onSave: (updates: Partial<DrawingSheet>) => Promise<void>
}

export function SheetMetadataEditor({
  sheet,
  extractedMetadata,
  onSave
}: SheetMetadataEditorProps) {
  const [editing, setEditing] = useState(false)
  const [sheetNumber, setSheetNumber] = useState(sheet.sheet_number)
  const [sheetTitle, setSheetTitle] = useState(sheet.sheet_title)

  const confidenceBadge = () => {
    const confidence = extractedMetadata.extraction_confidence
    if (confidence === "high") {
      return <Badge variant="default"><CheckCircle2 className="h-3 w-3 mr-1" />High Confidence</Badge>
    } else if (confidence === "medium") {
      return <Badge variant="secondary">Medium Confidence</Badge>
    } else {
      return <Badge variant="destructive"><AlertCircle className="h-3 w-3 mr-1" />Low Confidence</Badge>
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-semibold">Sheet Metadata</h3>
        {confidenceBadge()}
      </div>

      {/* Show warnings */}
      {extractedMetadata.warnings.length > 0 && (
        <div className="bg-yellow-50 border border-yellow-200 rounded-md p-3 space-y-1">
          <p className="text-sm font-medium text-yellow-900">Extraction Warnings:</p>
          {extractedMetadata.warnings.map((warning, i) => (
            <p key={i} className="text-sm text-yellow-800 flex items-center gap-2">
              <AlertCircle className="h-3 w-3" />
              {warning}
            </p>
          ))}
        </div>
      )}

      {/* Editable fields */}
      <div className="space-y-3">
        <div>
          <Label>Sheet Number</Label>
          <Input
            value={sheetNumber}
            onChange={(e) => setSheetNumber(e.target.value)}
            disabled={!editing}
          />
        </div>

        <div>
          <Label>Sheet Title</Label>
          <Input
            value={sheetTitle}
            onChange={(e) => setSheetTitle(e.target.value)}
            disabled={!editing}
          />
        </div>

        {/* ... other fields */}
      </div>

      {editing ? (
        <div className="flex gap-2">
          <Button onClick={() => {
            onSave({ sheet_number: sheetNumber, sheet_title: sheetTitle })
            setEditing(false)
          }}>
            Save
          </Button>
          <Button variant="outline" onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button variant="outline" onClick={() => setEditing(true)}>
          Edit Metadata
        </Button>
      )}
    </div>
  )
}
```

---

## Cost Analysis

### Per-Sheet OCR Cost

**Claude 3.5 Haiku:**
- Input: ~1,500 tokens (1 image) = $0.001
- Output: ~500 tokens (JSON) = $0.0008
- **Total: ~$0.002 per sheet**

**For 100-sheet project:**
- OCR cost: $0.20
- Storage (tiles): ~$0.10/month
- **Total incremental cost: negligible**

### Alternative: Batch Processing

For large projects, batch process overnight:
- Upload → generate tiles immediately (for fast viewing)
- Queue OCR job → process in background with Claude
- Update metadata when complete
- User sees "Extracting metadata..." badge

---

## Rollout Plan

### Phase 1: Add to New Uploads (Week 1)
- Enable vision extraction for new plan sets
- Store results in `extracted_metadata`
- Show confidence badges in UI

### Phase 2: Backfill Existing (Week 2)
- Create migration script to process existing sheets
- Prioritize sheets with missing/auto-generated names
- Skip sheets where user has manually edited metadata

### Phase 3: Advanced Features (Week 3+)
- Full-text search inside drawings
- Automatic hotspot detection (detail callouts, sections)
- Change detection between revisions
- "Smart suggestions" for naming/categorization

---

## Success Metrics

| Metric | Current | Target |
|--------|---------|--------|
| Sheets with correct numbers | ~40% (regex-based) | >95% |
| Sheets with meaningful titles | 0% ("Page 1") | >90% |
| Discipline accuracy | ~60% (pattern matching) | >95% |
| User edits per sheet | N/A | <5% (most auto-extracted correctly) |
| Search inside drawings | ❌ Not possible | ✅ Full-text search |

---

## API Keys Needed

```bash
# .env
ANTHROPIC_API_KEY=sk-ant-...  # For Claude Vision API

# Or for Google Document AI (alternative):
GOOGLE_CLOUD_PROJECT_ID=...
GOOGLE_APPLICATION_CREDENTIALS=...
```

---

## Example Extracted Metadata

```json
{
  "sheet_number": "A-101",
  "sheet_title": "First Floor Plan - East Wing",
  "discipline": "Architectural",
  "discipline_confidence": 0.95,
  "scale": "1/4\" = 1'-0\"",
  "revision": "Rev 3 - For Construction",
  "date": "2024-12-15",
  "project_name": "Valley Medical Center Expansion",
  "raw_text": "FIRST FLOOR PLAN EAST WING A-101 SCALE 1/4\"=1'-0\" ...",
  "title_block_detected": true,
  "extraction_confidence": "high",
  "warnings": []
}
```

---

## Competitive Advantage

**Why this matters:**

1. **Procore charges extra for OCR** - you'd include it standard
2. **Builders hate manual sheet renaming** - "Sheet-001" → "A-101 First Floor Plan" automatically
3. **Search is a killer feature** - "Find the sheet with the kitchen island detail" actually works
4. **QA warnings are valuable** - Flag sheets marked "Not for Construction" before someone builds from them

This + offline mode + tiled zoom = distinctly better than Procore for $200/month tools.
