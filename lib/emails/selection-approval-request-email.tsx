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

export interface SelectionApprovalRequestEmailProps {
  orgName?: string | null
  orgLogoUrl?: string | null
  recipientName?: string | null
  homeName?: string | null
  groupName: string
  /** Formatted at the edge: "$6,500". */
  totalText: string
  lineCount: number
  /** "Jul 1, 2026" at the house, or null when the request does not expire. */
  respondByText?: string | null
  actionHref: string
}

/** The buyer is asked to approve a set of selections in the buyer portal. */
export function SelectionApprovalRequestEmail({
  orgName,
  orgLogoUrl,
  recipientName,
  homeName,
  groupName,
  totalText,
  lineCount,
  respondByText,
  actionHref,
}: SelectionApprovalRequestEmailProps) {
  return (
    <EmailLayout preview={`Please approve your ${groupName} selections`} subtitle="Selections" orgName={orgName} orgLogoUrl={orgLogoUrl}>
      <Text style={eventLabelText}>Approval Requested</Text>
      <Heading style={heading}>{groupName}</Heading>
      <Text style={subjectText}>{homeName ?? "Your new home"}</Text>

      <Text style={paragraph}>{recipientName ? `Hi ${recipientName},` : "Hi,"}</Text>
      <Text style={paragraph}>
        Your {groupName.toLowerCase()} selections are ready for your approval. Review each choice and its price, then approve them or tell us what to change.
      </Text>

      <Section style={metaCard}>
        <Text style={metaRow}>
          <span style={metaLabel}>Selections:</span> <span style={metaValue}>{lineCount}</span>
        </Text>
        <Text style={metaRow}>
          <span style={metaLabel}>Total:</span> <span style={metaValue}>{totalText}</span>
        </Text>
        {respondByText ? (
          <Text style={metaRow}>
            <span style={metaLabel}>Please respond by:</span> <span style={metaValue}>{respondByText}</span>
          </Text>
        ) : null}
      </Section>

      <Section style={buttonWrap}>
        <Button style={button} href={actionHref}>
          Review and approve
        </Button>
      </Section>
      <Text style={fallbackText}>
        If the button does not open,{" "}
        <Link href={actionHref} style={link}>
          open secure link
        </Link>
      </Text>
    </EmailLayout>
  )
}

export default SelectionApprovalRequestEmail
