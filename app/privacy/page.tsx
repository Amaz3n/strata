import type { Metadata } from "next"
import { ArrowLeft } from "lucide-react"
import Link from "next/link"

export const metadata: Metadata = {
  title: "Privacy Policy | Arc",
  description: "Privacy Policy for Arc.",
}

const companyName = "Arc Project Systems LLC"
const effectiveDate = "May 17, 2026"

const sections = [
  {
    title: "1. Overview",
    body: [
      "This Privacy Policy explains how Arc Project Systems LLC collects, uses, shares, and protects information when you use Arc, including our websites, applications, project management tools, financial workflow tools, payment features, communication features, files, automations, integrations, and related services.",
      "By using Arc, you acknowledge that we process information as described in this Privacy Policy.",
    ],
  },
  {
    title: "2. Information We Collect",
    body: [
      "We collect account and contact information, organization information, project records, financial workflow data, invoices, payments metadata, documents, files, messages, comments, activity logs, integration settings, support requests, and other information you or your authorized users provide to Arc.",
      "We also collect technical information such as device and browser information, IP address, usage events, authentication events, error logs, security logs, and similar operational data needed to operate and protect the service.",
      "If you use electronic signature features, we may collect signer names, email addresses, signature images or typed signature renderings, initials, field responses, consent text, signing timestamps, viewed timestamps, IP addresses, user agents, signing request identifiers, envelope identifiers, document identifiers, file identifiers, document hashes, and audit evidence needed to operate the signing workflow and support attribution, integrity, retention, and dispute resolution.",
    ],
  },
  {
    title: "3. QuickBooks and Other Integrations",
    body: [
      "If you connect Arc to QuickBooks Online, Stripe, storage providers, email providers, or other third-party services, we process the information needed to enable that integration. For QuickBooks Online, this may include company identifiers, OAuth tokens, company profile information, chart of accounts references, customers, vendors, invoices, bills, payments, expenses, sync records, and webhook events.",
      "We use integration data to provide the connected features you request, maintain sync status, troubleshoot errors, prevent duplicate records, and keep your Arc workspace aligned with connected services.",
    ],
  },
  {
    title: "4. How We Use Information",
    body: [
      "We use information to provide, secure, maintain, improve, and support Arc; authenticate users; manage organizations and permissions; process project and financial workflows; sync connected integrations; send service communications; troubleshoot issues; prevent misuse; comply with legal obligations; and enforce our terms.",
      "We may use aggregated or de-identified information to understand service performance, improve product quality, and make business decisions.",
    ],
  },
  {
    title: "5. How We Share Information",
    body: [
      "We share information with service providers and subprocessors that help us operate Arc, such as cloud hosting, database, storage, authentication, analytics, email, payment, support, and integration providers. These providers are authorized to process information only as needed to provide services to us.",
      "We may share information with connected third-party services when you authorize an integration, with members of your organization according to workspace permissions, when required by law, to protect rights and safety, or as part of a merger, acquisition, financing, or sale of business assets.",
    ],
  },
  {
    title: "6. Data Security",
    body: [
      "We use administrative, technical, and organizational safeguards designed to protect information, including access controls, encryption for sensitive tokens, logging, and permission-based access. No system is perfectly secure, and we cannot guarantee that unauthorized access, loss, misuse, or disclosure will never occur.",
    ],
  },
  {
    title: "7. Data Retention",
    body: [
      "We retain information for as long as needed to provide Arc, maintain business and security records, comply with legal obligations, resolve disputes, enforce agreements, and support backups and disaster recovery. Retention periods may vary based on the type of information and the context in which it is used.",
    ],
  },
  {
    title: "8. Your Choices",
    body: [
      "You may update account and organization information within Arc where features are available. Organization administrators can manage users, permissions, and connected integrations. You may disconnect QuickBooks Online or other integrations from the integrations settings in Arc.",
      "You may contact us to request access, correction, deletion, or export of information. We may need to verify your identity and may retain information where required or permitted by law.",
    ],
  },
  {
    title: "9. Children's Privacy",
    body: [
      "Arc is not intended for children under 13, and we do not knowingly collect personal information from children under 13.",
    ],
  },
  {
    title: "10. Changes to This Policy",
    body: [
      "We may update this Privacy Policy from time to time. The updated version will be posted on this page with a new effective date. Continued use of Arc after an update means the updated policy applies.",
    ],
  },
  {
    title: "11. Contact",
    body: [
      "Questions about this Privacy Policy can be sent to support@arcnaples.com.",
    ],
  },
]

export default function PrivacyPage() {
  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-4xl px-5 py-10 sm:px-8 lg:py-14">
        <div className="mb-10 border-b border-border pb-6">
          <Link href="/" className="mb-6 inline-flex items-center gap-2 text-sm font-medium text-muted-foreground transition-colors hover:text-foreground">
            <ArrowLeft className="h-4 w-4" />
            Back to Arc
          </Link>
          <div className="flex items-center gap-5">
            <div className="flex h-16 w-16 shrink-0 items-center justify-center border border-border/60 bg-white shadow-sm">
              <img src="/arc-logo2.svg" alt="Arc logo" className="h-11 w-11 object-contain" />
            </div>
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">{companyName}</p>
              <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Privacy Policy</h1>
              <p className="mt-2 text-sm text-muted-foreground">Effective {effectiveDate}</p>
            </div>
          </div>
        </div>

        <div className="space-y-8">
          {sections.map((section) => (
            <section key={section.title} className="space-y-3">
              <h2 className="text-lg font-semibold tracking-tight">{section.title}</h2>
              <div className="space-y-3 text-sm leading-7 text-muted-foreground">
                {section.body.map((paragraph) => (
                  <p key={paragraph}>{paragraph}</p>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </main>
  )
}
