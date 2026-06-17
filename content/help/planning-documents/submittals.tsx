import Link from "next/link"

export default function SubmittalsArticle() {
  return (
    <>
      <p>
        The Submittals tool manages the process of gathering, reviewing, and approving product data, shop drawings, 
        material samples, and warranties before items are fabricated and shipped to the jobsite. This ensures 
        all installed materials conform to the design specifications.
      </p>

      <h2>Key Features</h2>
      <ul>
        <li><strong>Submittal Registry:</strong> Keep an organized catalog of all submittal requirements for the project.</li>
        <li><strong>Spec Section Categorization:</strong> Categorize submittals by specification divisions (e.g., Concrete, Finishes, HVAC).</li>
        <li><strong>Reviewer Workflow:</strong> Route files and information to architects, engineers, or consultants for official approval.</li>
        <li><strong>Decision Log:</strong> Track formal approval decisions: Approved, Approved as Noted, Revise and Resubmit, or Rejected.</li>
      </ul>

      <h2>The Submittal Process</h2>
      <p>
        A typical submittal in Arc goes through three main phases:
      </p>
      <ol>
        <li>
          <strong>Preparation:</strong> The subcontractor or builder uploads the submittal documents 
          (e.g., manufacturer spec sheets or shop drawings) and sets the status to <strong>Submitted</strong>.
        </li>
        <li>
          <strong>Review:</strong> The submittal is assigned to a design reviewer (such as the project architect). 
          They analyze the documents for compliance with the project specifications.
        </li>
        <li>
          <strong>Response:</strong> The reviewer logs their official decision and notes, changing the status 
          accordingly (e.g., <strong>Approved</strong> or <strong>Revise &amp; Resubmit</strong>).
        </li>
      </ol>

      <h2>Creating a Submittal Item</h2>
      <p>
        To log a submittal, open the <strong>Submittals</strong> tab in your project and click <strong>Create Submittal</strong>.
      </p>
      <ul>
        <li><strong>Title & Description:</strong> Use a clear title (e.g., <code>Structural Steel Shop Drawings</code>).</li>
        <li><strong>Spec Section:</strong> Link the item to a specific spec division (e.g., <code>05 12 00</code>) for easy cataloging.</li>
        <li><strong>Submittal Type:</strong> Choose whether the item is Product Data, Shop Drawings, a Sample, a Test Report, or another category.</li>
        <li><strong>Due Date:</strong> Specify when the approval is required to prevent material procurement delays in the field.</li>
        <li><strong>Attachment:</strong> Upload the files representing the submittal details.</li>
      </ul>

      <h2>Logging Review Decisions</h2>
      <p>
        When a reviewer opens a submittal, they can add comments and assign a formal decision status:
      </p>
      <ul>
        <li><strong>Approved:</strong> The material is cleared for fabrication and delivery.</li>
        <li><strong>Approved as Noted:</strong> The material is approved, provided the reviewer&apos;s written corrections are followed. No resubmission is needed.</li>
        <li><strong>Revise &amp; Resubmit:</strong> The submittal does not comply and must be revised by the subcontractor and uploaded again.</li>
        <li><strong>Rejected:</strong> The submittal is completely unacceptable and must be replaced.</li>
      </ul>
      <blockquote>
        <strong>Tip:</strong> Once a decision is logged, Arc automatically notifies the submitter, ensuring 
        they can proceed with orders or make necessary corrections immediately.
      </blockquote>
    </>
  )
}
