/** Client-safe document identity. PDF uses points; the live canvas uses 96dpi pixels. */
export const documentTheme = {
  colors: { bg: "#FFFFFF", text: "#111111", muted: "#6B7280", line: "#E5E7EB", soft: "#F3F4F6" },
  page: { paddingTop: 44, paddingBottom: 40, paddingHorizontal: 48, fontFamily: "Helvetica", fontSize: 10 },
  title: { fontSize: 22, fontWeight: "bold" as const, letterSpacing: -0.2 },
  label: { fontSize: 9.5, color: "#6B7280" },
  row: { paddingVertical: 9, borderBottomWidth: 1, borderBottomColor: "#E5E7EB" },
  totalsWidth: 240,
} as const

export const documentCanvasStyle = {
  paddingTop: documentTheme.page.paddingTop * 4 / 3,
  paddingBottom: documentTheme.page.paddingBottom * 4 / 3,
  paddingLeft: documentTheme.page.paddingHorizontal * 4 / 3,
  paddingRight: documentTheme.page.paddingHorizontal * 4 / 3,
  fontSize: documentTheme.page.fontSize * 4 / 3,
  fontFamily: 'Arial, Helvetica, sans-serif',
  color: documentTheme.colors.text,
  backgroundColor: documentTheme.colors.bg,
}
