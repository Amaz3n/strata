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
  metaRow,
  paragraph,
} from "./theme"

export interface PrequalificationRequestEmailProps {
  recipientName?: string | null
  companyName: string
  orgName?: string | null
  orgLogoUrl?: string | null
  portalLink: string
  /** What the program asks for, already worded for a reader. */
  askedFor: string[]
  message?: string | null
}

export function PrequalificationRequestEmail({
  recipientName,
  companyName,
  orgName,
  orgLogoUrl,
  portalLink,
  askedFor,
  message,
}: PrequalificationRequestEmailProps) {
  const displayOrgName = orgName ?? "Arc"
  const greeting = recipientName ? `Hi ${recipientName},` : "Hi,"

  return (
    <EmailLayout
      preview={`${displayOrgName} is asking ${companyName} to prequalify`}
      subtitle="Subcontractor Prequalification"
      orgName={orgName}
      orgLogoUrl={orgLogoUrl}
    >
      <Text style={eventLabelText}>Action needed</Text>
      <Heading style={heading}>Prequalify {companyName}</Heading>

      <Text style={paragraph}>{greeting}</Text>
      <Text style={paragraph}>
        <strong>{displayOrgName}</strong> would like to prequalify <strong>{companyName}</strong>{" "}
        before awarding work. You can complete everything from the secure link below — your
        answers save as you go.
      </Text>

      {message ? (
        <Section style={contentCard}>
          <Text style={contentLabel}>From {displayOrgName}</Text>
          <Text style={contentText}>{message}</Text>
        </Section>
      ) : null}

      {askedFor.length > 0 ? (
        <Section style={metaCard}>
          <Text style={contentLabel}>What we need</Text>
          {askedFor.map((item) => (
            <Text key={item} style={metaRow}>
              • {item}
            </Text>
          ))}
        </Section>
      ) : null}

      <Section style={buttonWrap}>
        <Button style={button} href={portalLink}>
          Start Prequalification
        </Button>
      </Section>

      <Text style={fallbackText}>
        If the button does not open,{" "}
        <Link href={portalLink} style={link}>
          open your secure link
        </Link>
      </Text>
    </EmailLayout>
  )
}

