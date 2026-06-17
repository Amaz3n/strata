import Link from "next/link"

export default function ProspectsArticle() {
  return (
    <>
      <p>
        The Pipeline tool in Arc functions as your sales customer relationship management (CRM) system. It tracks new 
        inquiries, schedules follow-ups, and monitors opportunities through your sales funnel before they become active projects.
      </p>

      <h2>Key Features</h2>
      <ul>
        <li><strong>Sales Funnel Stages:</strong> Monitor prospects through distinct pipeline states: New, Contacted, Qualified, Pricing, and Estimate Sent.</li>
        <li><strong>Attention Alerts:</strong> Identify Stalled prospects (no activity in 14 days) and Follow-ups Due to ensure no lead goes cold.</li>
        <li><strong>Lead Details:</strong> Track project types, budget ranges, timeline preferences, lead sources (e.g., website, referral), and custom tags.</li>
        <li><strong>Contact Management:</strong> Associate multiple contacts with a prospect and designate a primary contact.</li>
      </ul>

      <h2>The Sales Funnel Stages</h2>
      <p>
        Move prospects through the pipeline as your relationship develops:
      </p>
      <ul>
        <li><strong>New:</strong> Inquiries that have recently entered the system. A prospect is flagged as a &quot;New Inquiry&quot; for its first 14 days.</li>
        <li><strong>Contacted:</strong> Initial outreach has been made (e.g., phone call or introductory email).</li>
        <li><strong>Qualified:</strong> The opportunity is a good fit for your company based on scope, location, and alignment.</li>
        <li><strong>Pricing:</strong> Your estimating team is compiling costs and working on a proposal.</li>
        <li><strong>Estimate Sent:</strong> The formal proposal has been generated and delivered to the client.</li>
        <li><strong>Changes Requested:</strong> The client has reviewed the proposal and requested adjustments.</li>
        <li><strong>Client Approved:</strong> The client has accepted the proposal terms.</li>
        <li><strong>Executed:</strong> The contract is signed, and the prospect is ready to be converted into an active project.</li>
      </ul>

      <h2>Follow-Up Scheduling and Alerts</h2>
      <p>
        The Pipeline dashboard uses alerts to help salespeople prioritize daily actions:
      </p>
      <ul>
        <li><strong>Follow-Ups Due:</strong> Displays the count of active prospects with a scheduled follow-up date of today or in the past. To clear an alert, log a follow-up touch and schedule the next action date.</li>
        <li><strong>Stalled Prospects:</strong> Displays leads in active stages (New through Client Approved) that have not been modified or updated in <strong>14 days</strong>, reminding you to re-engage.</li>
      </ul>

      <h2>Adding and Tracking Prospects</h2>
      <p>
        To log an opportunity, navigate to the <strong>Pipeline</strong> page and click <strong>Create Prospect</strong>.
      </p>
      <ol>
        <li><strong>Opportunity Name:</strong> Provide a descriptive name (e.g., <code>Jones Custom Home</code>).</li>
        <li><strong>Sales Lead details:</strong> Input the estimated budget range, preferred timeline (e.g., Spring 2027), project type (e.g., Kitchen, Custom Home), and lead source.</li>
        <li><strong>Location:</strong> Enter the jobsite street, city, state, and zip. This will carry over to the project once won.</li>
        <li><strong>Primary Contact:</strong> Log the client&apos;s name, phone number, email, and role.</li>
      </ol>
    </>
  )
}
