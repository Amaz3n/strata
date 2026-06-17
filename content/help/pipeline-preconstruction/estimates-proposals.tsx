import Link from "next/link"

export default function EstimatesProposalsArticle() {
  return (
    <>
      <p>
        The Estimates &amp; Proposals tool allows preconstruction teams to draft detailed estimates, format how pricing is displayed, 
        and build client-facing contracts. It includes client-selectable optional upgrades and a secure signing portal.
      </p>

      <h2>Key Features</h2>
      <ul>
        <li><strong>Flexible Estimates:</strong> Structure pricing with itemized line items, cost codes, markup percentages, and group headers.</li>
        <li><strong>Optional Add-Ons:</strong> Mark lines as optional upgrade items, letting clients toggle selections in their portal to see real-time price changes.</li>
        <li><strong>Custom Presentation:</strong> Add cover notes, upload photo galleries, and choose pricing display modes (Itemized, Grouped, or Total Only).</li>
        <li><strong>Proposals &amp; Contracts:</strong> Link estimates to proposals, add custom terms and legal fine print, set expiration dates, and enforce signing requirements.</li>
      </ul>

      <h2>Building an Estimate</h2>
      <p>
        Navigate to the <strong>Estimates</strong> tab of a prospect and click <strong>Create Estimate</strong>.
      </p>
      <ol>
        <li><strong>Structure Lines:</strong> Add lines by selecting cost codes, entering descriptions, quantities, units, and unit costs.</li>
        <li><strong>Line-Item Markups:</strong> Apply individual markup percentages per line to calculate your gross margins.</li>
        <li><strong>Optional Items:</strong> Toggle the <strong>Optional</strong> flag on specific upgrades (e.g., <code>Quartz Countertop Upgrade</code>). These items are excluded from the base estimate total but can be selected by the client.</li>
        <li><strong>Presentation Settings:</strong> Write a custom <strong>Cover Note</strong> introducing your company, upload jobsite renderings (photo gallery), and choose whether the client sees full itemized details or just group totals.</li>
      </ol>

      <h2>Creating a Proposal (Contract)</h2>
      <p>
        Once your estimate is ready, click <strong>Create Proposal</strong> to turn it into a contract agreement.
      </p>
      <ul>
        <li><strong>Validity:</strong> Set a <strong>Valid Until</strong> date after which the proposal expires automatically.</li>
        <li><strong>Terms &amp; Conditions:</strong> Input your legal fine print, contract exclusions, payment schedule, or warranty terms.</li>
        <li><strong>Signature Required:</strong> Toggle whether the client must electronically sign the proposal to accept it.</li>
      </ul>

      <h2>The Client Acceptance Portal</h2>
      <p>
        When you send the proposal, Arc emails your client a secure, passwordless link to their portal:
      </p>
      <ol>
        <li><strong>Review:</strong> Clients view the cover note, proposal terms, and estimated pricing in a clean web page.</li>
        <li><strong>Upgrades:</strong> They can check or uncheck optional add-on lines to customize their scope, updating the proposal total in real-time.</li>
        <li><strong>Sign:</strong> If signatures are required, clients sign directly in their browser.</li>
      </ol>
      <blockquote>
        <strong>Note:</strong> When the client accepts or signs the proposal, Arc executes a **Proposal Acceptance Conversion** 
        that automatically creates the project contract, initializes the project budget, and populates project allowance items.
      </blockquote>
    </>
  )
}
