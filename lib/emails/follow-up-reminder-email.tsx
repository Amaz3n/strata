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

export interface FollowUpReminderEmailProps {
  recipientName: string | null
  prospectName: string
  dueLabel: string
  contactName?: string | null
  contactEmail?: string | null
  contactPhone?: string | null
  jobsite?: string | null
  prospectLink: string
  orgName?: string | null
  orgLogoUrl?: string | null
}

export function FollowUpReminderEmail({
  recipientName,
  prospectName = "Prospect",
  dueLabel = "",
  contactName,
  contactEmail,
  contactPhone,
  jobsite,
  prospectLink = "#",
  orgName,
  orgLogoUrl,
}: FollowUpReminderEmailProps) {
  const displayOrgName = orgName ?? "Arc"
  const greeting = recipientName ? `Hi ${recipientName},` : "Hi,"

  return (
    <EmailLayout
      preview="Follow-up due: {prospectName}"
      subtitle="Follow-up Reminder"
      orgName={orgName}
      orgLogoUrl={orgLogoUrl}
    >
      <Text style={eventLabelText}>Follow-up Due</Text>
      <Heading style={heading}>{prospectName}</Heading>
      <Text style={subjectText}>{dueLabel}</Text>

      <Text style={paragraph}>{greeting}</Text>
      <Text style={paragraph}>
        This is your reminder to follow up on <strong>{prospectName}</strong>. The details are below.
      </Text>

      <Section style={metaCard}>
        {contactName ? (
          <Text style={metaRow}>
            <span style={metaLabel}>Contact:</span> <span style={metaValue}>{contactName}</span>
          </Text>
        ) : null}
        {contactEmail ? (
          <Text style={metaRow}>
            <span style={metaLabel}>Email:</span> <span style={metaValue}>{contactEmail}</span>
          </Text>
        ) : null}
        {contactPhone ? (
          <Text style={metaRow}>
            <span style={metaLabel}>Phone:</span> <span style={metaValue}>{contactPhone}</span>
          </Text>
        ) : null}
        {jobsite ? (
          <Text style={metaRow}>
            <span style={metaLabel}>Jobsite:</span> <span style={metaValue}>{jobsite}</span>
          </Text>
        ) : null}
        <Text style={metaRow}>
          <span style={metaLabel}>Scheduled:</span> <span style={metaValue}>{dueLabel}</span>
        </Text>
      </Section>

      <Section style={buttonWrap}>
        <Button style={button} href={prospectLink}>
          Open in Arc
        </Button>
      </Section>

      <Text style={fallbackText}>
        If the button does not open,{" "}
        <Link href={prospectLink} style={link}>
          open the pipeline
        </Link>
      </Text>
    </EmailLayout>
  )
}

export default FollowUpReminderEmail
