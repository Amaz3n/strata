import CryptoKit
import Foundation
import Security

actor KeychainStore {
    enum KeychainError: Error, Equatable {
        case unexpectedStatus(OSStatus)
        case invalidData
    }

    private let service: String

    init(service: String = Bundle.main.bundleIdentifier ?? "com.arc.mobile") {
        self.service = service
    }

    func set(_ data: Data, for key: String) throws {
        let query = baseQuery(for: key)
        let update = [kSecValueData as String: data]
        let status = SecItemUpdate(query as CFDictionary, update as CFDictionary)

        if status == errSecItemNotFound {
            var item = query
            item[kSecValueData as String] = data
            item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
            let addStatus = SecItemAdd(item as CFDictionary, nil)
            guard addStatus == errSecSuccess else {
                throw KeychainError.unexpectedStatus(addStatus)
            }
        } else if status != errSecSuccess {
            throw KeychainError.unexpectedStatus(status)
        }
    }

    func data(for key: String) throws -> Data? {
        var query = baseQuery(for: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne

        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound {
            return nil
        }
        guard status == errSecSuccess else {
            throw KeychainError.unexpectedStatus(status)
        }
        guard let data = result as? Data else {
            throw KeychainError.invalidData
        }
        return data
    }

    /// SecItemAdd is atomic across callers; an existing submission is never overwritten.
    func insertIfAbsent(_ data: Data, for key: String) throws -> Data {
        var item = baseQuery(for: key)
        item[kSecValueData as String] = data
        item[kSecAttrGeneric as String] = Data(SHA256.hash(data: data))
        item[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
        let status = SecItemAdd(item as CFDictionary, nil)
        if status == errSecDuplicateItem {
            guard let existing = try self.data(for: key) else { throw KeychainError.invalidData }
            return existing
        }
        guard status == errSecSuccess else { throw KeychainError.unexpectedStatus(status) }
        return data
    }

    /// Remove only this exact reserved record, never a newer attempt from another screen/process.
    func deleteMatching(_ data: Data, for key: String) throws {
        var query = baseQuery(for: key)
        query[kSecAttrGeneric as String] = Data(SHA256.hash(data: data))
        let status = SecItemDelete(query as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw KeychainError.unexpectedStatus(status) }
    }

    func delete(_ key: String) throws {
        let status = SecItemDelete(baseQuery(for: key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else {
            throw KeychainError.unexpectedStatus(status)
        }
    }

    private func baseQuery(for key: String) -> [String: Any] {
        [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
    }
}

extension KeychainStore: ServiceCompletionSecrets {}
