import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components"

export interface ProjectPortalInviteEmailProps {
  recipientName?: string | null
  projectName: string
  portalType: "client" | "sub"
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
  const portalLabel = portalType === "sub" ? "Subcontractor Portal" : "Project Portal"

  return (
    <Html>
      <Head />
      <Preview>{previewText}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={header}>
            {orgLogoUrl ? (
              <Img src={orgLogoUrl} alt={displayOrgName} width="56" height="56" style={logoImage} />
            ) : (
              <Text style={logoFallback}>{displayOrgName.slice(0, 1).toUpperCase()}</Text>
            )}
            <Text style={brandName}>{displayOrgName}</Text>
            <Text style={brandSub}>{portalLabel}</Text>
          </Section>

          <Section style={content}>
            <Text style={eventLabelText}>You have project access</Text>
            <Heading style={heading}>{projectName}</Heading>

            <Text style={paragraph}>{greeting}</Text>
            <Text style={paragraph}>
              <strong>{displayOrgName}</strong> shared this Arc portal with you for <strong>{projectName}</strong>.
            </Text>
            <Text style={paragraph}>
              Open the project below. If this is your first time in Arc, you will be prompted to claim your account
              before entering the portal.
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
              <Text style={contentLabel}>After you sign in</Text>
              <Text style={contentText}>
                Arc will keep this project in your workspace so you can come back to it later from one hub.
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
          </Section>

          <Hr style={hr} />
          <Section style={footer}>
            <Text style={footerText}>Sent via Arc</Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

const main: React.CSSProperties = {
  backgroundColor: "#ececea",
  fontFamily:
    '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Ubuntu, Arial, sans-serif',
  margin: "0",
  padding: "32px 0",
}

const container: React.CSSProperties = {
  backgroundColor: "#ffffff",
  margin: "0 auto",
  maxWidth: "620px",
  border: "1px solid #dcdcdc",
}

const header: React.CSSProperties = {
  textAlign: "center",
  padding: "36px 40px 22px 40px",
  borderBottom: "1px solid #ebebeb",
}

const logoImage: React.CSSProperties = {
  border: "1px solid #d6d6d6",
  backgroundColor: "#ffffff",
  display: "block",
  margin: "0 auto",
  padding: "6px",
}

const logoFallback: React.CSSProperties = {
  margin: "0",
  width: "56px",
  height: "56px",
  display: "block",
  marginLeft: "auto",
  marginRight: "auto",
  textAlign: "center",
  lineHeight: "56px",
  border: "1px solid #d6d6d6",
  backgroundColor: "#fff",
  color: "#111111",
  fontWeight: 700,
  fontSize: "18px",
}

const brandName: React.CSSProperties = {
  margin: "12px 0 0 0",
  color: "#111111",
  fontSize: "15px",
  fontWeight: 700,
}

const brandSub: React.CSSProperties = {
  margin: "4px 0 0 0",
  color: "#6b6b6b",
  fontSize: "11px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "1px",
}

const content: React.CSSProperties = {
  padding: "30px 40px 32px 40px",
}

const eventLabelText: React.CSSProperties = {
  margin: "0 0 10px 0",
  color: "#666666",
  fontWeight: 700,
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "1px",
}

const heading: React.CSSProperties = {
  margin: "0 0 20px 0",
  color: "#111111",
  fontSize: "34px",
  lineHeight: "1.1",
  fontWeight: 700,
  letterSpacing: "-0.9px",
}

const paragraph: React.CSSProperties = {
  color: "#2f2f2f",
  fontSize: "14px",
  lineHeight: "1.6",
  margin: "0 0 14px 0",
}

const metaCard: React.CSSProperties = {
  border: "1px solid #e8e8e8",
  padding: "18px 20px",
  margin: "24px 0 18px 0",
  backgroundColor: "#fbfbfb",
}

const metaRow: React.CSSProperties = {
  margin: "0 0 8px 0",
  color: "#222222",
  fontSize: "13px",
  lineHeight: "1.5",
}

const metaLabel: React.CSSProperties = {
  display: "inline-block",
  minWidth: "72px",
  color: "#6d6d6d",
  fontWeight: 600,
}

const metaValue: React.CSSProperties = {
  color: "#111111",
}

const contentCard: React.CSSProperties = {
  border: "1px solid #ececec",
  backgroundColor: "#fafafa",
  padding: "18px 20px",
  margin: "0 0 24px 0",
}

const contentLabel: React.CSSProperties = {
  margin: "0 0 6px 0",
  color: "#111111",
  fontSize: "12px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.8px",
}

const contentText: React.CSSProperties = {
  margin: "0",
  color: "#2f2f2f",
  fontSize: "14px",
  lineHeight: "1.6",
}

const buttonWrap: React.CSSProperties = {
  textAlign: "left",
  margin: "0 0 20px 0",
}

const button: React.CSSProperties = {
  backgroundColor: "#111111",
  color: "#ffffff",
  padding: "12px 18px",
  textDecoration: "none",
  fontWeight: 600,
  fontSize: "14px",
}

const fallbackText: React.CSSProperties = {
  margin: "0",
  color: "#666666",
  fontSize: "13px",
  lineHeight: "1.6",
}

const link: React.CSSProperties = {
  color: "#111111",
  textDecoration: "underline",
}

const hr: React.CSSProperties = {
  borderColor: "#ebebeb",
  margin: "0",
}

const footer: React.CSSProperties = {
  padding: "18px 40px 24px 40px",
}

const footerText: React.CSSProperties = {
  margin: "0",
  color: "#8a8a8a",
  fontSize: "12px",
}
