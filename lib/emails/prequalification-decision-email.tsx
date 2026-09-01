import { Heading, Section, Text } from "@react-email/components"

import { EmailLayout } from "./email-layout"
import {
  contentCard,
  contentLabel,
  contentText,
  eventLabelText,
  fallbackText,
  heading,
  metaCard,
  metaLabel,
  metaRow,
  metaValue,
  paragraph,
} from "./theme"

export interface PrequalificationDecisionEmailProps {
  recipientName?: string | null
  companyName: string
  orgName?: string | null
  orgLogoUrl?: string | null
  decision: "approved" | "approved_with_limits" | "declined"
  expiresAt?: string | null
  singleProjectLimit?: string | null
  aggregateLimit?: string | null
  reviewNotes?: string | null
}

export function PrequalificationDecisionEmail({
  recipientName,
  companyName,
  orgName,
  orgLogoUrl,
  decision,
  expiresAt,
  singleProjectLimit,
  aggregateLimit,
  reviewNotes,
}: PrequalificationDecisionEmailProps) {
  const displayOrgName = orgName ?? "Arc"
  const greeting = recipientName ? `Hi ${recipientName},` : "Hi,"
  const declined = decision === "declined"
  const title = declined ? "Prequalification not approved" : "You are prequalified"

  return (
    <EmailLayout
      preview={`${displayOrgName}: ${title.toLowerCase()}`}
      subtitle="Subcontractor Prequalification"
      orgName={orgName}
      orgLogoUrl={orgLogoUrl}
    >
      <Text style={eventLabelText}>Decision</Text>
      <Heading style={heading}>{title}</Heading>

      <Text style={paragraph}>{greeting}</Text>
      <Text style={paragraph}>
        {declined ? (
          <>
            <strong>{displayOrgName}</strong> has reviewed the prequalification for{" "}
            <strong>{companyName}</strong> and is not able to approve it at this time.
          </>
        ) : (
          <>
            <strong>{displayOrgName}</strong> has approved the prequalification for{" "}
            <strong>{companyName}</strong>.
          </>
        )}
      </Text>

      {!declined && (expiresAt || singleProjectLimit || aggregateLimit) ? (
        <Section style={metaCard}>
          {expiresAt ? (
            <Text style={metaRow}>
              <span style={metaLabel}>Valid until:</span>{" "}
              <span style={metaValue}>{expiresAt}</span>
            </Text>
          ) : null}
          {singleProjectLimit ? (
            <Text style={metaRow}>
              <span style={metaLabel}>Per project:</span>{" "}
              <span style={metaValue}>{singleProjectLimit}</span>
            </Text>
          ) : null}
          {aggregateLimit ? (
            <Text style={metaRow}>
              <span style={metaLabel}>Total at once:</span>{" "}
              <span style={metaValue}>{aggregateLimit}</span>
            </Text>
          ) : null}
        </Section>
      ) : null}

      {reviewNotes ? (
        <Section style={contentCard}>
          <Text style={contentLabel}>Notes from {displayOrgName}</Text>
          <Text style={contentText}>{reviewNotes}</Text>
        </Section>
      ) : null}

      <Text style={fallbackText}>
        Questions about this decision are best sent straight to your contact at{" "}
        {displayOrgName}.
      </Text>
    </EmailLayout>
  )
}

