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

export interface SignatureEmailProps {
  documentTitle: string
  signingLink: string
  orgName?: string | null
  orgLogoUrl?: string | null
  recipientName?: string | null
  projectName?: string | null
  eventLabel?: string
  headline?: string
  bodyText?: string
  detailLabel?: string
  detailText?: string
  buttonText?: string
  previewText?: string
}

export function SignatureEmail({
  documentTitle = "Document",
  signingLink = "#",
  orgName,
  orgLogoUrl,
  recipientName,
  projectName,
  eventLabel = "Signature Request",
  headline = "Document ready for signature",
  bodyText,
  detailLabel = "Signature",
  detailText = "Open the document to review all pages, complete required fields, and sign electronically.",
  buttonText = "Review and Sign",
  previewText,
}: SignatureEmailProps) {
  const displayOrgName = orgName ?? "Arc"
  const greeting = recipientName?.trim() ? `Hi ${recipientName.trim()},` : "Hello,"
  const resolvedPreview = previewText ?? `${eventLabel}: ${documentTitle}`

  return (
    <EmailLayout
      preview={resolvedPreview}
      subtitle="Signature Notification"
      orgName={orgName}
      orgLogoUrl={orgLogoUrl}
    >
      <Text style={eventLabelText}>{eventLabel}</Text>
      <Heading style={heading}>{headline}</Heading>
      <Text style={subjectText}>{documentTitle}</Text>

      <Text style={paragraph}>{greeting}</Text>
      <Text style={paragraph}>
        {bodyText ?? (
          <>
            You received a document from <strong>{displayOrgName}</strong> that needs your signature.
          </>
        )}
      </Text>

      <Section style={metaCard}>
        <Text style={metaRow}>
          <span style={metaLabel}>Document:</span> <span style={metaValue}>{documentTitle}</span>
        </Text>
        {projectName ? (
          <Text style={metaRow}>
            <span style={metaLabel}>Project:</span> <span style={metaValue}>{projectName}</span>
          </Text>
        ) : null}
        <Text style={metaRowLast}>
          <span style={metaLabel}>From:</span> <span style={metaValue}>{displayOrgName}</span>
        </Text>
      </Section>

      <Section style={contentCard}>
        <Text style={contentLabel}>{detailLabel}</Text>
        <Text style={contentText}>{detailText}</Text>
      </Section>

      <Section style={buttonWrap}>
        <Button style={button} href={signingLink}>
          {buttonText}
        </Button>
      </Section>

      <Text style={fallbackText}>
        If the button does not open,{" "}
        <Link href={signingLink} style={link}>
          open secure link
        </Link>
      </Text>
    </EmailLayout>
  )
}

const metaRowLast: React.CSSProperties = {
  ...metaRow,
  margin: "0",
}

export default SignatureEmail
