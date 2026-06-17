import Link from "next/link"

export default function TroubleshootingOverviewArticle() {
  return (
    <>
      <p>
        Welcome to the Arc Troubleshooting Guide. If you encounter issues with interface visibility, 
        document uploads, OCR character recognition, QuickBooks Online synchronization, or Stripe credit card/ACH payments, 
        we provide detailed sub-guides to resolve them.
      </p>

      <h2>Troubleshooting Directories</h2>
      <p>
        Select the topic below that matches the issue you are experiencing:
      </p>

      <h3>1. Permissions &amp; Access Issues</h3>
      <p>
        Resolve issues regarding hidden buttons, missing tabs, expired user invitations, or problems signing subcontracts and 
        proposals in client or subcontractor portals.
        {" "}
        <Link href="/help/troubleshooting/common-issues/permissions-access-issues">
          Read the Permissions &amp; Access Guide
        </Link>
        .
      </p>

      <h3>2. Document &amp; OCR Upload Issues</h3>
      <p>
        Fix stuck drawing uploads, learn how to flatten CAD layers to resolve timeouts, and calibrate drawing title block 
        selection zones to correct sheet numbers.
        {" "}
        <Link href="/help/troubleshooting/common-issues/document-ocr-issues">
          Read the Document &amp; OCR Upload Guide
        </Link>
        .
      </p>

      <h3>3. QuickBooks &amp; Stripe Sync Issues</h3>
      <p>
        Address QuickBooks Online expired tokens, duplicate bill/invoice numbers, Chart of Accounts cache refreshing, 
        Stripe payouts verification holds, and client ACH micro-deposit verification timelines.
        {" "}
        <Link href="/help/troubleshooting/common-issues/integration-sync-issues">
          Read the QuickBooks &amp; Stripe Sync Guide
        </Link>
        .
      </p>

      <h2>General Troubleshooting Checklists</h2>
      <p>
        Before diving into the detailed guides, try these standard browser troubleshooting practices to resolve temporary cache issues:
      </p>
      <ul>
        <li><strong>Force Refresh (Hard Reload):</strong> Hold <code>Shift</code> and click the reload button in your browser, or press <code>Cmd + Shift + R</code> (Mac) / <code>Ctrl + F5</code> (Windows). This forces the browser to discard its cached Javascript bundle and load the latest updates.</li>
        <li><strong>Test in Incognito:</strong> Open a Private/Incognito window and log into your Arc workspace. If the issue disappears, it points to local browser cookie conflicts or active browser extension blockers (e.g., ad blockers interfering with payment popups).</li>
        <li><strong>Verify Browser Compatibility:</strong> Ensure your browser is updated. Arc supports the latest versions of Google Chrome, Apple Safari, Microsoft Edge, and Mozilla Firefox.</li>
      </ul>

      <h2>Contacting Arc Support</h2>
      <p>
        If you are unable to resolve the issue using these guides, please reach out to our dedicated support desk:
      </p>
      <ul>
        <li><strong>Support Email:</strong> <a href="mailto:support@arcnaples.com">support@arcnaples.com</a></li>
        <li><strong>Details to Include:</strong>
          <ul>
            <li>Your company/organization name.</li>
            <li>The active project name and the exact URL where the issue occurs (e.g., <code>/projects/104/budget</code>).</li>
            <li>A brief description of what you were trying to do, any error codes shown, and a screenshot of the issue.</li>
          </ul>
        </li>
      </ul>
    </>
  )
}
