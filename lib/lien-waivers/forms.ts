/**
 * Statutory lien-waiver forms.
 *
 * A waiver is only worth what the state's lien statute says it is worth. Three
 * states prescribe the exact words — Florida, California and Texas — and a
 * generically-worded release signed on one of those jobs is not the document a
 * lender or title company will accept. This module holds those prescribed forms
 * with the fields substituted, and Arc's own generic wording for everywhere
 * else.
 *
 * Pure by design: no Supabase, no services, no rendering. The PDF renderer owns
 * layout and the Arc disclaimer footer; `body` here is the form and nothing but
 * the form, so the statutory text can be diffed against the code when a
 * legislature amends it.
 */

export type WaiverKind = "conditional_progress" | "unconditional_progress" | "conditional_final" | "unconditional_final"

export interface WaiverFormFields {
  claimantName: string
  /** Who the claimant contracted with — the customer, not necessarily the owner. */
  customerName: string
  ownerName?: string | null
  propertyDescription: string
  jobLocation?: string | null
  amountCents: number
  /** ISO date the release runs through. Final forms have no through date. */
  throughDate: string | null
  checkPayee?: string | null
  invoiceNumber?: string | null
  /**
   * The claimant's own carve-outs: disputed claims, retainage the release is
   * not meant to reach. Rendered as a labelled list by the PDF, never folded
   * into `body`, so the statutory paragraphs stay verbatim.
   */
  exceptions?: string[]
}

export interface WaiverForm {
  /** Two-letter state code, or "" for the generic form. */
  jurisdiction: string
  statutoryCitation: string | null
  title: string
  /** Paragraphs of the form body, with the fields already substituted. */
  body: string[]
  /** Notice text printed above the signature, when the statute prescribes one. */
  noticeBanner: string | null
  requiresNotary: boolean
  /** Blanks the signer must complete on paper, when the statute has any. */
  signatureBlocks: Array<{ label: string; hint?: string | null }>
  /** True when this is the state's prescribed form rather than Arc's generic one. */
  statutory: boolean
}

const BLANK = "________"

function money(cents: number): string {
  const safe = Number.isFinite(cents) ? Math.round(cents) : 0
  return (safe / 100).toLocaleString("en-US", { style: "currency", currency: "USD" })
}

