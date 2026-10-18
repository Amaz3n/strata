import Foundation
import Testing
@testable import Arc

@MainActor
struct AppRouterTests {
    @Test
    func resetClearsNavigationAndPresentation() {
        let router = AppRouter()
        router.navigate(to: .schedule)
        router.presentedSheet = .account

        router.reset()

        #expect(router.path.isEmpty)
        #expect(router.presentedSheet == nil)
    }

    @Test
    func tabsKeepIndependentNavigationPaths() {
        let tabs = TabRouter()
        tabs.router(for: .overview).navigate(to: .schedule)

        #expect(tabs.router(for: .overview).path.count == 1)
        #expect(tabs.router(for: .library).path.isEmpty)
    }
    @Test
    func tabletReferenceHistoryDoesNotChangePhoneTabs() {
        let routers = TabRouter()
        routers.router(for: .drawings).navigate(to: .drawingSheet(id: "sheet-1"))
        routers.router(for: .contacts).navigate(to: .projectDetails)
        #expect(routers.router(for: .drawings).path == [.drawingSheet(id: "sheet-1")])
        #expect(routers.router(for: .library).path.isEmpty)
        #expect(AppTab.phoneTabs == [.overview, .logs, .work, .library])
    }

    @Test
    func fieldReferencesRemainIsolatedAcrossUsersAndOrganizations() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let first = FieldReferenceCache(userID: "alice", organizationID: "org-a", root: directory)
        let otherUser = FieldReferenceCache(userID: "bob", organizationID: "org-a", root: directory)
        let otherOrg = FieldReferenceCache(userID: "alice", organizationID: "org-b", root: directory)
        try first.write(["sheet-1"], key: "drawings/project-1")
        let reopened = FieldReferenceCache(userID: "alice", organizationID: "org-a", root: directory)
        #expect(reopened.read([String].self, key: "drawings/project-1") == ["sheet-1"])
        #expect(otherUser.read([String].self, key: "drawings/project-1") == nil)
        #expect(otherOrg.read([String].self, key: "drawings/project-1") == nil)
        #expect(first.read([String].self, key: "drawings/project-2") == nil)
    }

    @Test
    func corruptReferenceDoesNotPreventOpeningTheLibrary() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = FieldReferenceCache(userID: "alice", organizationID: "org-a", root: directory)
        try cache.write(["sheet-1"], key: "drawings")
        try Data("broken json".utf8).write(to: cache.url(key: "drawings"))
        #expect(cache.read([String].self, key: "drawings") == nil)
    }

    @Test
    func nativeWorkspaceDecodesEditableFieldsAndTemplateLabels() throws {
        let data = Data(#"{"id":"inspections","title":"Inspections","group":"Build","symbol":"checkmark.seal","create_fields":[{"key":"template_id","label":"Checklist","kind":"choice","options":["template-1"],"option_labels":{"template-1":"Roof quality"},"required":true}],"edit_fields":[{"key":"title","label":"Title","kind":"text","required":true}]}"#.utf8)
        let module = try JSONDecoder.arc.decode(MobileWorkspaceModule.self, from: data)
        #expect(module.createFields.first?.optionLabels?["template-1"] == "Roof quality")
        #expect(module.editFields?.first?.key == "title")
    }

    @Test
    func nativeDetailPreservesApprovalRevisionAndChecklistActions() throws {
        let data = Data(#"{"record":{"id":"bill-1","title":"Invoice 42","status":"pending","fields":[]},"sections":[],"actions":[{"id":"approve-bill","title":"Approve Bill","fields":[],"revision":"2026-10-01T12:00:00Z"}]}"#.utf8)
        let detail = try JSONDecoder.arc.decode(MobileWorkspaceDetail.self, from: data)
        #expect(detail.actions.first?.revision == "2026-10-01T12:00:00Z")
        #expect(detail.actions.first?.fields.isEmpty == true)
    }

    @Test
    func invoiceLineValidationRejectsInvalidMoneyAndCalculatesRoundedAmounts() {
        var line = NativeInvoiceLineDraft()
        line.description = "Site visit"
        line.quantity = "1.5"
        line.unitPrice = "125"
        #expect(line.subtotalCents == 18_750)
        for value in ["", "nan", "infinity", "-1", "1.001", "12abc"] {
            line.unitPrice = value
            #expect(line.input == nil)
        }
        line.unitPrice = "25"
        line.quantity = "0"
        #expect(line.input == nil)
    }

    @Test
    func invoiceDraftEncodingNeverCarriesIssuanceIntent() throws {
        let input = NativeInvoiceInput(projectId: "project-a", invoiceNumber: "INV-42", title: "Progress billing", issueDate: "2026-10-01", dueDate: "2026-10-31", notes: "", taxRate: 0, lines: [.init(description: "Work", quantity: 2, unit: "hour", unitCost: 125, taxable: false)])
        let payload = try JSONSerialization.jsonObject(with: JSONEncoder.arc.encode(input)) as? [String: Any]
        #expect(payload?["project_id"] as? String == "project-a")
        #expect(payload?["issue"] == nil)
        let lines = payload?["lines"] as? [[String: Any]]
        #expect(lines?.first?["unit_cost"] as? Double == 125)
    }

}

@MainActor
struct FieldCompletionTests {
    @Test
    func projectDownloadPreservesNestedFolderNavigation() {
        func file(_ id: String, _ folder: String?) -> MobileFile {
            MobileFile(id: id, fileName: "\(id).pdf", folderPath: folder, category: nil, mimeType: "application/pdf", sizeBytes: 1, downloadUrl: nil, isImage: false, updatedAt: .now)
        }
        let files = [file("root", nil), file("permit", "Permits"), file("plan", "/Plans/Architecture/"), file("spec", "/Plans/Specs"), file("other", "/Plans2")]
        #expect(MobileFiles.folderPaths(in: files) == ["/", "/Permits", "/Plans", "/Plans/Architecture", "/Plans/Specs", "/Plans2"])
        let root = MobileFiles.contents(of: "/", in: files)
        #expect(root.files.map(\.id) == ["root"])
        #expect(root.folders.first(where: { $0.path == "/Plans" })?.fileCount == 2)
        let plans = MobileFiles.contents(of: "/Plans", in: files)
        #expect(plans.files.isEmpty)
        #expect(plans.folders.map(\.path) == ["/Plans/Architecture", "/Plans/Specs"])
        #expect(MobileFiles.contents(of: "/Plans/Architecture", in: files).files.map(\.id) == ["plan"])
    }

    @Test
    func phoneToolsExcludeOfficeAdministration() {
        #expect(ProjectFieldToolsView.moduleIDs.contains("inspections"))
        #expect(ProjectFieldToolsView.moduleIDs.contains("time"))
        #expect(ProjectFieldToolsView.moduleIDs.isDisjoint(with: ["banking", "billing", "signatures", "ledger", "pipeline"]))
    }

    @Test
    func invoiceDraftRoundTripKeepsExistingLineIdentity() throws {
        let data = Data(#"{"revision":"updated-1","input":{"project_id":"project-1","invoice_number":"INV-1","title":"Test invoice","issue_date":"2026-10-01","due_date":"2026-10-31","notes":"","tax_rate":0,"lines":[{"id":"line-1","description":"Visit","quantity":1,"unit":"hour","unit_cost":125,"taxable":false}]}}"#.utf8)
        let snapshot = try JSONDecoder.arc.decode(NativeInvoiceDraftSnapshot.self, from: data)
        let line = snapshot.input.lines[0]
        let draft = NativeInvoiceLineDraft(sourceID: line.id, description: line.description, quantity: String(line.quantity), unit: line.unit, unitPrice: String(line.unitCost), taxable: line.taxable)
        #expect(draft.input?.id == "line-1")
        #expect(draft.subtotalCents == 12500)
    }
}

@MainActor
struct WorkspaceRowsTests {
    @Test
    func localDraftRemovalDoesNotRemoveOtherProjectsOrOrganizations() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let cache = FieldReferenceCache(userID: "user-a", organizationID: "org-a", root: directory)
        let other = FieldReferenceCache(userID: "user-a", organizationID: "org-b", root: directory)
        try cache.write(["title": "Draft A"], key: "project-a")
        try cache.write(["title": "Draft B"], key: "project-b")
        try other.write(["title": "Other organization"], key: "project-a")
        cache.remove(key: "project-a")
        #expect(cache.read([String: String].self, key: "project-a") == nil)
        #expect(cache.read([String: String].self, key: "project-b")?["title"] == "Draft B")
        #expect(other.read([String: String].self, key: "project-a")?["title"] == "Other organization")
    }

    @Test
    func nestedContractFieldsDecodeAndValidateRequiredRows() throws {
        let data = Data(#"{"key":"lines","label":"Lines","kind":"rows","required":true,"fields":[{"key":"description","label":"Description","kind":"text","required":true},{"key":"quantity","label":"Quantity","kind":"number","required":true}]}"#.utf8)
        let field = try JSONDecoder.arc.decode(MobileWorkspaceField.self, from: data)
        #expect(field.accepts(#"[{"description":"Work","quantity":"2"}]"#))
        for invalid in ["", "[]", "{}", #"[{"quantity":"2"}]"#, #"[{"description":"Work","quantity":"NaN"}]"#] {
            #expect(!field.accepts(invalid))
        }
    }
}
