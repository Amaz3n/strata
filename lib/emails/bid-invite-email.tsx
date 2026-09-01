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

export interface BidInviteEmailProps {
  companyName?: string | null
  contactName?: string | null
  projectName?: string | null
  bidPackageTitle: string
  trade?: string | null
  dueDate?: string | null
  orgName?: string | null
  orgLogoUrl?: string | null
  bidLink: string
}

export function BidInviteEmail({
  companyName,
  contactName,
  projectName,
  bidPackageTitle,
  trade,
  dueDate,
  orgName,
  orgLogoUrl,
  bidLink,
}: BidInviteEmailProps) {
  const previewText = `You're invited to bid on ${bidPackageTitle}`
  const displayOrgName = orgName ?? "Arc"
  const greeting = contactName ? `Hi ${contactName},` : "Hi,"

  return (
    <EmailLayout
      preview={previewText}
      subtitle="Bid Invitation"
      orgName={orgName}
      orgLogoUrl={orgLogoUrl}
    >
      <Text style={eventLabelText}>Invitation to Bid</Text>
      <Heading style={heading}>Bid Package</Heading>
      <Text style={subjectText}>{bidPackageTitle}</Text>

      <Text style={paragraph}>{greeting}</Text>
      <Text style={paragraph}>
        <strong>{displayOrgName}</strong> invited{" "}
        {companyName ? <strong>{companyName}</strong> : "you"} to submit a bid.
      </Text>

      <Section style={metaCard}>
        {companyName ? (
          <Text style={metaRow}>
            <span style={metaLabel}>Invitee:</span> <span style={metaValue}>{companyName}</span>
          </Text>
        ) : null}
        <Text style={metaRow}>
          <span style={metaLabel}>Invited By:</span> <span style={metaValue}>{displayOrgName}</span>
        </Text>
        {projectName ? (
          <Text style={metaRow}>
            <span style={metaLabel}>Project:</span> <span style={metaValue}>{projectName}</span>
          </Text>
        ) : null}
        {trade ? (
          <Text style={metaRow}>
            <span style={metaLabel}>Trade:</span> <span style={metaValue}>{trade}</span>
          </Text>
        ) : null}
        {dueDate ? (
          <Text style={metaRow}>
            <span style={metaLabel}>Due Date:</span> <span style={metaValue}>{dueDate}</span>
          </Text>
        ) : null}
      </Section>

      <Section style={contentCard}>
        <Text style={contentLabel}>What to Expect</Text>
        <Text style={contentText}>
          Review requirements and submit pricing, clarifications, and supporting details through Arc.
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

export default BidInviteEmail