function longDate(value: string | null | undefined): string {
  if (!value) return BLANK
  const parsed = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00.000Z` : value)
  if (Number.isNaN(parsed.getTime())) return value
  return parsed.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric", timeZone: "UTC" })
}

function text(value: string | null | undefined): string {
  const trimmed = typeof value === "string" ? value.trim() : ""
  return trimmed || BLANK
}

/** The owner falls back to the customer: on a direct contract they are the same party. */
function owner(fields: WaiverFormFields): string {
  return text(fields.ownerName ?? fields.customerName)
}

function location(fields: WaiverFormFields): string {
  return text(fields.jobLocation ?? fields.propertyDescription)
}

function payee(fields: WaiverFormFields): string {
  return text(fields.checkPayee ?? fields.claimantName)
}

function jobDescription(fields: WaiverFormFields): string {
  const invoice = typeof fields.invoiceNumber === "string" && fields.invoiceNumber.trim() ? fields.invoiceNumber.trim() : null
  return invoice
    ? `all labor, services, equipment, or materials furnished under invoice ${invoice}`
    : "all labor, services, equipment, or materials furnished"
}

const KIND_TITLES: Record<WaiverKind, string> = {
  conditional_progress: "Conditional Waiver and Release on Progress Payment",
  unconditional_progress: "Unconditional Waiver and Release on Progress Payment",
  conditional_final: "Conditional Waiver and Release on Final Payment",
  unconditional_final: "Unconditional Waiver and Release on Final Payment",
}

const FL_SIGNATURE_BLOCKS = [
  { label: "Lienor", hint: "Company name" },
  { label: "By", hint: "Authorized signature and title" },
  { label: "Dated on", hint: null },
]

const CA_SIGNATURE_BLOCKS = [
  { label: "Claimant's Signature", hint: null },
  { label: "Claimant's Title", hint: null },
  { label: "Date of Signature", hint: null },
]

const TX_SIGNATURE_BLOCKS = [
  { label: "Company name", hint: null },
  { label: "By", hint: "Signature" },
  { label: "Title", hint: null },
  { label: "Date", hint: null },
]

// ---------------------------------------------------------------------------
// Florida — Fla. Stat. § 713.20. Subsections (4) and (5) are the unconditional
// progress and final forms; subsection (7) permits conditioning a check-based
// release on payment of the check. Subsection (6) addresses demands for other forms.
// Source: https://www.leg.state.fl.us/statutes/index.cfm?App_mode=Display_Statute&URL=0700-0799/0713/Sections/0713.20.html
// ---------------------------------------------------------------------------

const FL_CITATIONS: Record<WaiverKind, string> = {
  unconditional_progress: "Fla. Stat. § 713.20(4)",
  unconditional_final: "Fla. Stat. § 713.20(5)",
  conditional_progress: "Fla. Stat. § 713.20(4), (7)",
  conditional_final: "Fla. Stat. § 713.20(5), (7)",
}

const FL_TITLES: Record<WaiverKind, string> = {
  unconditional_progress: "Waiver and Release of Lien Upon Progress Payment",
  unconditional_final: "Waiver and Release of Lien Upon Final Payment",
  conditional_progress: "Conditional Waiver and Release of Lien Upon Progress Payment",
  conditional_final: "Conditional Waiver and Release of Lien Upon Final Payment",
}

function floridaForm(kind: WaiverKind, fields: WaiverFormFields): WaiverForm {
  const amount = money(fields.amountCents)
  const isFinal = kind.endsWith("final")
  const isConditional = kind.startsWith("conditional")
  const body: string[] = []

  if (isFinal) {
    body.push(
      `The undersigned lienor, in consideration of the final payment in the amount of ${amount}, hereby waives and ` +
        `releases its lien and right to claim a lien for labor, services, or materials furnished to ` +
        `${text(fields.customerName)} on the job of ${owner(fields)} to the following described property:`,
    )
    body.push(text(fields.propertyDescription))
  } else {
    body.push(
      `The undersigned lienor, in consideration of the sum of ${amount}, hereby waives and releases its lien and ` +
        `right to claim a lien for labor, services, or materials furnished through ${longDate(fields.throughDate)} to ` +
        `${text(fields.customerName)} on the job of ${owner(fields)} to the following property:`,
    )
    body.push(text(fields.propertyDescription))
    body.push(
      "This waiver and release does not cover any retention or labor, services, or materials furnished after the date specified.",
    )
  }

  if (isConditional) {
    body.push(
      `This waiver and release is conditional upon payment of ${amount} and shall be effective upon the payment being ` +
        `received, and if the payment is by check, upon the check clearing the bank upon which it is drawn.`,
    )
  }

  return {
    jurisdiction: "FL",
    statutoryCitation: FL_CITATIONS[kind],
    title: FL_TITLES[kind],
    body,
    noticeBanner: null,
    requiresNotary: false,
    signatureBlocks: FL_SIGNATURE_BLOCKS,
    statutory: true,
  }
}

// ---------------------------------------------------------------------------
// California — Cal. Civ. Code §§ 8132, 8134, 8136 and 8138. Each prescribed
// form opens with its own notice; §§ 8134 and 8138 (the unconditional pair)
// carry the warning that the document is enforceable even if the claimant has
// not been paid.
// ---------------------------------------------------------------------------

const CA_CITATIONS: Record<WaiverKind, string> = {
  conditional_progress: "Cal. Civ. Code § 8132",
  unconditional_progress: "Cal. Civ. Code § 8134",
  conditional_final: "Cal. Civ. Code § 8136",
  unconditional_final: "Cal. Civ. Code § 8138",
}

const CA_CONDITIONAL_NOTICE =
  "NOTICE: THIS DOCUMENT WAIVES THE CLAIMANT'S LIEN, STOP PAYMENT NOTICE, AND PAYMENT BOND RIGHTS EFFECTIVE ON " +
  "RECEIPT OF PAYMENT. A PERSON SHOULD NOT RELY ON THIS DOCUMENT UNLESS SATISFIED THAT THE CLAIMANT HAS RECEIVED PAYMENT."

const CA_UNCONDITIONAL_NOTICE =
  "NOTICE TO CLAIMANT: THIS DOCUMENT WAIVES AND RELEASES LIEN, STOP PAYMENT NOTICE, AND PAYMENT BOND RIGHTS " +
  "UNCONDITIONALLY AND STATES THAT YOU HAVE BEEN PAID FOR GIVING UP THOSE RIGHTS. THIS DOCUMENT IS ENFORCEABLE " +
  "AGAINST YOU IF YOU SIGN IT, EVEN IF YOU HAVE NOT BEEN PAID. IF YOU HAVE NOT BEEN PAID, USE A CONDITIONAL WAIVER " +
  "AND RELEASE FORM."

const CA_CHANGE_ORDER_SENTENCE =
  "Rights based upon labor or service provided, or equipment or material delivered, pursuant to a written change " +
  "order that has been fully executed by the parties prior to the date that this document is signed by the claimant, " +
  "are waived and released by this document, unless listed as an Exception below."

function californiaForm(kind: WaiverKind, fields: WaiverFormFields): WaiverForm {
  const amount = money(fields.amountCents)
  const isFinal = kind.endsWith("final")
  const isConditional = kind.startsWith("conditional")
  const body: string[] = []

  body.push("Identifying Information")
  body.push(`Name of Claimant: ${text(fields.claimantName)}`)
  body.push(`Name of Customer: ${text(fields.customerName)}`)
  body.push(`Job Location: ${location(fields)}`)
  body.push(`Owner: ${owner(fields)}`)
  if (!isFinal) body.push(`Through Date: ${longDate(fields.throughDate)}`)

  body.push(isConditional ? "Conditional Waiver and Release" : "Unconditional Waiver and Release")

  const scope = isFinal
    ? "This document waives and releases lien, stop payment notice, and payment bond rights the claimant has for labor " +
      "and service provided, and equipment and material delivered, to the customer on this job."
    : "This document waives and releases lien, stop payment notice, and payment bond rights the claimant has for labor " +
      "and service provided, and equipment and material delivered, to the customer on this job through the Through Date " +
      "of this document."
  body.push(`${scope} ${CA_CHANGE_ORDER_SENTENCE}`)

  if (isConditional) {
    body.push(
      "This document is effective only on the claimant's receipt of payment from the financial institution on which " +
        "the following check is drawn:",
    )
    body.push(`Maker of Check: ${text(fields.customerName)}`)
    body.push(`Amount of Check: ${amount}`)
    body.push(`Check Payable to: ${payee(fields)}`)
  } else if (isFinal) {
    body.push(`The claimant has been paid in full in the amount of ${amount}.`)
  } else {
    body.push(`The claimant has received the following progress payment: ${amount}`)
  }

  body.push("Exceptions")
  body.push("This document does not affect any of the following:")
  if (isFinal) {
    body.push("(1) Disputed claims for extras, in the amounts listed in the exceptions to this document, if any.")
  } else if (isConditional) {
    body.push("(1) Retentions.")
    body.push("(2) Extras for which the claimant has not received payment.")
    body.push(
      "(3) The following progress payments for which the claimant has previously given a conditional waiver and " +
        "release but has not received payment: as listed in the exceptions to this document, if any.",
    )
    body.push(
      "(4) Contract rights, including (A) a right based on rescission, abandonment, or breach of contract, and (B) the " +
        "right to recover compensation for work not compensated by the payment.",
    )
  } else {
    body.push("(1) Retentions.")
    body.push("(2) Extras for which the claimant has not received payment.")
    body.push(
      "(3) Contract rights, including (A) a right based on rescission, abandonment, or breach of contract, and (B) the " +
        "right to recover compensation for work not compensated by the payment.",
    )
  }

  return {
    jurisdiction: "CA",
    statutoryCitation: CA_CITATIONS[kind],
    title: KIND_TITLES[kind],
    body,
    noticeBanner: isConditional ? CA_CONDITIONAL_NOTICE : CA_UNCONDITIONAL_NOTICE,
    requiresNotary: false,
    signatureBlocks: CA_SIGNATURE_BLOCKS,
    statutory: true,
  }
}

// ---------------------------------------------------------------------------
// Texas — Tex. Prop. Code § 53.284, subsections (b) through (e). The two
// unconditional forms carry the all-caps notice; none of the four are
// notarized, which is why notarization is a per-form flag here.
// ---------------------------------------------------------------------------

const TX_CITATIONS: Record<WaiverKind, string> = {
  conditional_progress: "Tex. Prop. Code § 53.284(b)",
  unconditional_progress: "Tex. Prop. Code § 53.284(c)",
  conditional_final: "Tex. Prop. Code § 53.284(d)",
  unconditional_final: "Tex. Prop. Code § 53.284(e)",
}

const TX_UNCONDITIONAL_PROGRESS_NOTICE =
  "NOTICE: THIS DOCUMENT WAIVES RIGHTS UNCONDITIONALLY AND STATES THAT YOU HAVE BEEN PAID FOR GIVING UP THOSE " +
  "RIGHTS. IT IS PROHIBITED FOR A PERSON TO REQUIRE YOU TO SIGN THIS DOCUMENT IF YOU HAVE NOT BEEN PAID THE PAYMENT " +
  "AMOUNT SET FORTH BELOW. IF YOU HAVE NOT BEEN PAID, USE A CONDITIONAL RELEASE FORM."

const TX_UNCONDITIONAL_FINAL_NOTICE =
  "NOTICE: THIS DOCUMENT WAIVES RIGHTS UNCONDITIONALLY AND STATES THAT YOU HAVE BEEN PAID FOR GIVING UP THOSE " +
  "RIGHTS. THIS DOCUMENT IS ENFORCEABLE AGAINST YOU IF YOU SIGN IT, EVEN IF YOU HAVE NOT BEEN PAID. IF YOU HAVE NOT " +
  "BEEN PAID, USE A CONDITIONAL RELEASE FORM."

const TX_RELEASED_RIGHTS =
  "any mechanic's lien right, any right arising from a payment bond that complies with a state or federal statute, " +
  "any common law payment bond right, any claim for payment, and any rights under any similar ordinance, rule, or " +
  "statute related to claim or payment rights for persons in the signer's position"

function texasTrustSentence(isFinal: boolean): string {
  const request = isFinal ? "final payment request(s)" : "progress payment request(s)"
  const payment = isFinal ? "final payment" : "progress payment"
  return (
    `The signer warrants that the signer has already paid or will use the funds received from this ${payment} to ` +
    `promptly pay in full all of the signer's laborers, subcontractors, materialmen, and suppliers for all work, ` +
    `materials, equipment, or services provided for or to the above referenced project in regard to the attached ` +
    `statement(s) or ${request}.`
  )
}

