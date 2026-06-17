import Link from "next/link"

export default function ProjectAssignmentsArticle() {
  return (
    <>
      <p>
        Project Assignments connect your master Directory companies and contacts to specific projects. 
        Assigning vendors to a project defines their role, records their scope of work on that job, 
        and makes them eligible for project-level bidding and financials.
      </p>

      <h2>Key Features</h2>
      <ul>
        <li><strong>Project-Specific Roles:</strong> Assign vendors a project-level role (e.g., Framing Subcontractor, Drywall Subcontractor, Client, Architect).</li>
        <li><strong>Scope of Work:</strong> Record the specific scope of work the vendor is contracted to perform on the project.</li>
        <li><strong>Vendor Logs:</strong> Track all vendors actively assigned to a job from the project details dashboard.</li>
      </ul>

      <h2>Assigning a Vendor to a Project</h2>
      <p>
        To assign a company or contact, navigate to the <strong>Directory</strong> tab under your project (not the workspace Directory) 
        and click <strong>Add Project Vendor</strong>.
      </p>
      <ol>
        <li><strong>Company or Contact:</strong> Search for and select the company or contact from your master directory. If they do not exist yet, you can add them to the directory from this screen.</li>
        <li><strong>Role:</strong> Assign their role on this specific project (e.g., <code>Subcontractor</code> or <code>Supplier</code>).</li>
        <li><strong>Scope:</strong> Type their contracted scope of work (e.g., <code>Framing labor and materials per plans dated 2026-06-15</code>).</li>
        <li><strong>Notes:</strong> Add any project-specific notes (e.g., <code>First project with this superintendent</code>).</li>
      </ol>

      <h2>How Project Assignments are Used</h2>
      <p>
        Assigning a vendor to a project is required for several downstream workflows:
      </p>
      <ul>
        <li><strong>Financials:</strong> You can only issue commitments (Subcontracts or Purchase Orders) or log vendor bills (Payables) for companies that are assigned as vendors on the project.</li>
        <li><strong>Field Operations:</strong> Project vendors are available when logging crew manpower in <strong>Daily Logs</strong> and when assigning responsibility for <strong>Punch Items</strong>.</li>
        <li><strong>Bids:</strong> Project vendors are pre-populated when selecting bidders to invite to active bid packages.</li>
      </ul>
    </>
  )
}
