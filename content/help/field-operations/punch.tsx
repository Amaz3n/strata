import Link from "next/link"

export default function PunchArticle() {
  return (
    <>
      <p>
        The Punch tool manages project deficiencies, quality issues, and completion list items. 
        It allows you to record issues during inspections, assign them to trade partners, track their severity, 
        and coordinate resolutions through external portals.
      </p>

      <h2>Key Features</h2>
      <ul>
        <li><strong>Walkthrough Logging:</strong> Quickly add items on-site, including detailed descriptions and photos.</li>
        <li><strong>Severity Levels:</strong> Categorize issues (e.g., Low, Medium, High) to prioritize critical repairs.</li>
        <li><strong>Location Tags:</strong> Tag issues to specific areas of the building (e.g., Unit 302, North Lobby) for quick locating.</li>
        <li><strong>External Portals:</strong> Invite clients or partners to participate in punch walks, letting them submit issues directly via token-based portal links.</li>
        <li><strong>Resolution Tracking:</strong> Monitor items as Open, Resolved, or Closed.</li>
      </ul>

      <h2>Adding Punch Items</h2>
      <p>
        Navigate to the <strong>Punch</strong> page of your project and click <strong>Add Punch Item</strong>.
      </p>
      <ol>
        <li><strong>Title &amp; Location:</strong> Describe the defect (e.g., <code>Drywall ding near baseboard</code>) and specify the location.</li>
        <li><strong>Severity:</strong> Assess the severity of the deficiency.</li>
        <li><strong>Assignee:</strong> Assign the item to the subcontractor responsible for fixing it.</li>
        <li><strong>Due Date:</strong> Set a target date for completion.</li>
      </ol>

      <h2>Subcontractor &amp; Client Portals</h2>
      <p>
        Punch lists are highly collaborative. Arc simplifies this using public portals:
      </p>
      <ul>
        <li>
          <strong>Subcontractor Portals:</strong> Subcontractors receive secure portal links to view their assigned 
          punch items, upload photos of completed fixes, and mark items as <strong>Resolved</strong>.
        </li>
        <li>
          <strong>Client Portals:</strong> During final walkthroughs, clients or architects can use a secure portal 
          link to submit new punch list items directly into your project from their mobile device.
        </li>
      </ul>

      <h2>Closing Out Punch Items</h2>
      <p>
        When a subcontractor marks an item resolved, the status updates to <strong>Resolved</strong>. 
        The project team should inspect the work on-site, verify it is corrected, and mark the item as 
        <strong>Closed</strong>. A punch item is only complete when it is officially closed by the builder.
      </p>
    </>
  )
}
