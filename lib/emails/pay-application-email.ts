/**
 * The words of the email that asks a customer to certify a pay application.
 * Plain text, pure: the sender picks the nouns (`terminology(...).project`)
 * and escapes what it renders, so builder and trade copy are tested here
 * without a request context.
 */
export function payApplicationCertificationCopy(input: {
  orgName: string | null | undefined
  projectName: string | null | undefined
  /** `terminology(posture, profile).project`: "Project" for a builder, "Job" for a trade. */
  projectNoun: string
  applicationNumber: number
  revision: number
  includesWaiver: boolean
}) {
  const org = input.orgName ?? "Your contractor"
  const project = input.projectName ?? `the ${input.projectNoun.toLowerCase()}`
  const title = `Pay Application #${input.applicationNumber}${input.revision > 0 ? ` (revision ${input.revision})` : ""}`
  return {
    title,
    subject: `${title}${input.includesWaiver ? " & signed waiver" : ""} — ${input.projectName ?? input.projectNoun}`,
    heading: `${title} is ready for your certificate`,
    intro: `${org} has submitted ${title} for ${project}.`,
    // A builder's wording is unchanged; only a trade (whose work is a "Job") names itself.
    waiverNote: input.includesWaiver
      ? `${input.projectNoun === "Project" ? "Your contractor" : org}’s signed waiver is included in this packet.`
      : null,
    review: "Review the application and continuation sheet, then certify it for payment or return it with your comments.",
  }
}
