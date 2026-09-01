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

export interface InviteTeamMemberEmailProps {
  orgName?: string | null
  orgLogoUrl?: string | null
  inviterName?: string | null
  inviterEmail?: string | null
  inviteeEmail?: string | null
  inviteLink: string
}

export function InviteTeamMemberEmail({
  orgName,
  orgLogoUrl,
  inviterName,
  inviterEmail,
  inviteeEmail,
  inviteLink,
}: InviteTeamMemberEmailProps) {
  const previewText = `Join ${orgName ?? "Arc"} on Arc`
  const displayOrgName = orgName ?? "Arc"
  const inviterDisplay = inviterName ?? "Arc team"
  const greeting = inviteeEmail ? `Hi ${inviteeEmail.split("@")[0]},` : "Hi,"

  return (
    <EmailLayout
      preview={previewText}
      subtitle="Team Invitation"
      orgName={orgName}
      orgLogoUrl={orgLogoUrl}
    >
      <Text style={eventLabelText}>Team Invitation</Text>
      <Heading style={heading}>Join {displayOrgName}</Heading>
      <Text style={subjectText}>You were invited to collaborate in Arc.</Text>

      <Text style={paragraph}>{greeting}</Text>
      <Text style={paragraph}>
        <strong>{inviterDisplay}</strong>
        {inviterEmail ? (
          <>
            {" "}(
            <Link href={`mailto:${inviterEmail}`} style={link}>
              {inviterEmail}
            </Link>
            )
          </>
        ) : null}{" "}
        invited you to join the <strong>{displayOrgName}</strong> workspace.
      </Text>

      <Section style={metaCard}>
        <Text style={metaRow}>
          <span style={metaLabel}>Organization:</span> <span style={metaValue}>{displayOrgName}</span>
        </Text>
        <Text style={metaRow}>
          <span style={metaLabel}>Invited By:</span> <span style={metaValue}>{inviterDisplay}</span>
        </Text>
        {inviteeEmail ? (
          <Text style={metaRow}>
            <span style={metaLabel}>Invitee:</span> <span style={metaValue}>{inviteeEmail}</span>
          </Text>
        ) : null}
      </Section>

      <Section style={contentCard}>
        <Text style={contentLabel}>Access</Text>
        <Text style={contentText}>
          Open the invite to set your password and access projects, documents, and team workflows.
        </Text>
      </Section>

      <Section style={buttonWrap}>
        <Button style={button} href={inviteLink}>
          Join Team
        </Button>
      </Section>

      <Text style={fallbackText}>
        If the button does not open,{" "}
        <Link href={inviteLink} style={link}>
          open secure link
        </Link>
      </Text>
    </EmailLayout>
  )
}

export default InviteTeamMemberEmail
