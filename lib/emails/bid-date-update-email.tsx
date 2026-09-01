import { Button, Heading, Link, Section, Text } from "@react-email/components"

import { EmailLayout } from "./email-layout"
import {
  button,
  buttonWrap,
  contentCard,
  contentLabel,
  contentText,
  eventLabelText,
  fallbackText,
  heading,
  link,
  metaCard,
  metaLabel,
  metaRow,
  metaValue,
  paragraph,
  subjectText,
} from "./theme"

export interface BidDateUpdateEmailProps {
  companyName?: string | null
  contactName?: string | null
  projectName?: string | null
  bidPackageTitle: string
  oldDueDate?: string | null
  newDueDate: string
  orgName?: string | null
  orgLogoUrl?: string | null
  bidLink: string
}

export function BidDateUpdateEmail({
  companyName,
  contactName,
  projectName,
  bidPackageTitle,
  oldDueDate,
  newDueDate,
  orgName,
  orgLogoUrl,
  bidLink,
}: BidDateUpdateEmailProps) {
  const previewText = `Due Date Updated: ${bidPackageTitle}`
  const displayOrgName = orgName ?? "Arc"
  const greeting = contactName ? `Hi ${contactName},` : "Hi,"

  return (
    <EmailLayout
      preview={previewText}
      subtitle="Bid Update"
      orgName={orgName}
      orgLogoUrl={orgLogoUrl}
    >
      <Text style={eventLabelText}>Deadline Update</Text>
      <Heading style={heading}>Due Date Updated</Heading>
      <Text style={subjectText}>{bidPackageTitle}</Text>

      <Text style={paragraph}>{greeting}</Text>
      <Text style={paragraph}>
        <strong>{displayOrgName}</strong> has updated the bid submission deadline for the bid package <strong>{bidPackageTitle}</strong>.
      </Text>

      <Section style={metaCard}>
        <Text style={metaRow}>
          <span style={metaLabel}>Bid Package:</span> <span style={metaValue}>{bidPackageTitle}</span>
        </Text>
        {projectName ? (
          <Text style={metaRow}>
            <span style={metaLabel}>Project:</span> <span style={metaValue}>{projectName}</span>
          </Text>
        ) : null}
        {oldDueDate ? (
          <Text style={metaRow}>
            <span style={metaLabel}>Previous Due Date:</span> <span style={metaValueDelete}>{oldDueDate}</span>
          </Text>
        ) : null}
        <Text style={metaRow}>
          <span style={metaLabel}>New Due Date:</span> <span style={metaValueSuccess}>{newDueDate}</span>
        </Text>
      </Section>

      <Section style={contentCard}>
        <Text style={contentLabel}>Next Steps</Text>
        <Text style={contentText}>
          Please ensure your proposal is finalized and submitted through your portal by the new deadline.
        </Text>
      </Section>

      <Section style={buttonWrap}>
        <Button style={button} href={bidLink}>
          View Bid Package
        </Button>
      </Section>

      <Text style={fallbackText}>
        If the button does not open,{" "}
        <Link href={bidLink} style={link}>
          open secure link
        </Link>
      </Text>
    </EmailLayout>
  )
}

const metaValueDelete: React.CSSProperties = {
  color: "#b91c1c",
  fontSize: "13px",
  fontWeight: 600,
  textDecoration: "line-through",
}

const metaValueSuccess: React.CSSProperties = {
  color: "#15803d",
  fontSize: "13px",
  fontWeight: 700,
}

export default BidDateUpdateEmail
