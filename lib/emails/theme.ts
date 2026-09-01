/**
 * The one place every Arc email gets its look. Templates supply body content;
 * everything structural — shell, header, footer, type scale, brand color —
 * comes from here so 28 outbound emails cannot drift apart again.
 *
 * Values are literal hex, not design tokens: mail clients have no CSS custom
 * properties. `brand` is the sRGB rendering of `--primary` from app/globals.css
 * (light mode), which is the surface every email is read on.
 */

/** Marketing site. The footer wordmark in every email points here. */
export const ARC_SITE_URL = "https://buildonarc.com"

export const palette = {
  brand: "#174BD7",
  brandContrast: "#ffffff",
  page: "#ececea",
  surface: "#ffffff",
  surfaceMuted: "#fafafa",
  border: "#dcdcdc",
  borderSubtle: "#ebebeb",
  borderCard: "#e1e1e1",
  ink: "#111111",
  body: "#2f2f2f",
  bodyMuted: "#424242",
  muted: "#666666",
  label: "#6b6b6b",
  faint: "#777777",
  /* State, not identity. A message carries one of these only when its subject is
     genuinely an exception — a payment that failed, banking details being changed. */
  warning: "#b54708",
  danger: "#b42318",
} as const

export const fontStack =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Ubuntu, Arial, sans-serif'

/* ---------- shell (owned by EmailLayout, not by templates) ---------- */

export const main: React.CSSProperties = {
  backgroundColor: palette.page,
  fontFamily: fontStack,
  margin: "0",
  padding: "32px 0",
}

export const container: React.CSSProperties = {
  backgroundColor: palette.surface,
  margin: "0 auto",
  maxWidth: "620px",
  border: `1px solid ${palette.border}`,
}

export const header: React.CSSProperties = {
  textAlign: "center",
  padding: "36px 40px 22px 40px",
  borderBottom: `1px solid ${palette.borderSubtle}`,
}

export const logoImage: React.CSSProperties = {
  border: "1px solid #d6d6d6",
  backgroundColor: palette.surface,
  display: "block",
  margin: "0 auto",
  padding: "6px",
  width: "56px",
  height: "56px",
  objectFit: "contain",
}

export const logoFallback: React.CSSProperties = {
  margin: "0",
  width: "56px",
  height: "56px",
  display: "block",
  marginLeft: "auto",
  marginRight: "auto",
  textAlign: "center",
  lineHeight: "56px",
  border: "1px solid #d6d6d6",
  backgroundColor: palette.surface,
  color: palette.ink,
  fontWeight: 700,
  fontSize: "18px",
}

export const brandName: React.CSSProperties = {
  margin: "12px 0 0 0",
  color: palette.ink,
  fontSize: "15px",
  fontWeight: 700,
}

export const brandSub: React.CSSProperties = {
  margin: "4px 0 0 0",
  color: palette.label,
  fontSize: "11px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "1px",
}

export const content: React.CSSProperties = {
  padding: "30px 40px 32px 40px",
}

export const hr: React.CSSProperties = {
  border: "none",
  borderTop: `1px solid ${palette.borderSubtle}`,
  margin: "0",
}

export const footer: React.CSSProperties = {
  padding: "18px 40px 22px 40px",
  backgroundColor: palette.surface,
}

export const footerText: React.CSSProperties = {
  margin: "0",
  color: palette.faint,
  fontSize: "12px",
  lineHeight: "1.5",
  textAlign: "center",
}

export const arcLink: React.CSSProperties = {
  color: palette.faint,
  fontWeight: 600,
  textDecorationLine: "underline",
}

/* ---------- body primitives (templates compose these) ---------- */

export const eventLabelText: React.CSSProperties = {
  margin: "0 0 10px 0",
  color: palette.muted,
  fontWeight: 700,
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "1px",
}

export const heading: React.CSSProperties = {
  margin: "0",
  color: palette.ink,
  fontSize: "34px",
  lineHeight: "1.1",
  fontWeight: 700,
  letterSpacing: "-0.9px",
}

export const subjectText: React.CSSProperties = {
  margin: "12px 0 24px 0",
  color: palette.ink,
  fontSize: "18px",
  fontWeight: 600,
  lineHeight: "1.5",
}

export const paragraph: React.CSSProperties = {
  margin: "0 0 12px 0",
  color: palette.body,
  fontSize: "14px",
  lineHeight: "1.6",
}

export const metaCard: React.CSSProperties = {
  marginTop: "16px",
  padding: "14px 16px",
  border: `1px solid ${palette.borderCard}`,
  backgroundColor: palette.surfaceMuted,
}

export const metaRow: React.CSSProperties = {
  margin: "0 0 8px 0",
  color: palette.bodyMuted,
  fontSize: "13px",
  lineHeight: "1.5",
}

export const metaLabel: React.CSSProperties = {
  color: "#6a6a6a",
  fontSize: "12px",
  fontWeight: 700,
  textTransform: "uppercase",
  letterSpacing: "0.6px",
}

export const metaValue: React.CSSProperties = {
  color: palette.ink,
  fontSize: "13px",
  fontWeight: 600,
}

export const contentCard: React.CSSProperties = {
  marginTop: "16px",
  padding: "16px",
  border: `1px solid ${palette.borderCard}`,
  backgroundColor: palette.surface,
}

export const contentLabel: React.CSSProperties = {
  margin: "0 0 8px 0",
  color: "#626262",
  fontWeight: 700,
  fontSize: "11px",
  textTransform: "uppercase",
  letterSpacing: "0.8px",
}

export const contentText: React.CSSProperties = {
  margin: "0",
  color: "#222222",
  fontSize: "14px",
  lineHeight: "1.6",
  whiteSpace: "pre-wrap",
}

export const buttonWrap: React.CSSProperties = {
  textAlign: "center",
  marginTop: "26px",
  marginBottom: "16px",
}

export const button: React.CSSProperties = {
  backgroundColor: palette.brand,
  color: palette.brandContrast,
  border: `1px solid ${palette.brand}`,
  textDecoration: "none",
  fontSize: "14px",
  fontWeight: 700,
  padding: "12px 24px",
  display: "inline-block",
}

export const link: React.CSSProperties = {
  color: palette.brand,
  textDecorationLine: "underline",
}

export const fallbackText: React.CSSProperties = {
  margin: "0",
  color: palette.muted,
  fontSize: "12px",
  lineHeight: "1.65",
  textAlign: "center",
}

/* ---------- tone ---------- */

/**
 * What a message is reporting. `notice` is the default and covers almost
 * everything; the other two exist because a returned payment and a bank-detail
 * change are exceptions a recipient must not mistake for routine mail.
 */
export type EmailTone = "notice" | "warning" | "danger"

const TONE: Record<EmailTone, string> = {
  notice: palette.brand,
  warning: palette.warning,
  danger: palette.danger,
}

/** The primary CTA, colored by what the message is reporting. */
export function buttonFor(tone: EmailTone): React.CSSProperties {
  return { ...button, backgroundColor: TONE[tone], border: `1px solid ${TONE[tone]}` }
}

/** The header kicker. Stays muted for routine mail so the tones mean something. */
export function kickerFor(tone: EmailTone): React.CSSProperties {
  return tone === "notice" ? brandSub : { ...brandSub, color: TONE[tone] }
}
