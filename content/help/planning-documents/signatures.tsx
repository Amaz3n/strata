import Link from "next/link"

export default function SignaturesArticle() {
  return (
    <>
      <p>
        Arc&apos;s integrated Signatures tool provides secure, legally binding electronic signature capabilities. 
        It allows you to send contracts, subcontracts, purchase orders, and change orders to clients, 
        partners, and subcontractors, and track their progress from start to execution.
      </p>

      <h2>Key Features</h2>
      <ul>
        <li><strong>Envelope Workflows:</strong> Group one or more files into an envelope and specify a subject and custom email notification message.</li>
        <li><strong>Recipients & Signing Order:</strong> Invite multiple signers or viewers and define the precise sequence in which they must sign.</li>
        <li><strong>Real-time Status Tracking:</strong> Monitor envelopes in draft, sent, signed, executed, declined, or voided states.</li>
        <li><strong>Automatic File Retention:</strong> Once all signers complete their signatures, Arc automatically generates a locked PDF record and saves it back into your Documents.</li>
      </ul>

      <h2>Preparing and Sending an Envelope</h2>
      <p>
        To prepare a document for signing:
      </p>
      <ol>
        <li>Navigate to the <strong>Signatures</strong> tab under your project and click <strong>New Envelope</strong> (or initiate it directly from a contract or change order page).</li>
        <li>Select the document file from your project&apos;s Documents directory that needs to be signed.</li>
        <li>Add a subject line and a message that will be included in the email notification sent to signers.</li>
      </ol>

      <h3>Defining recipients and order</h3>
      <p>
        Add the contacts who need to review or sign the document. For each recipient:
      </p>
      <ul>
        <li>Enter their name, email, and assign their role (e.g., <strong>Signer</strong> or <strong>Viewer</strong>).</li>
        <li>Specify a <strong>Signing Order</strong> sequence number. For example, if you set the client to sequence 1 and your project manager to sequence 2, the project manager will only receive the email to sign after the client has successfully completed their signature.</li>
      </ul>

      <h2>Monitoring Signing Progress</h2>
      <p>
        The Signatures dashboard displays all project envelopes categorized by their active states:
      </p>
      <ul>
        <li><strong>Draft:</strong> The envelope has been created and saved but not yet sent to recipients.</li>
        <li><strong>Sent / Delivered:</strong> The document is actively out for signature.</li>
        <li><strong>Signed:</strong> Some signers have completed their signatures, but others in the sequence are still pending.</li>
        <li><strong>Executed:</strong> All signers have successfully executed the document. The transaction is complete.</li>
        <li><strong>Declined:</strong> A recipient refused to sign the document, which halts the signature workflow.</li>
      </ul>

      <h2>Post-Signing Execution</h2>
      <p>
        Once all parties sign, Arc compiles the signature certificate and seals the PDF document. 
        The final executed document is securely stored in your project&apos;s <strong>Documents</strong> library, 
        and all signers receive an email copy for their files.
      </p>
      <blockquote>
        <strong>Note:</strong> Executed contracts and change orders in Arc automatically update their status 
        within your financial module, changing their status from pending to active.
      </blockquote>
    </>
  )
}
