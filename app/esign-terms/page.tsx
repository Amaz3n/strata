import type { Metadata } from "next"
import { ArrowLeft } from "lucide-react"
import Link from "next/link"

export const metadata: Metadata = {
  title: "Electronic Signature Terms | Arc",
  description: "Electronic signature terms and disclosures for Arc.",
}

const companyName = "Arc Project Systems LLC"
const effectiveDate = "May 24, 2026"

const sections = [
  {
    title: "1. Consent to Electronic Records and Signatures",
    body: [
      "By using Arc's electronic signature features, you agree to conduct the signing transaction electronically. You consent to receive, review, sign, retain, and access the applicable document and related records electronically.",
      "When you click a signing button, adopt a signature, type your name, draw a signature, upload a signature image, check a consent box, or otherwise complete a signing action in Arc, you intend that action to serve as your electronic signature for the applicable document.",
    ],
  },
  {
    title: "2. Ability to Access and Retain Records",
    body: [
      "To use Arc electronic signatures, you need a device, browser, internet access, and software capable of opening PDF files and retaining or printing electronic records. By signing, you confirm that you can access the document in the format presented and can retain a copy for your records.",
      "If you cannot access or retain the document electronically, do not sign electronically. Contact the sender to request another signing method or a paper copy.",
    ],
  },
  {
    title: "3. Paper Copies and Withdrawal of Consent",
    body: [
      "You may request a paper copy or ask to withdraw consent to electronic signing by contacting the party that sent you the document. Arc may not be a party to the underlying document and may not control whether the sender accepts paper signatures, imposes fees, changes timing, or changes the transaction process.",
      "Withdrawing consent after signing does not automatically cancel a document already signed electronically or affect records already provided electronically, except where applicable law requires otherwise.",
    ],
  },
  {
    title: "4. Sender and Signer Responsibilities",
    body: [
      "The sender is responsible for selecting the document, deciding whether electronic signatures are appropriate, identifying required signers, setting signing order, placing fields, confirming signer authority, and complying with any law, contract, policy, notice, witness, notarization, retention, or industry requirement that applies to the document.",
      "Each signer is responsible for reviewing the entire document before signing, confirming that the signer has authority to sign, ensuring signer information is accurate, and declining to sign if the signer does not agree.",
    ],
  },
  {
    title: "5. Documents Not Suitable for Arc E-Signatures",
    body: [
      "Arc electronic signatures are intended for ordinary business and construction workflows such as proposals, approvals, change orders, selections, contracts, and similar commercial records. Arc should not be used for documents that legally require wet ink, notarization, witnesses, government-specific execution, or another special process unless you have confirmed the process is valid for that document.",
      "Without limiting the above, Arc electronic signatures should not be used for wills, codicils, testamentary trusts, adoption, divorce, family-law matters, court orders or official court documents, certain Uniform Commercial Code documents, notices of utility termination, notices of default, acceleration, repossession, foreclosure, eviction, right to cure involving a primary residence, health or life insurance cancellation notices, product recall notices, or hazardous-materials transportation documents where electronic signing is restricted or excluded by law.",
    ],
  },
  {
    title: "6. Audit Evidence",
    body: [
      "Arc may record evidence related to signing activity, including signer name, email address, IP address, user agent, signing request identifiers, envelope identifiers, document identifiers, timestamps, field values, consent text, source file identifiers, executed file identifiers, and document hashes.",
      "Arc may include an electronic signature certificate or audit summary with executed documents. Audit evidence supports attribution and recordkeeping, but it does not guarantee that a signature or document will be enforceable in every circumstance.",
    ],
  },
  {
    title: "7. No Legal Advice",
    body: [
      "Arc provides software and does not provide legal advice. Arc does not determine whether a document is enforceable, whether a signer has authority, whether electronic signing is appropriate, or whether a document satisfies legal, regulatory, contractual, notarization, witness, or filing requirements.",
      "Consult qualified counsel for legal questions about electronic signatures, document execution, enforceability, retention, notices, construction contracts, lien rights, consumer transactions, or jurisdiction-specific requirements.",
    ],
  },
]

export default function ESignTermsPage() {
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
              <h1 className="mt-2 text-3xl font-semibold tracking-tight sm:text-4xl">Electronic Signature Terms</h1>
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
