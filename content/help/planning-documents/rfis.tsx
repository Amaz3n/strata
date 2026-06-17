import Link from "next/link"

export default function RfisArticle() {
  return (
    <>
      <p>
        Requests for Information (RFIs) are formal questions used to resolve gaps, conflicts, or ambiguities 
        in construction documents, drawings, or specifications. Arc&apos;s RFI tool tracks questions, responses, 
        responsibilities, and cost/schedule impacts to keep projects moving forward.
      </p>

      <h2>Key Features</h2>
      <ul>
        <li><strong>RFI Creation:</strong> Log clear questions, attach files or photos, and tag specific locations.</li>
        <li><strong>Assigned Reviewers:</strong> Direct the RFI to the architect, engineer, or subcontractor responsible for the answer.</li>
        <li><strong>Impact Tracking:</strong> Document estimated cost changes (in dollars) and schedule delays (in days) directly on the RFI.</li>
        <li><strong>Drawing & Spec References:</strong> Link the RFI directly to sheets or spec sections for faster reference.</li>
        <li><strong>Official Decisions:</strong> Record the final resolution and mark the RFI as resolved to establish a clear project record.</li>
      </ul>

      <h2>Creating and Assigning an RFI</h2>
      <p>
        Navigate to your project&apos;s <strong>RFIs</strong> page and click <strong>Create RFI</strong>.
      </p>
      <ol>
        <li><strong>Subject & Question:</strong> Keep the subject line concise and explain the question in detail.</li>
        <li><strong>Assignee:</strong> Choose the contact who must provide the resolution. Arc will notify them via email.</li>
        <li><strong>References:</strong> Select a drawing sheet number (e.g., <code>A-102</code>) or enter a specification section (e.g., <code>09 90 00</code>) to point the reviewer to the exact location of the issue.</li>
        <li><strong>Due Date:</strong> Assign a deadline. Late RFIs are automatically highlighted on dashboards.</li>
      </ol>

      <h2>Tracking Financial and Schedule Impacts</h2>
      <p>
        RFIs often lead to project changes. Arc allows you to record:
      </p>
      <ul>
        <li><strong>Cost Impact:</strong> Select whether the issue has a cost impact, and input the estimated dollar amount.</li>
        <li><strong>Schedule Impact:</strong> Select whether the issue affects the schedule, and enter the number of estimated delay days.</li>
      </ul>
      <p>
        Documenting these impacts early prevents surprise claims and helps your team prepare change orders if necessary.
      </p>

      <h2>Reviewing Responses and Closing the RFI</h2>
      <p>
        Assignees and consultants can submit responses and upload files directly to the RFI in Arc. 
        Once a satisfactory answer is received:
      </p>
      <ol>
        <li>Click <strong>Resolve RFI</strong> on the details panel.</li>
        <li>Write a <strong>Decision Note</strong> summarizing the final instructions or changes.</li>
        <li>Set the status to <strong>Closed</strong>.</li>
      </ol>
      <blockquote>
        <strong>Tip:</strong> Closing the RFI notifies all stakeholders. The decision note becomes the official, 
        archived solution for the project record.
      </blockquote>
    </>
  )
}
