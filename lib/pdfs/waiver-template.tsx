import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import {
  fillTemplate,
  type WaiverTemplateDraft,
} from "@/lib/templates/waiver-template";
const styles = StyleSheet.create({
  page: {
    padding: 52,
    fontFamily: "Helvetica",
    fontSize: 10,
    lineHeight: 1.65,
    color: "#202522",
  },
  eyebrow: {
    fontSize: 8,
    letterSpacing: 2,
    color: "#737b76",
    marginBottom: 20,
  },
  title: {
    fontSize: 21,
    lineHeight: 1.2,
    marginBottom: 25,
    fontFamily: "Helvetica-Bold",
  },
  paragraph: { marginBottom: 12 },
  signature: { marginTop: 38, flexDirection: "row", gap: 30 },
  line: {
    borderTopWidth: 0.7,
    borderTopColor: "#8b918c",
    paddingTop: 7,
    flex: 1,
    fontSize: 8,
    color: "#626963",
  },
  footer: {
    position: "absolute",
    bottom: 25,
    left: 52,
    right: 52,
    fontSize: 7,
    color: "#8b918c",
    flexDirection: "row",
    justifyContent: "space-between",
  },
});
export function WaiverTemplateDocument({
  draft,
  sample = false,
  values,
  invoiceNumber,
}: {
  draft: WaiverTemplateDraft;
  sample?: boolean;
  values?: Record<string, string>;
  invoiceNumber?: string;
}) {
  return (
    <Document title={draft.name || "Waiver template"}>
      <Page size="LETTER" style={styles.page}>
        <Text style={styles.eyebrow}>
          {values ? "WAIVER & RELEASE" : "WAIVER & RELEASE · TEMPLATE PREVIEW"}
        </Text>
        <Text style={styles.title}>{draft.title || "Untitled waiver"}</Text>
        {(draft.body || "Your waiver content will appear here.")
          .split(/\n\s*\n/)
          .map((p, i) => (
            <Text key={i} style={styles.paragraph}>
              {values
                ? p.replace(
                    /\{\{([^{}]+)\}\}/g,
                    (_, key: string) => values[key] ?? `[${key}]`,
                  )
                : fillTemplate(p, sample)}
            </Text>
          ))}
        <View wrap={false} style={styles.signature}>
          <Text style={styles.line}>Authorized signature</Text>
          <Text style={styles.line}>Date</Text>
        </View>
        <View fixed style={styles.footer}>
          <Text>
            {values
              ? `Invoice ${invoiceNumber ?? ""}`
              : sample
                ? "Example project · Not for signature"
                : "Template preview · Not for signature"}
          </Text>
          <Text
            render={({ pageNumber, totalPages }) =>
              `${pageNumber} / ${totalPages}`
            }
          />
        </View>
      </Page>
    </Document>
  );
}
