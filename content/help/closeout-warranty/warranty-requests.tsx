import Link from "next/link"

export default function WarrantyRequestsArticle() {
  return (
    <>
      <p>
        The Warranty module in Arc coordinates post-occupancy maintenance requests and construction defect reports. 
        It connects clients, builders, and subcontractors in a single workflow, ensuring that warranty issues are logged, 
        assigned to the appropriate trade partner, repaired, and approved by the client within contractually mandated warranty timelines.
      </p>

      <h2>The Warranty Timeline</h2>
      <p>
        A project&apos;s warranty period typically begins on the date of <strong>Substantial Completion</strong> or 
        when the Certificate of Occupancy is issued. 
      </p>
      <ul>
        <li><strong>Standard Builder Warranty:</strong> Most contracts stipulate a 1-year general warranty covering construction defects and craftsmanship.</li>
        <li><strong>Extended Manufacturer Warranties:</strong> Specialized systems (e.g., roofing membranes, HVAC compressors, appliances) often carry extended manufacturer warranties ranging from 5 to 20 years.</li>
        <li><strong>Tracking in Arc:</strong> The project details page stores the warranty start date and duration. Arc displays a countdown banner in the project dashboard indicating how many days remain in the active warranty period.</li>
      </ul>

      <h2>Receiving and Logging Warranty Tickets</h2>
      <p>
        Warranty tickets can enter the system through two main channels:
      </p>

      <h3>1. Client Portal Submissions</h3>
      <p>
        When a project status is set to Completed or Under Warranty, the client can access their secure Client Portal 
        and open the <strong>Warranty</strong> tab:
      </p>
      <ul>
        <li><strong>Item Description:</strong> The client enters a title and detailed description of the issue (e.g., <code>HVAC unit in second-floor bedroom is short-cycling and blowing warm air</code>).</li>
        <li><strong>Location Mapping:</strong> The client tags the specific room or area of the building.</li>
        <li><strong>Photos &amp; Video Attachments:</strong> The client uploads files or snaps photos on their phone showing the defect.</li>
      </ul>

      <h3>2. Manual Logging by Builder Team</h3>
      <p>
        If a client contacts a project manager directly via phone or email, team members can manually log the ticket:
      </p>
      <ol>
        <li>Navigate to the project&apos;s <strong>Warranty Requests</strong> tab.</li>
        <li>Click <strong>New Warranty Request</strong>.</li>
        <li>Select the reporting client contact, enter the details, assign a priority, and attach any emails or photos provided.</li>
      </ol>

      <h2>Prioritization and SLA Response</h2>
      <p>
        To manage expectations and coordinate field responses, every warranty ticket is assigned a priority level:
      </p>
      <ul>
        <li>
          <strong>Emergency:</strong> Active water leaks, complete electrical blackouts, heating failures in freezing temperatures, 
          or security failures (broken exterior doors/locks). These require immediate dispatcher contact and a response within 2-4 hours.
        </li>
        <li>
          <strong>High:</strong> Inoperable major appliances, failed hot water heaters, or localized electrical faults. Target resolution is 24-48 hours.
        </li>
        <li>
          <strong>Normal/Low:</strong> Drywall cracking due to building settling, loose cabinet doors, trim paint touch-ups. These are typically scheduled in batches to minimize homeowner disruption.
        </li>
      </ul>

      <h2>Subcontractor Assignment &amp; Work Orders</h2>
      <p>
        Because trade partners perform the physical installations, they are responsible for resolving warranty issues under their subcontracts:
      </p>
      <ol>
        <li>
          <strong>Assign the Subcontractor:</strong> In the ticket detail pane, select the subcontractor company (e.g., <code>Naples HVAC Solutions</code>).
        </li>
        <li>
          <strong>Work Order Notification:</strong> The subcontractor receives an email notification with a link to the ticket in their Subcontractor Portal. They do <strong>not</strong> need a paid Arc seat.
        </li>
        <li>
          <strong>Portal Interaction:</strong> Through the portal, the subcontractor reviews photos of the issue, comments to coordinate homeowner access, logs their scheduled repair date, and uploads photos of the completed fix.
        </li>
      </ol>

      <h2>Verification, Client Approval, and Ticket Closure</h2>
      <p>
        A warranty ticket progress flow follows four distinct status markers:
      </p>
      <ol>
        <li><strong>Open/New:</strong> The ticket is logged but has not yet been assigned or reviewed.</li>
        <li><strong>In Progress:</strong> A subcontractor is assigned and the repair is scheduled.</li>
        <li><strong>Pending Verification:</strong> The subcontractor has completed the work and uploaded proof. The builder team must inspect the work.</li>
        <li><strong>Resolved/Closed:</strong> The builder verifies the repair. Optionally, Arc can trigger a confirmation email to the client, allowing them to click <strong>Accept Resolution</strong> from their portal, officially locking the ticket.</li>
      </ol>
    </>
  )
}
