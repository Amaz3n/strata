import { Document, Page, Text, View, StyleSheet } from "@react-pdf/renderer";
export type PresetPreviewData = {
  kind: string;
  name: string;
  description?: string;
  rows: Array<{
    label: string;
    detail?: string;
    value?: string;
    heading?: boolean;
  }>;
  total?: string;
};
const s = StyleSheet.create({
  page: {
    padding: 45,
    fontFamily: "Helvetica",
    fontSize: 9,
    color: "#202522",
    lineHeight: 1.5,
  },
  eyebrow: {
    fontSize: 8,
    letterSpacing: 2,
    color: "#737b76",
    marginBottom: 18,
  },
  title: {
    fontFamily: "Helvetica-Bold",
    fontSize: 23,
    lineHeight: 1.2,
    marginBottom: 12,
  },
  description: { color: "#626963", marginBottom: 26 },
  row: {
    flexDirection: "row",
    borderBottomWidth: 0.5,
    borderBottomColor: "#dedfdd",
    paddingVertical: 11,
    gap: 12,
  },
  label: { flex: 1 },
  detail: { fontSize: 8, color: "#737b76", marginTop: 3 },
  value: { width: 105, textAlign: "right" },
  heading: {
    fontFamily: "Helvetica-Bold",
    fontSize: 10,
    marginTop: 18,
    marginBottom: 4,
  },
  total: {
    marginTop: 18,
    textAlign: "right",
    fontFamily: "Helvetica-Bold",
    fontSize: 12,
  },
  footer: {
    position: "absolute",
    bottom: 23,
    left: 45,
    right: 45,
    fontSize: 7,
    color: "#737b76",
    flexDirection: "row",
    justifyContent: "space-between",
  },
});
export function PresetTemplateDocument({ data }: { data: PresetPreviewData }) {
  return (
    <Document title={data.name || `${data.kind} template`}>
      <Page size="LETTER" style={s.page}>
        <Text style={s.eyebrow}>{data.kind.toUpperCase()} TEMPLATE</Text>
        <Text style={s.title}>{data.name || "Untitled template"}</Text>
        <Text style={s.description}>
          {data.description || "Reusable starting point for your next project."}
        </Text>
        {data.rows.length ? (
          data.rows.map((row, i) =>
            row.heading ? (
              <Text key={i} style={s.heading}>
                {row.label}
              </Text>
            ) : (
              <View wrap={false} key={i} style={s.row}>
                <View style={s.label}>
                  <Text>{row.label}</Text>
                  {row.detail && <Text style={s.detail}>{row.detail}</Text>}
                </View>
                {row.value && <Text style={s.value}>{row.value}</Text>}
              </View>
            ),
          )
        ) : (
          <Text style={s.description}>Add your first item to see it here.</Text>
        )}
        {data.total && <Text style={s.total}>{data.total}</Text>}
        <View fixed style={s.footer}>
          <Text>Template preview</Text>
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
