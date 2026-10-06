import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
import { type WaiverTemplateDraft } from "@/lib/templates/waiver-template";
import {
  waiverPreviewValues,
  renderWaiverText,
  visibleWaiverBlock,
} from "@/lib/templates/waiver-engine";
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
  const resolved = values ?? waiverPreviewValues(draft, sample);
  const inline = (text: string, data = resolved) =>
    text.split(/(\{\{[^{}]+\}\})/g).map((part, index) => {
      const key = part.match(/^\{\{([^{}]+)\}\}$/)?.[1];
      const isSigningDate =
        key === "signed_date" ||
        draft.document?.fields.some(
          (field) => field.key === key && field.source === "signed_date",
        );
      if (isSigningDate)
        return (
          <Text key={index} style={{ fontFamily: "Courier" }}>
            ________________
          </Text>
        );
      return renderWaiverText(part, data, !values);
    });
  const signature = (key: string, role = "claimant") => (
    <View key={key} wrap={false} style={styles.signature}>
      <Text style={styles.line}>
        {role === "claimant" ? "Authorized signature" : `${role} signature`}
      </Text>
      <Text style={styles.line}>Date</Text>
    </View>
  );
  return (
    <Document title={draft.name || "Waiver template"}>
      <Page
        size={draft.document?.pageSize ?? "LETTER"}
        style={[styles.page, { fontSize: draft.document?.fontSize ?? 10 }]}
      >
        <Text style={styles.eyebrow}>
          {values ? "WAIVER & RELEASE" : "WAIVER & RELEASE · TEMPLATE PREVIEW"}
        </Text>
        <Text style={styles.title}>{draft.title || "Untitled waiver"}</Text>
        {draft.document?.mode === "editable"
          ? draft.document.blocks
              .filter(
                (b, index) =>
                  !(
                    index ===
                      draft.document!.blocks.findIndex(
                        (block) => block.kind === "heading",
                      ) &&
                    b.kind === "heading" &&
                    !b.condition &&
                    b.text.trim().replace(/\s+/g, " ").toLowerCase() ===
                      draft.title.trim().replace(/\s+/g, " ").toLowerCase()
                  ),
              )
              .filter((b) => visibleWaiverBlock(b, resolved))
              .map((b) => {
                if (b.kind === "page_break") return <View key={b.id} break />;
                if (b.kind === "signature")
                  return signature(b.id, b.signerRole);
                if (b.kind === "table")
                  return (
                    <View key={b.id} style={{ marginBottom: 16 }}>
                      <View
                        wrap={false}
                        style={{
                          flexDirection: "row",
                          backgroundColor: "#f1f3f2",
                        }}
                      >
                        {b.columns.map((c, i) => (
                          <Text
                            key={i}
                            style={{
                              flex: 1,
                              padding: 7,
                              fontFamily: "Helvetica-Bold",
                            }}
                          >
                            {inline(c)}
                          </Text>
                        ))}
                      </View>
                      {(b.repeat === "covered_items"
                        ? (resolved.covered_items
                            ? (JSON.parse(resolved.covered_items) as Record<
                                string,
                                string
                              >[])
                            : [
                                {
                                  item_number:
                                    resolved.invoice_number ?? "Example",
                                  item_project: resolved.project_name,
                                  item_property: resolved.property_address,
                                  item_amount: resolved.amount,
                                  item_through: resolved.through_date,
                                },
                              ]
                          ).flatMap((item) =>
                            b.rows.map((row) => ({
                              cells: row,
                              data: { ...resolved, ...item },
                            })),
                          )
                        : b.rows.map((row) => ({ cells: row, data: resolved }))
                      ).map(({ cells: row, data }, i) => (
                        <View
                          key={i}
                          wrap={false}
                          style={{
                            flexDirection: "row",
                            borderBottomWidth: 0.5,
                            borderBottomColor: "#d8dedb",
                          }}
                        >
                          {row.map((cell, j) => (
                            <Text key={j} style={{ flex: 1, padding: 7 }}>
                              {inline(cell, data)}
                            </Text>
                          ))}
                        </View>
                      ))}
                    </View>
                  );
                return (
                  <Text
                    key={b.id}
                    style={
                      b.kind === "heading"
                        ? {
                            fontFamily: "Helvetica-Bold",
                            fontSize: (draft.document?.fontSize ?? 10) + 2,
                            marginBottom: 10,
                            marginTop: 8,
                          }
                        : styles.paragraph
                    }
                  >
                    {inline(b.text)}
                  </Text>
                );
              })
          : (draft.body || "Your waiver content will appear here.")
              .split(/\n\s*\n/)
              .map((p, i) => (
                <Text key={i} style={styles.paragraph}>
                  {renderWaiverText(p, resolved, !values)}
                </Text>
              ))}
        {!draft.document?.blocks.some((b) => b.kind === "signature") &&
          signature("default-signature")}
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