function texasForm(kind: WaiverKind, fields: WaiverFormFields): WaiverForm {
  const amount = money(fields.amountCents)
  const isFinal = kind.endsWith("final")
  const isConditional = kind.startsWith("conditional")
  const body: string[] = []

  body.push(`Project: ${text(fields.propertyDescription)}`)
  body.push(`Job No.: ${text(fields.invoiceNumber)}`)

  if (isConditional) {
    body.push(
      `On receipt by the signer of this document of a check from ${text(fields.customerName)} (maker of check) in the ` +
        `sum of ${amount} payable to ${payee(fields)} (payee or payees of check) and when the check has been properly ` +
        `endorsed and has been paid by the bank on which it is drawn, this document becomes effective to release ` +
        `${TX_RELEASED_RIGHTS} that the signer has on the property of ${owner(fields)} (owner) located at ` +
        `${location(fields)} (location) to the following extent: ${jobDescription(fields)} (job description).`,
    )
    if (isFinal) {
      body.push(
        `This release covers the final payment to the signer for all labor, services, equipment, or materials ` +
          `furnished to the property or to ${text(fields.customerName)} (person with whom signer contracted).`,
      )
    } else {
      body.push(
        `This release covers a progress payment for all labor, services, equipment, or materials furnished to the ` +
          `property or to ${text(fields.customerName)} (person with whom signer contracted) as indicated in the ` +
          `attached statement(s) or progress payment request(s), except for unpaid retention, pending modifications ` +
          `and changes, or other items furnished, and through ${longDate(fields.throughDate)}.`,
      )
    }
    body.push("Before any recipient of this document relies on this document, the recipient should verify evidence of payment to the signer.")
  } else if (isFinal) {
    body.push(
      `The signer of this document has been paid in full in the amount of ${amount} for all labor, services, ` +
        `equipment, or materials furnished to the property or to ${text(fields.customerName)} (person with whom signer ` +
        `contracted) on the property of ${owner(fields)} (owner) located at ${location(fields)} (location) to the ` +
        `following extent: ${jobDescription(fields)} (job description). The signer therefore waives and releases ` +
        `${TX_RELEASED_RIGHTS}.`,
    )
  } else {
    body.push(
      `The signer of this document has been paid and has received a progress payment in the sum of ${amount} for all ` +
        `labor, services, equipment, or materials furnished to the property or to ${text(fields.customerName)} (person ` +
        `with whom signer contracted) on the property of ${owner(fields)} (owner) located at ${location(fields)} ` +
        `(location) to the following extent: ${jobDescription(fields)} (job description). The signer therefore waives ` +
        `and releases ${TX_RELEASED_RIGHTS}.`,
    )
    body.push(
      `This release covers a progress payment for all labor, services, equipment, or materials furnished to the ` +
        `property or to ${text(fields.customerName)} (person with whom signer contracted) as indicated in the attached ` +
        `statement(s) or progress payment request(s) through ${longDate(fields.throughDate)}, except for unpaid ` +
        `retention, pending modifications and changes, or other items furnished.`,
    )
  }

  body.push(texasTrustSentence(isFinal))

  return {
    jurisdiction: "TX",
    statutoryCitation: TX_CITATIONS[kind],
    title: KIND_TITLES[kind],
    body,
    noticeBanner: isConditional ? null : isFinal ? TX_UNCONDITIONAL_FINAL_NOTICE : TX_UNCONDITIONAL_PROGRESS_NOTICE,
    requiresNotary: false,
    signatureBlocks: TX_SIGNATURE_BLOCKS,
    statutory: true,
  }
}

