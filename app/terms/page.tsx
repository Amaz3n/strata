import type { Metadata } from "next"
import { ArrowLeft } from "lucide-react"
import Link from "next/link"

export const metadata: Metadata = {
  title: "Terms of Service | Arc",
  description: "Terms of Service for Arc.",
}

const companyName = "Arc Project Systems LLC"
const effectiveDate = "May 8, 2026"

const sections = [
  {
    title: "1. Acceptance of These Terms",
    body: [
      "These Terms of Service govern access to and use of Arc, including our websites, applications, project management tools, financial workflow tools, payment features, communication features, files, automations, and related services. By creating an account, accessing Arc, inviting users, uploading data, or using any part of the service, you agree to these Terms on behalf of yourself and, if applicable, the organization you represent.",
      "If you do not agree to these Terms, do not use Arc.",
    ],
  },
  {
    title: "2. Customer Responsibility",
    body: [
      "Arc is a software tool. You are responsible for how you use it, the data you enter, the decisions you make from information shown in Arc, the people you invite, the permissions you grant, and the projects, invoices, payments, approvals, schedules, documents, communications, and financial records you manage through Arc.",
      "You are responsible for verifying all amounts, dates, contract terms, payment instructions, lien waiver requirements, compliance requirements, construction documents, project records, tax treatment, legal obligations, and accounting outputs before relying on them or sending them to another person.",
    ],
  },
  {
    title: "3. Accounts, Security, and Authorized Users",
    body: [
      "You are responsible for maintaining the confidentiality of account credentials and for all activity under your account or organization. You must promptly notify us if you believe an account has been compromised or used without authorization.",
      "We are not responsible for losses, damages, unauthorized activity, misdirected payments, incorrect approvals, data exposure, or business interruption caused by weak credentials, compromised devices, phishing, unauthorized users, incorrect permissions, or your failure to manage account access.",
    ],
  },
  {
    title: "4. Payments and Third-Party Services",
    body: [
      "Arc may integrate with third-party services, including Stripe for payment processing and billing-related functionality. Third-party services are provided by their respective providers under their own terms, policies, service levels, fees, compliance obligations, settlement timing, risk reviews, holds, reserves, disputes, refunds, chargebacks, and availability rules.",
      "We do not control Stripe, banks, card networks, payment methods, financial partners, accounting platforms, email providers, cloud providers, or other third-party services. To the maximum extent permitted by law, we are not liable for any loss, delay, failed payment, rejected payment, reversed payment, chargeback, reserve, account hold, payout delay, processor outage, processor error, incorrect processor configuration, processor fee, exchange issue, payment dispute, lost revenue, lost profit, or other damage arising from or related to Stripe or any other third-party service.",
    ],
  },
  {
    title: "5. Customer Data and Backups",
    body: [
      "You retain ownership of the data you submit to Arc. You grant us the rights needed to host, process, transmit, display, secure, back up, and otherwise operate Arc for you and your authorized users.",
      "You are responsible for keeping independent copies and backups of important records. To the maximum extent permitted by law, we are not liable for lost, corrupted, delayed, unavailable, deleted, incomplete, or inaccurate data, including project records, financial records, drawings, invoices, contracts, signatures, compliance records, communications, or attachments.",
    ],
  },
  {
    title: "6. Acceptable Use",
    body: [
      "You may not use Arc to violate law, infringe rights, distribute malware, attack or disrupt systems, misrepresent identity, process unauthorized payments, submit false or misleading information, evade sanctions or compliance obligations, scrape or reverse engineer the service, or interfere with another customer’s use of Arc.",
      "If you breach these Terms, misuse Arc, fail to pay amounts owed, create security or legal risk, or expose us or others to potential harm, we may suspend or terminate access, remove content, disable features, preserve evidence, or take other action we reasonably consider necessary.",
    ],
  },
  {
    title: "7. No Professional Advice",
    body: [
      "Arc does not provide legal, accounting, tax, insurance, engineering, architectural, construction, financial, payment, or compliance advice. Information in Arc may be incomplete, delayed, inaccurate, or dependent on user-entered data or third-party systems.",
      "You should consult qualified professionals before making legal, financial, tax, construction, compliance, or payment decisions.",
    ],
  },
  {
    title: "8. Service Availability and Changes",
    body: [
      "We may modify, suspend, discontinue, limit, or update Arc or any feature at any time. Arc may be unavailable because of maintenance, upgrades, bugs, security events, third-party outages, internet failures, payment processor issues, force majeure events, or circumstances outside our control.",
      "We do not guarantee that Arc will be uninterrupted, error-free, secure, timely, or available at any particular time.",
    ],
  },
  {
    title: "9. Disclaimer of Warranties",
    body: [
      "Arc is provided on an “as is” and “as available” basis. To the maximum extent permitted by law, Arc Project Systems LLC disclaims all warranties, whether express, implied, statutory, or otherwise, including warranties of merchantability, fitness for a particular purpose, title, non-infringement, accuracy, availability, security, reliability, and uninterrupted operation.",
      "We do not warrant that Arc will meet your requirements, prevent losses, prevent breaches, detect all errors, produce accurate financial or project outputs, ensure payment, ensure compliance, or operate without interruption or defects.",
    ],
  },
  {
    title: "10. Limitation of Liability",
    body: [
      "To the maximum extent permitted by law, Arc Project Systems LLC and its owners, officers, employees, contractors, affiliates, suppliers, and licensors will not be liable for indirect, incidental, special, consequential, exemplary, punitive, or enhanced damages, including lost profits, lost revenue, lost savings, lost business, business interruption, loss of goodwill, loss of data, cost of replacement services, payment losses, construction losses, financing losses, project delays, or reputational harm, even if we were advised such damages were possible.",
      "To the maximum extent permitted by law, our total aggregate liability for all claims arising out of or related to Arc, these Terms, or any related service will not exceed the greater of: (a) the amount you paid to Arc Project Systems LLC for the service in the three months before the event giving rise to the claim, or (b) one hundred U.S. dollars.",
      "These limitations apply regardless of the theory of liability, including contract, tort, negligence, strict liability, warranty, statute, or otherwise, and even if a limited remedy fails of its essential purpose. Some jurisdictions do not allow certain limitations, so some limitations may apply only to the fullest extent permitted by law.",
    ],
  },
  {
    title: "11. Breach, Security Incidents, and Unauthorized Access",
    body: [
      "You are responsible for your systems, users, credentials, permissions, integrations, and data handling practices. To the maximum extent permitted by law, we are not liable for losses arising from unauthorized access, credential compromise, phishing, malware, social engineering, user error, misconfigured permissions, compromised third-party services, or breaches caused by your acts, omissions, systems, users, contractors, or vendors.",
      "If a security incident occurs, your sole remedies are limited to those expressly required by applicable law or expressly stated in a separate written agreement signed by us.",
    ],
  },
  {
    title: "12. Indemnification",
    body: [
      "You will defend, indemnify, and hold harmless Arc Project Systems LLC and its owners, officers, employees, contractors, affiliates, suppliers, and licensors from and against claims, damages, losses, liabilities, fines, penalties, costs, and expenses, including reasonable attorneys’ fees, arising from or related to your use of Arc, your data, your projects, your payments, your users, your breach of these Terms, your violation of law, or your dispute with any customer, subcontractor, vendor, owner, employee, consultant, payment processor, or third party.",
    ],
  },
  {
    title: "13. Termination",
    body: [
      "You may stop using Arc at any time. We may suspend or terminate access to Arc if you breach these Terms, fail to pay, create risk for us or others, or if we discontinue the service.",
      "After termination, we may delete or retain data as permitted by law, our internal retention practices, and any applicable agreement. Sections intended to survive termination will survive, including payment obligations, disclaimers, limitations of liability, indemnification, ownership, and dispute terms.",
    ],
  },
  {
    title: "14. Governing Law",
    body: [
      "These Terms are governed by the laws of the State of Florida, without regard to conflict of laws principles. Venue for disputes will be in the state or federal courts located in Florida, unless applicable law requires otherwise.",
    ],
  },
  {
    title: "15. Contact",
    body: [
      "Questions about these Terms can be sent to support@arcnaples.com.",
    ],
  },
]

export default function TermsPage() {
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
              <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Terms of Service</h1>
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
