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

export interface EstimateExpiryEmailProps {
  recipientName: string | null
  estimateTitle: string
  prospectName?: string | null
  recipientContactName?: string | null
  expiresLabel: string
  /** True once the estimate is already past its valid-until date. */
  expired: boolean
  totalLabel?: string | null
  pipelineLink: string
  orgName?: string | null
  orgLogoUrl?: string | null
}

export function EstimateExpiryEmail({
  recipientName,
  estimateTitle = "Estimate",
  prospectName,
  recipientContactName,
  expiresLabel = "",
  expired = false,
  totalLabel,
  pipelineLink = "#",
  orgName,
  orgLogoUrl,
}: EstimateExpiryEmailProps) {
  const displayOrgName = orgName ?? "Arc"
  const greeting = recipientName ? `Hi ${recipientName},` : "Hi,"
  const eventLabel = expired ? "Estimate Expired Unsigned" : "Estimate Expiring Soon"

  return (
    <EmailLayout
      preview={`${eventLabel}: ${estimateTitle}`}
      subtitle={eventLabel}
      orgName={orgName}
      orgLogoUrl={orgLogoUrl}
    >
      <Text style={eventLabelText}>{eventLabel}</Text>
      <Heading style={heading}>{estimateTitle}</Heading>
      <Text style={subjectText}>{expired ? `Expired ${expiresLabel}` : `Expires ${expiresLabel}`}</Text>

      <Text style={paragraph}>{greeting}</Text>
      <Text style={paragraph}>
        {expired ? (
          <>
            The estimate <strong>{estimateTitle}</strong> passed its validity date without a recipient
            signature. Follow up with the recipient, or revise and re-send with a new date.
          </>
        ) : (
          <>
            The estimate <strong>{estimateTitle}</strong> is still out for review and its validity date is
            approaching. A nudge to the recipient now can keep the decision moving.
          </>
        )}
      </Text>

      <Section style={metaCard}>
        {prospectName ? (
          <Text style={metaRow}>
            <span style={metaLabel}>Prospect:</span> <span style={metaValue}>{prospectName}</span>
          </Text>
        ) : null}
        {recipientContactName ? (
          <Text style={metaRow}>
            <span style={metaLabel}>Recipient:</span> <span style={metaValue}>{recipientContactName}</span>
          </Text>
        ) : null}
        {totalLabel ? (
          <Text style={metaRow}>
            <span style={metaLabel}>Value:</span> <span style={metaValue}>{totalLabel}</span>
          </Text>
        ) : null}
        <Text style={metaRow}>
          <span style={metaLabel}>{expired ? "Expired:" : "Expires:"}</span>{" "}
          <span style={metaValue}>{expiresLabel}</span>
        </Text>
      </Section>

      <Section style={buttonWrap}>
        <Button style={button} href={pipelineLink}>
          Open in Arc
        </Button>
      </Section>

      <Text style={fallbackText}>
        If the button does not open,{" "}
        <Link href={pipelineLink} style={link}>
          open the pipeline
        </Link>
      </Text>
    </EmailLayout>
  )
}