// ---------------------------------------------------------------------------
// Everywhere else — Arc's own wording, which is what the receivables renderer
// has always printed. Not a statutory form and it does not pretend to be.
// ---------------------------------------------------------------------------

function genericForm(kind: WaiverKind, fields: WaiverFormFields): WaiverForm {
  const amount = money(fields.amountCents)
  const through = longDate(fields.throughDate)
  const isConditional = kind.startsWith("conditional")
  const isFinal = kind.endsWith("final")
  const scope = isFinal
    ? "all liens, lien rights, and rights to claim a lien for labor, services, or materials furnished"
    : `its lien and right to claim a lien for labor, services, or materials furnished through ${through}`

  const body: string[] = []
  if (isConditional) {
    body.push(
      `Upon receipt by the undersigned of payment in the sum of ${amount} payable to ${text(fields.claimantName)}, and ` +
        `when the payment has been properly endorsed and has been paid by the bank on which it is drawn, this document ` +
        `shall become effective to waive and release ${scope} to ${text(fields.customerName)} on the property described ` +
        `below.`,
    )
    body.push(
      "This waiver and release is conditioned upon actual receipt of payment and is effective only to the extent of the " +
        "payment actually received. Before any recipient of this document relies on it, the recipient should verify " +
        "evidence of payment to the undersigned.",
    )
  } else {
    body.push(
      `The undersigned has been paid and has received payment in the sum of ${amount} for labor, services, or materials ` +
        `furnished to ${text(fields.customerName)} on the property described below, and does hereby waive and release ` +
        `${scope}.`,
    )
    body.push(
      `This waiver and release is unconditional${isFinal ? " and constitutes a final release with respect to the property described below" : ""}.`,
    )
  }
  body.push(`Property: ${text(fields.propertyDescription)}`)
  body.push(
    "This waiver does not cover retainage, disputed claims, or amounts beyond the payment described above unless " +
      "expressly stated.",
  )

  return {
    jurisdiction: "",
    statutoryCitation: null,
    title: KIND_TITLES[kind],
    body,
    noticeBanner: null,
    requiresNotary: false,
    signatureBlocks: [
      { label: "Claimant", hint: "Company name" },
      { label: "By", hint: "Authorized signature and title" },
      { label: "Date", hint: null },
    ],
    statutory: false,
  }
}

