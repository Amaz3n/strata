export default function DrawingProcessingIssuesArticle() {
  return (
    <>
      <p>
        When you upload a drawing set, Arc splits the PDF into sheets, renders each page, builds the
        zoomable tile pyramid, and reads the title block to work out the sheet number, sheet title and
        discipline. Most of that is deterministic; the title block read falls back to a vision model
        when the PDF carries no usable text. This guide covers what to do when a step goes wrong.
      </p>

      <h2>How Arc reads a sheet</h2>
      <p>
        Arc reads sheets in two passes, and knowing which one ran explains most bad results.
      </p>
      <ol>
        <li>
          <strong>Embedded text.</strong> A CAD-exported PDF carries real text. Arc pulls it straight out
          of the file — no image analysis involved — and matches title-block labels such as{" "}
          <code>SHEET NO:</code> or <code>DRAWING NUMBER:</code>. This is fast and close to exact.
        </li>
        <li>
          <strong>Vision fallback.</strong> When the page has no text (a scan), or the text pass only
          found a low-confidence pattern match, Arc sends the rendered page and three title-block corner
          crops to a multimodal model, which reads the number, title, discipline and printed scale.
        </li>
      </ol>
      <p>
        Arc does not run a separate OCR engine, and there is no region-calibration step during upload.
        If the sheet number is wrong, the fix is to correct it in the sheet list — see Issue&nbsp;3.
      </p>

      <h2>Issue 1: Uploads fail or time out</h2>
      <p>
        <strong>Symptom:</strong> the upload stalls part-way, or the set lands with a failure message
        instead of processing.
      </p>
      <h3>Solutions</h3>
      <ul>
        <li>
          <strong>Remove password protection.</strong> Arc cannot open encrypted or password-protected
          PDFs. Remove the security restrictions and re-save before uploading.
        </li>
        <li>
          <strong>Upload real PDFs.</strong> Drawing sets must be PDF. Other formats belong in{" "}
          <strong>Documents</strong>, which accepts the usual office and image types.
        </li>
        <li>
          <strong>Split very large sets.</strong> There is no fixed page cap, but a set of several
          hundred sheets takes noticeably longer to drain and is easier to review in discipline-sized
          batches (Architectural, Structural, MEP).
        </li>
      </ul>

      <h2>Issue 2: Sheets stay in &quot;Processing&quot;</h2>
      <p>
        <strong>Symptom:</strong> the set shows <code>Processing</code> for longer than you expect.
      </p>
      <h3>Root cause</h3>
      <p>
        Processing is a background queue: the set is split into chunks, each page is rendered and tiled,
        and metadata enrichment runs last. A set only finishes when every page has drained. Scanned
        (raster) sheets are the slow case — they carry no text, so every one of them takes the vision
        fallback path.
      </p>
      <h3>Solutions</h3>
      <ol>
        <li>
          <strong>Do not re-upload.</strong> Re-uploading queues the same work twice and slows the
          project down. If a set genuinely failed, use <strong>Retry</strong> on the set or the pending
          revision — already-processed pages are skipped.
        </li>
        <li>
          <strong>Export flattened.</strong> A CAD export carrying every hidden layer and layout can be
          enormous. Exporting a flattened PDF cuts the file size and speeds up rendering.
        </li>
        <li>
          <strong>Expect longer on scans.</strong> Vector PDFs — the ones where you can select text in a
          browser — finish quickly. Scanned paper drawings are rendered and read as images, so give a
          large scanned set more time before treating it as stuck.
        </li>
      </ol>

      <h2>Issue 3: Wrong sheet numbers or blank titles</h2>
      <p>
        <strong>Symptom:</strong> sheets processed, but a number reads as something from the drawing
        body (<code>SCALE: 1/4&quot;</code>) instead of <code>A-101</code>, or a title is empty.
      </p>
      <h3>Root cause</h3>
      <p>
        Arc looks for labelled title-block fields first and falls back to recognising a sheet-number
        pattern anywhere on the page. An unusual border layout, a rotated title strip, or a scan of poor
        quality can push it onto the pattern path, which is where the wrong text gets picked up.
      </p>
      <h3>Solutions</h3>
      <ol>
        <li>
          <strong>Rename in place.</strong> You do not need to re-upload. In the sheet list, click the
          sheet number or title, type the correct value, and press Enter. The index updates, and detail
          callouts that reference the sheet re-resolve against the new number.
        </li>
        <li>
          <strong>Check the discipline.</strong> Discipline is derived from the sheet number, so
          correcting <code>E1.1</code> also moves the sheet into the Electrical group.
        </li>
        <li>
          <strong>Set the scale if measurements matter.</strong> Arc only records a printed scale it can
          read verbatim from the title block, and never guesses one. If a sheet says <em>NTS</em>,{" "}
          <em>AS NOTED</em>, or the scale was unreadable, calibrate the sheet in the viewer before taking
          any measurements off it.
        </li>
      </ol>

      <h2>Issue 4: An invoice or receipt scanned badly</h2>
      <p>
        <strong>Symptom:</strong> you scanned a bill into Payables or Expenses and a field came back
        empty, or the total looks wrong.
      </p>
      <h3>Solutions</h3>
      <ul>
        <li>
          <strong>Read the notes on the scan.</strong> Arc checks the arithmetic on every scanned bill:
          line amounts against the subtotal, subtotal plus tax against the total. When those do not
          reconcile it says so rather than quietly accepting the read.
        </li>
        <li>
          <strong>Statements and lien waivers are refused on purpose.</strong> A statement lists invoices
          that were billed separately, so turning one into a payable would double-count. Enter the
          individual invoices instead.
        </li>
        <li>
          <strong>Correct it once.</strong> Fixing a field on a vendor&apos;s bill teaches Arc how that
          vendor&apos;s documents are laid out, and later scans of the same vendor start from the
          correction.
        </li>
      </ul>
    </>
  )
}
