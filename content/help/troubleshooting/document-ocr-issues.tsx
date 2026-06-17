import Link from "next/link"

export default function DocumentOcrIssuesArticle() {
  return (
    <>
      <p>
        Arc features an automated drawing processing pipeline that uses Optical Character Recognition (OCR) to read sheet numbers, 
        sheet titles, and automatically link detail callouts. If your uploads fail or drawing sheets display incorrect labels, follow this guide to resolve the issues.
      </p>

      <h2>Issue 1: Drawing Sheet Uploads Fail or Timeout</h2>
      <p>
        <strong>Symptom:</strong> Upload progress bar stops mid-way, displays a network timeout error, or fails with a <code>Bad File Format</code> message.
      </p>
      <h3>Root Cause</h3>
      <p>
        Uploads fail when files exceed system size constraints, use unsupported file extensions, or contain encrypted elements.
      </p>
      <h3>Solutions</h3>
      <ul>
        <li>
          <strong>Check File Size:</strong> The maximum file size limit for a single multi-page PDF drawing set is <strong>250MB</strong>. 
          If your drawing set is larger, split the PDF into smaller batches (e.g., separating Architectural, Structural, and MEP sheets) before uploading.
        </li>
        <li>
          <strong>Verify File Types:</strong> Drawings must be in standard PDF format. For general project files under the <strong>Documents</strong> tab, 
          Arc supports typical formats including PDF, DOCX, XLSX, JPEG, PNG, and ZIP files. Executable files (e.g., EXE) are blocked.
        </li>
        <li>
          <strong>Remove Password Protections:</strong> Arc cannot process password-protected or digitally encrypted PDFs. Open the PDF in Acrobat, 
          remove all security restrictions, and re-save the file before uploading.
        </li>
      </ul>

      <h2>Issue 2: Drawing Sheets Stuck in &quot;Processing&quot; Status</h2>
      <p>
        <strong>Symptom:</strong> After uploading, the drawing list displays <code>Processing...</code> next to sheets for more than 10 minutes.
      </p>
      <h3>Root Cause</h3>
      <p>
        When a drawing set is uploaded, Arc initiates a background processing queue. This queue splits multi-page PDFs, vectorizes lines, 
        scans title blocks, and indexes text. Highly complex sheets with hundreds of CAD layers or raster scanned image files can slow down this pipeline.
      </p>
      <h3>Solutions</h3>
      <ol>
        <li>
          <strong>Do Not Re-upload:</strong> Re-uploading the same file adds duplicate tasks to the background processing queue, slowing down your project.
        </li>
        <li>
          <strong>Flatten CAD Vector Layers:</strong> If your CAD exporter includes all vector details and hidden layouts, the file can be extremely heavy. 
          In your drawing software, export using a &quot;Flattened PDF&quot; profile. This merges layers, reducing file size and accelerating OCR extraction.
        </li>
        <li>
          <strong>Raster vs. Vector:</strong> True vector PDFs (where you can highlight text directly in the browser) process in seconds. Scanned paper drawings (rasters) 
          require deep pixel analysis and take significantly longer. Give raster drawings up to 15 minutes to complete processing.
        </li>
      </ol>

      <h2>Issue 3: Incorrect Sheet Numbers or Sheet Titles</h2>
      <p>
        <strong>Symptom:</strong> Drawing sheets are extracted, but the Sheet Numbers are wrong (e.g., reading <code>SCALE: 1/4&quot;</code> instead of <code>A-101</code>) 
        or titles are blank.
      </p>
      <h3>Root Cause</h3>
      <p>
        The OCR engine looks in standard locations (typically the bottom-right corner) for title blocks. If your architect uses custom border layouts or vertical titles along the margin, the automated scanner may read the wrong text block.
      </p>
      <h3>Solutions</h3>
      <ol>
        <li>
          <strong>Calibrate OCR Search Regions:</strong> When uploading a new drawing set, Arc displays a calibration step. 
          Use the mouse to click and drag selection boxes over the specific title block areas where the <strong>Sheet Number</strong> and <strong>Sheet Title</strong> are located. 
          Arc uses these coordinates to scan every sheet in the set.
        </li>
        <li>
          <strong>Manual Renaming:</strong> If sheets have already processed incorrectly, you do not need to re-upload. In the drawing list:
          <ul>
            <li>Click on the incorrect Sheet Number or Title to open the editing input.</li>
            <li>Type the correct name and press Enter. This updates the index and automatically updates any references on detail callouts.</li>
          </ul>
        </li>
      </ol>
    </>
  )
}
