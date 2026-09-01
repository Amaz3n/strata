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
} from "./theme"

export interface ProjectPortalInviteEmailProps {
  recipientName?: string | null
  projectName: string
  portalType: "client" | "sub" | "reviewer"
  orgName?: string | null
  orgLogoUrl?: string | null
  portalLink: string
}

export function ProjectPortalInviteEmail({
  recipientName,
  projectName,
  portalType,
  orgName,
  orgLogoUrl,
  portalLink,
}: ProjectPortalInviteEmailProps) {
  const previewText = `Open ${projectName} in Arc`
  const displayOrgName = orgName ?? "Arc"
  const greeting = recipientName ? `Hi ${recipientName},` : "Hi,"
  const portalLabel =
    portalType === "sub" ? "Subcontractor Portal" : portalType === "reviewer" ? "Design Review Portal" : "Project Portal"

  return (
    <EmailLayout
      preview={previewText}
      subtitle={portalLabel}
      orgName={orgName}
      orgLogoUrl={orgLogoUrl}
    >
      <Text style={eventLabelText}>You have project access</Text>
      <Heading style={heading}>{projectName}</Heading>

      <Text style={paragraph}>{greeting}</Text>
      <Text style={paragraph}>
        <strong>{displayOrgName}</strong> shared this Arc portal with you for <strong>{projectName}</strong>.
      </Text>
      <Text style={paragraph}>
        Open the project below from this secure email link. If you want one place to find every shared project later,
        you can claim your Arc account from inside the portal.
      </Text>

      <Section style={metaCard}>
        <Text style={metaRow}>
          <span style={metaLabel}>Builder:</span> <span style={metaValue}>{displayOrgName}</span>
        </Text>
        <Text style={metaRow}>
          <span style={metaLabel}>Project:</span> <span style={metaValue}>{projectName}</span>
        </Text>
        <Text style={metaRow}>
          <span style={metaLabel}>Portal:</span> <span style={metaValue}>{portalLabel}</span>
        </Text>
      </Section>

      <Section style={contentCard}>
        <Text style={contentLabel}>Optional account access</Text>
        <Text style={contentText}>
          Claiming an account keeps this project in your workspace so you can come back to it later from one hub.
        </Text>
      </Section>

      <Section style={buttonWrap}>
        <Button style={button} href={portalLink}>
          Open Project in Arc
        </Button>
      </Section>

      <Text style={fallbackText}>
        If the button does not open,{" "}
        <Link href={portalLink} style={link}>
          open secure project link
        </Link>
      </Text>
    </EmailLayout>
  )
}