/**
 * The form to print for this job.
 *
 * Jurisdiction comes from `resolveWaiverJurisdiction` — the property decides,
 * not the org — and anything Arc has no prescribed form for falls back to the
 * generic release rather than mislabelling Arc's wording as statutory.
 */
export function resolveWaiverForm(input: {
  jurisdiction: string | null
  kind: WaiverKind
  fields: WaiverFormFields
}): WaiverForm {
  const state = typeof input.jurisdiction === "string" ? input.jurisdiction.trim().toUpperCase() : ""
  switch (state) {
    case "FL":
      return floridaForm(input.kind, input.fields)
    case "CA":
      return californiaForm(input.kind, input.fields)
    case "TX":
      return texasForm(input.kind, input.fields)
    default:
      return genericForm(input.kind, input.fields)
  }
}

/**
 * Map explicit kinds unchanged. Legacy final has no unconditional evidence;
 * retainage never supplies payment-receipt consent or changes release scope.
 */
export function mapPayablesWaiverKind(
  waiverType: "conditional" | "unconditional" | "final" | WaiverKind,
  _hasRetainage: boolean,
): WaiverKind {
  if (waiverType.includes("_")) return waiverType as WaiverKind
  if (waiverType === "final") return "conditional_final"
  return waiverType === "conditional" ? "conditional_progress" : "unconditional_progress"
}
