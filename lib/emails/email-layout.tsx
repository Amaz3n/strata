import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from "@react-email/components"

import {
  ARC_SITE_URL,
  arcLink,
  brandName,
  container,
  content,
  footer,
  footerText,
  header,
  hr,
  kickerFor,
  logoFallback,
  logoImage,
  main,
} from "./theme"
import type { EmailTone } from "./theme"

export interface EmailLayoutProps {
  /** Inbox preview line. */
  preview: string
  /** Uppercase kicker under the org name — what kind of email this is. */
  subtitle: string
  orgName?: string | null
  orgLogoUrl?: string | null
  /** Appended after "Sent via Arc ·" — why this person is receiving it. */
  footerNote?: React.ReactNode
  /** What the message reports. Colors the kicker; leave unset for routine mail. */
  tone?: EmailTone
  children: React.ReactNode
}

/**
 * The shell every Arc email renders inside: header with the org's mark,
 * body, and the "Sent via Arc" footer. Templates own their body content and
 * nothing else — the chrome lives here so it stays identical across all of them.
 */
export function EmailLayout({
  preview,
  subtitle,
  orgName,
  orgLogoUrl,
  footerNote,
  tone = "notice",
  children,
}: EmailLayoutProps) {
  const displayOrgName = orgName ?? "Arc"

  return (
    <Html>
      <Head />
      <Preview>{preview}</Preview>
      <Body style={main}>
        <Container style={container}>
          <Section style={header}>
            {orgLogoUrl ? (
              <Img src={orgLogoUrl} alt={displayOrgName} width="56" height="56" style={logoImage} />
            ) : (
              <Text style={logoFallback}>{displayOrgName.slice(0, 1).toUpperCase()}</Text>
            )}
            <Text style={brandName}>{displayOrgName}</Text>
            <Text style={kickerFor(tone)}>{subtitle}</Text>
          </Section>

          <Section style={content}>{children}</Section>

          <Hr style={hr} />
          <Section style={footer}>
            <Text style={footerText}>
              Sent via <ArcLink />
              {footerNote ? <> · {footerNote}</> : null}
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  )
}

/**
 * The "Arc" wordmark in the footer, linked to the marketing site. Colored and
 * underlined inline so mail clients that rewrite bare link styling (Outlook,
 * Gmail) still render it against the muted footer text.
 */
export function ArcLink() {
  return (
    <Link href={ARC_SITE_URL} style={arcLink}>
      Arc
    </Link>
  )
}
