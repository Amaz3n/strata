import SwiftUI

extension MobileWorkspaceField {
    func accepts(_ text: String) -> Bool {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if kind == "rows" {
            guard trimmed.count <= 10000 else { return false }
            if trimmed.isEmpty { return required != true }
            guard let data = trimmed.data(using: .utf8), let rows = try? JSONDecoder().decode([[String: String]].self, from: data), rows.count <= 100 else { return false }
            if required == true && rows.isEmpty { return false }
            return rows.allSatisfy { row in (fields ?? []).allSatisfy { $0.accepts(row[$0.key] ?? "") } }
        }
        if trimmed.isEmpty { return required != true }
        if let options { return options.contains(trimmed) }
        if kind == "number" || kind == "money" { return NativeInvoiceLineDraft.number(trimmed) != nil }
        return true
    }
}

struct NativeWorkspaceRowsEditor: View {
    private struct Row: Identifiable, Equatable {
        let id = UUID()
        var values: [String: String]
    }
    let field: MobileWorkspaceField
    @Binding var value: String
    @State private var rows: [Row]
    private var columns: [MobileWorkspaceField] { field.fields ?? [] }

    init(field: MobileWorkspaceField, value: Binding<String>) {
        self.field = field
        _value = value
        let decoded = (try? JSONDecoder().decode([[String: String]].self, from: Data(value.wrappedValue.utf8))) ?? []
        _rows = State(initialValue: decoded.map { Row(values: $0) })
    }

    var body: some View {
        ForEach($rows) { $row in
            VStack(alignment: .leading, spacing: 12) {
                ForEach(columns) { column in
                    if let options = column.options {
                        Picker(column.label, selection: Binding(get: { row.values[column.key] ?? options.first ?? "" }, set: { row.values[column.key] = $0 })) {
                            ForEach(options, id: \.self) { option in
                                Text(column.optionLabels?[option] ?? option.replacingOccurrences(of: "_", with: " ").capitalized).tag(option)
                            }
                        }
                    } else {
                        TextField(column.label, text: Binding(get: { row.values[column.key] ?? "" }, set: { row.values[column.key] = $0 }), axis: column.kind == "multiline" ? .vertical : .horizontal)
                            .keyboardType(column.kind == "number" || column.kind == "money" ? .decimalPad : column.key == "email" ? .emailAddress : .default)
                            .textInputAutocapitalization(column.key == "email" ? .never : .sentences)
                            .accessibilityLabel(column.label)
                    }
                }
                Button("Remove Item", role: .destructive) { rows.removeAll { $0.id == row.id } }
            }.padding(.vertical, 8)
        }
        Button("Add Item", systemImage: "plus") {
            var defaults: [String: String] = [:]
            for column in columns {
                if let value = column.value { defaults[column.key] = value }
                else if let option = column.options?.first { defaults[column.key] = option }
            }
            rows.append(Row(values: defaults))
        }.disabled(rows.count >= 100)
        .onChange(of: rows) { _, _ in
            if let data = try? JSONEncoder().encode(rows.map(\.values)) { value = String(decoding: data, as: UTF8.self) }
        }
    }
}
