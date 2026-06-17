import Link from "next/link"

export default function DrawingsArticle() {
  return (
    <>
      <p>
        Arc&apos;s Drawings tool is built specifically to manage construction sheet sets, architectural drawings, 
        and revisions. It streamlines drawing distribution and markups, ensuring that your field crews and 
        subcontractors are always working off the most current plans.
      </p>

      <h2>Key Features</h2>
      <ul>
        <li><strong>Drawing Sets:</strong> Group drawings into sets based on categories (e.g., Architectural, Structural, MEP) or issues (e.g., 90% CD Set, Addendum 1).</li>
        <li><strong>Automatic Sheet Extraction:</strong> Upload multi-page drawing PDFs, and Arc will automatically split them into individual sheets and propose sheet numbers and titles.</li>
        <li><strong>Revision Stacking:</strong> Match new sheet versions to existing sheets automatically by sheet number, preserving previous versions and annotations.</li>
        <li><strong>Markups & Linking:</strong> Draw shapes, highlight areas, add text notes, and link sheets directly to RFIs, submittals, or other drawings.</li>
      </ul>

      <h2>Uploading Drawings</h2>
      <p>
        To upload drawings, navigate to the <strong>Drawings</strong> tab under your project and click <strong>Upload Drawings</strong>. 
        Select a PDF from your computer and assign it to a <strong>Drawing Set</strong> (either select an existing set or create a new one, 
        such as &quot;Bid Set 2026-06-15&quot;).
      </p>
      <h3>Automatic Sheet Detection</h3>
      <p>
        After uploading, Arc runs a sheet processing engine to analyze the document. It reads the title blocks 
        to extract the sheet number (e.g., <code>A-101</code>) and the sheet title (e.g., <code>First Floor Plan</code>). 
        You will be prompted to review and confirm these details before publishing the drawings to the project.
      </p>

      <h2>Revision Management</h2>
      <p>
        When you upload a new drawing sheet that matches an existing sheet number, Arc automatically groups it 
        under the existing sheet as a new revision (e.g., Rev 1, Rev 2).
      </p>
      <blockquote>
        <strong>Tip:</strong> You can toggle between revisions at any time in the drawing viewer to compare 
        changes or see how the design has evolved over the course of the project.
      </blockquote>

      <h2>Markups and Annotations</h2>
      <p>
        Open any sheet in the drawing viewer to access the markup toolbar. You can:
      </p>
      <ul>
        <li>Draw freehand or place standardized shapes (arrows, rectangles, clouds) to highlight changes.</li>
        <li>Add text callouts directly onto the drawing canvas.</li>
        <li>Create clickable links linking to specific RFIs, submittals, or other drawings. For instance, you can drop an RFI tag directly on a detail to show that a clarification request has been submitted.</li>
      </ul>
    </>
  )
}
