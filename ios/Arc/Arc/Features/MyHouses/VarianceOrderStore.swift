import Foundation
import Observation

/// One photo staged for a variance order. `id` is chosen on device and becomes
/// the `files.id` server-side, so the variance body can reference the evidence
/// before the bytes have finished uploading — and a retry re-uses the same row.
struct VarianceOrderPhoto: Identifiable, Equatable, Sendable {
    let id: UUID
    let fileURL: URL
    let fileName: String
}

/// Backs field capture of a variance purchase order against one house.
///
@MainActor
@Observable
final class VarianceOrderStore {
    /// Documents folder field evidence lands in, so it is findable on the web.
    private static let photoFolder = "/Variance Orders"

    private let api: MobileAPIService
    private let networkMonitor: NetworkMonitor

    private(set) var reasonCodes: [MobileVarianceReasonCode] = []
    private(set) var recentOrders: [MobileVarianceOrder] = []
    private(set) var isLoadingContext = false
    private(set) var contextError: String?
    private(set) var isSubmitting = false
    private(set) var submitError: String?
    private(set) var loadedProjectID: String?

    init(api: MobileAPIService, networkMonitor: NetworkMonitor) {
        self.api = api
        self.networkMonitor = networkMonitor
    }

    private(set) var purchaseOrders: [MobileVarianceCommitment] = []

    /// Filing needs a live connection: the evidence photos have to upload with
    /// the variance, and the offline mutation queue carries JSON only.
    var isOffline: Bool { networkMonitor.status == .offline }

    func loadContext(projectID: String, organizationID: String, force: Bool = false) async {
        guard force || loadedProjectID != projectID else { return }
        if loadedProjectID != projectID {
            // Purchase orders belong to one house. Never let the previous
            // house's list stand in while the new one loads — the server would
            // reject the charge, but only after the super had already picked it.
            recentOrders = []
            purchaseOrders = []
        }
        loadedProjectID = projectID
        isLoadingContext = true
        contextError = nil
        defer { isLoadingContext = false }

        async let remoteReasons = api.loadVarianceReasonCodes(organizationID: organizationID)
        async let remoteOrders = api.loadVarianceOrders(projectID: projectID, organizationID: organizationID)
        async let remotePurchaseOrders = api.loadPurchaseOrders(projectID: projectID, organizationID: organizationID)
        do {
            let (reasons, orders, purchaseOrders) = try await (remoteReasons, remoteOrders, remotePurchaseOrders)
            self.purchaseOrders = purchaseOrders
            reasonCodes = reasons
            recentOrders = orders
        } catch is CancellationError {
            return
        } catch {
            reasonCodes = []
            recentOrders = []
            purchaseOrders = []
            contextError = (error as? APIError)?.userMessage ?? "Variance settings could not be loaded."
        }
    }

    /// Uploads evidence, then files the variance.
    ///
    /// `clientID` and the photo ids are owned by the caller and stay stable
    /// across retries, so a submission that fails halfway re-uses the same file
    /// rows and the same variance id instead of duplicating either.
    @discardableResult
    func file(
        clientID: UUID,
        purchaseOrderID: String,
        reason: MobileVarianceReasonCode,
        amountCents: Int,
        note: String,
        photos: [VarianceOrderPhoto],
        projectID: String,
        organizationID: String
    ) async -> MobileVarianceOrder? {
        guard !isSubmitting else { return nil }
        isSubmitting = true
        submitError = nil
        defer { isSubmitting = false }

        do {
            for photo in photos {
                _ = try await api.uploadFile(
                    fileURL: photo.fileURL,
                    fileName: photo.fileName,
                    mimeType: "image/jpeg",
                    clientID: photo.id.uuidString,
                    folder: Self.photoFolder,
                    category: "photos",
                    projectID: projectID,
                    organizationID: organizationID,
                    downscalesImages: true
                )
            }
        } catch {
            submitError = (error as? APIError)?.userMessage
                ?? "The photos could not be uploaded. Try again when you have a better signal."
            return nil
        }

        do {
            let created = try await api.createVarianceOrder(
                CreateVarianceOrderRequest(
                    commitmentId: purchaseOrderID,
                    reasonCodeId: reason.id,
                    amountCents: reason.signedAmountCents(fromPositive: amountCents),
                    note: note,
                    photoFileIds: photos.map { $0.id.uuidString.lowercased() },
                    clientId: clientID.uuidString.lowercased()
                ),
                projectID: projectID,
                organizationID: organizationID
            )
            recentOrders.insert(created, at: 0)
            return created
        } catch {
            submitError = (error as? APIError)?.userMessage ?? "The variance order could not be filed."
            return nil
        }
    }

    func clearSubmitError() {
        submitError = nil
    }
}
