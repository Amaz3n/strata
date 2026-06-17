import Link from "next/link"

export default function CloseoutOverviewArticle() {
  return (
    <>
      <p>
        The transition of a construction project from active operations to client occupancy is a critical phase for risk management 
        and client satisfaction. Arc provides dedicated Closeout &amp; Warranty workflows to help project teams compile final compliance 
        records, generate digital handoff packages, and manage post-occupancy client warranty service tickets.
      </p>

      <h2>The Closeout &amp; Warranty Lifecycle</h2>
      <p>
        Arc splits the post-construction process into two distinct, interconnected modules:
      </p>

      <h3>1. Closeout Records Collection</h3>
      <p>
        Organize, request, and verify compliance files (As-Built drawings, Operations &amp; Maintenance manuals, Warranty Certificates, and Final Lien Waivers) 
        from subcontractors. Ensure all deliverables are compiled before releasing subcontractor retention and archiving the project.
        {" "}
        <Link href="/help/closeout-and-warranty/closing-projects/closeout-records">
          Read the Closeout Records Guide
        </Link>
        .
      </p>

      <h3>2. Warranty Request Dispatching</h3>
      <p>
        Manage incoming defect tickets from client portal reports, assign tickets to the installing trade partner as a work order, 
        establish urgency priorities, track repair schedules, and capture official owner approvals.
        {" "}
        <Link href="/help/closeout-and-warranty/closing-projects/warranty-requests">
          Read the Warranty Requests Guide
        </Link>
        .
      </p>
    </>
  )
}
