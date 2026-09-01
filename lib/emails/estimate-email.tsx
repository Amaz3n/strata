import { Button, Heading, Link, Section, Text } from "@react-email/components"

import { EmailLayout } from "./email-layout"
import {
  button,
  buttonWrap,
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

export interface EstimateEmailProps {
  estimateTitle: string
  reviewLink: string
  orgName?: string | null
  orgLogoUrl?: string | null
  recipientName?: string | null
  projectName?: string | null
  totalLabel?: string | null
  validUntil?: string | null
  message?: string | null
  previewText?: string
}

export function EstimateEmail({
  estimateTitle = "Estimate",
  reviewLink = "#",
  orgName,
  orgLogoUrl,
  recipientName,
  projectName,
  totalLabel,
  validUntil,
  message,
  previewText,
}: EstimateEmailProps) {
  const displayOrgName = orgName ?? "Arc"
  const greeting = recipientName?.trim() ? `Hi ${recipientName.trim()},` : "Hello,"
  const resolvedPreview = previewText ?? `${displayOrgName} sent you an estimate: ${estimateTitle}`

  return (
    <EmailLayout
      preview={resolvedPreview}
      subtitle="Estimate for review"
      orgName={orgName}
      orgLogoUrl={orgLogoUrl}
    >
      <Text style={eventLabelText}>Estimate</Text>
      <Heading style={heading}>Your estimate is ready</Heading>
      <Text style={subjectText}>{estimateTitle}</Text>

      <Text style={paragraph}>{greeting}</Text>
      <Text style={paragraph}>
        {message?.trim() ? (
          message
        ) : (
          <>
            <strong>{displayOrgName}</strong> has prepared an estimate for you. Review the full
            breakdown online, then approve it, reject it, or request changes — right from the page.
          </>
        )}
      </Text>

      <Section style={metaCard}>
        <Text style={metaRow}>
          <span style={metaLabel}>Estimate:</span> <span style={metaValue}>{estimateTitle}</span>
        </Text>
        {projectName ? (
          <Text style={metaRow}>
            <span style={metaLabel}>Project:</span> <span style={metaValue}>{projectName}</span>
          </Text>
        ) : null}
        {totalLabel ? (
          <Text style={metaRow}>
            <span style={metaLabel}>Total:</span> <span style={metaValue}>{totalLabel}</span>
          </Text>
        ) : null}
        <Text style={metaRowLast}>
          <span style={metaLabel}>{validUntil ? "Valid until:" : "From:"}</span>{" "}
          <span style={metaValue}>{validUntil ?? displayOrgName}</span>
        </Text>
      </Section>

      <Section style={buttonWrap}>
        <Button style={button} href={reviewLink}>
          Review estimate
        </Button>
      </Section>

      <Text style={fallbackText}>
        If the button does not open,{" "}
        <Link href={reviewLink} style={link}>
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

export default EstimateEmail
