import Link from "next/link"

export default function CloseoutRecordsArticle() {
  return (
    <>
      <p>
        The Closeout module in Arc is designed to streamline the final phases of a construction project. 
        It coordinates the collection, verification, and packaging of essential handoff documents required by the owner 
        before a project can be officially declared complete and the final retention payments released.
      </p>

      <h2>The Standard Closeout Checklist</h2>
      <p>
        When you initialize the closeout workflow under the <strong>Closeout &amp; Warranty</strong> tab, 
        Arc generates a standardized closeout package consisting of six mandatory checklist items. 
        Each represents a critical record that must be compiled and approved:
      </p>
      <ul>
        <li>
          <strong>As-Built Drawings:</strong> A complete set of project drawings reflecting all field changes, 
          material substitutions, and dimension adjustments made during construction. Subcontractors are required 
          to upload their marked-up sheets, which are compiled by the General Contractor.
        </li>
        <li>
          <strong>O&amp;M (Operations &amp; Maintenance) Manuals:</strong> Equipment data sheets, manufacturer operations guides, 
          parts lists, and maintenance instructions for systems installed (e.g., HVAC, electrical switchgear, elevators).
        </li>
        <li>
          <strong>Warranty Certificates:</strong> Written warranties from material manufacturers and subcontractors 
          guaranteeing their work and equipment for a specified duration (typically 1 to 5 years).
        </li>
        <li>
          <strong>Final Lien Waivers:</strong> Fully executed unconditional final lien waivers from all trade partners. 
          This is a vital risk management step, ensuring the project owner is protected against future mechanics liens before final billing is settled.
        </li>
        <li>
          <strong>Final Inspection Sign-offs:</strong> Copies of municipal building inspection certificates and the 
          official Certificate of Occupancy (CO) issued by the local jurisdiction.
        </li>
        <li>
          <strong>Closeout Punch List:</strong> Documentation showing that all outstanding punch list items 
          have been resolved, signed off by the superintendent, and approved by the owner or design architect.
        </li>
      </ul>

      <h2>Assigning and Collecting Records</h2>
      <p>
        Managing a closeout package is a collaborative process between your office, field team, and subcontractors:
      </p>
      <ol>
        <li>
          <strong>Assign Responsibilities:</strong> Assign each closeout checklist item to the respective subcontractor or team lead. 
          For example, assign the electrical O&amp;M manual directly to your electrical subcontractor company.
        </li>
        <li>
          <strong>Subcontractor Submissions:</strong> Assigned subcontractors receive a notification and can upload 
          their closeout documentation directly via the Subcontractor Portal. They change the status of their assigned item to <strong>Submitted</strong>.
        </li>
        <li>
          <strong>Review &amp; Verification:</strong> The project manager reviews the uploaded files. If they meet specifications, 
          the PM updates the status to <strong>Complete</strong>. If the files are incorrect, they decline the submission, reverting 
          the status to <strong>Missing</strong> and adding comments detailing what needs correction.
        </li>
      </ol>

      <h2>Financial Tie-In: Releasing Retention</h2>
      <p>
        In construction financials, final payment and the release of retention (usually 5% to 10% withheld from progress bills) 
        are contractually tied to closeout. Arc enforces this safeguard:
      </p>
      <blockquote>
        <strong>Important:</strong> If enabled, Arc warns or blocks releasing the final subcontractor billing draw 
        or closing out the subcontract commitment if the subcontractor has outstanding closeout checklist items marked as <strong>Missing</strong> or <strong>Submitted</strong>. All items must be marked <strong>Complete</strong>.
      </blockquote>

      <h2>Generating the Handoff Package</h2>
      <p>
        Once the checklist reaches 100% completion, click <strong>Generate Handoff Package</strong>. 
        Arc packages all uploaded closeout documents, approved submittals, specifications, and as-built drawings into a structured, branded ZIP file. 
        You can generate a secure download link from this screen to share directly with the owner, enabling an open-book, digital handoff.
      </p>

      <h2>Archiving the Project</h2>
      <p>
        After the handoff package is accepted, navigate to <strong>Settings → Project Details</strong> and change the project status to <strong>Completed</strong>:
      </p>
      <ul>
        <li><strong>Read-Only Access:</strong> The project data (budgets, commitments, files) is locked to prevent accidental modifications or new uploads.</li>
        <li><strong>Active Filter Exclusion:</strong> Completed projects are removed from the active project dropdown list to clean up team dashboards, but remain fully searchable in the global workspace archives.</li>
        <li><strong>Warranty Tracking:</strong> While operations are locked, the warranty ticketing system remains fully active.</li>
      </ul>
    </>
  )
}
