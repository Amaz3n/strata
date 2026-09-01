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

export interface BidAddendumEmailProps {
  companyName?: string | null
  contactName?: string | null
  projectName?: string | null
  bidPackageTitle: string
  addendumNumber: number
  addendumTitle?: string | null
  addendumMessage?: string | null
  orgName?: string | null
  orgLogoUrl?: string | null
  bidLink: string
}

export function BidAddendumEmail({
  companyName,
  contactName,
  projectName,
  bidPackageTitle,
  addendumNumber,
  addendumTitle,
  addendumMessage,
  orgName,
  orgLogoUrl,
  bidLink,
}: BidAddendumEmailProps) {
  const previewText = `Addendum #${addendumNumber} Issued: ${bidPackageTitle}`
  const displayOrgName = orgName ?? "Arc"
  const greeting = contactName ? `Hi ${contactName},` : "Hi,"

  return (
    <EmailLayout
      preview={previewText}
      subtitle="Bid Addendum"
      orgName={orgName}
      orgLogoUrl={orgLogoUrl}
    >
      <Text style={eventLabelText}>Addendum Issued</Text>
      <Heading style={heading}>Addendum #{addendumNumber}</Heading>
      <Text style={subjectText}>{addendumTitle || `Update to ${bidPackageTitle}`}</Text>

      <Text style={paragraph}>{greeting}</Text>
      <Text style={paragraph}>
        <strong>{displayOrgName}</strong> has issued <strong>Addendum #{addendumNumber}</strong> for the bid package <strong>{bidPackageTitle}</strong>.
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
        <Text style={metaRow}>
          <span style={metaLabel}>Issued By:</span> <span style={metaValue}>{displayOrgName}</span>
        </Text>
      </Section>

      {addendumMessage ? (
        <Section style={contentCard}>
          <Text style={contentLabel}>Message / Description</Text>
          <Text style={contentText}>{addendumMessage}</Text>
        </Section>
      ) : null}

      <Section style={buttonWrap}>
        <Button style={button} href={bidLink}>
          View Bid & Addendum
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

export default BidAddendumEmail
