// @ts-expect-error bun test types are not part of this app tsconfig
import { describe, expect, it } from "bun:test"

import {
  isActiveDocumentContent,
  projectIdFromDocumentStoragePath,
  shouldServeDocumentInline,
  validateDocumentUpload,
} from "@/lib/files/content-policy"

describe("document content policy", () => {
  it("rejects active content by MIME type or extension", () => {
    expect(isActiveDocumentContent("drawing.svg", "image/svg+xml")).toBe(true)
    expect(isActiveDocumentContent("payload.html", "application/octet-stream")).toBe(true)
    expect(() => validateDocumentUpload({ fileName: "page.html", contentType: "text/html", sizeBytes: 50 })).toThrow()
  })

  it("only renders passive preview formats inline", () => {
    expect(shouldServeDocumentInline("plans.pdf", "application/pdf")).toBe(true)
    expect(shouldServeDocumentInline("photo.jpg", "image/jpeg")).toBe(true)
    expect(shouldServeDocumentInline("notes.txt", "text/plain")).toBe(false)
    expect(shouldServeDocumentInline("drawing.svg", "image/svg+xml")).toBe(false)
  })

  it("enforces positive bounded upload sizes", () => {
    expect(validateDocumentUpload({ fileName: "plans.pdf", contentType: "application/pdf", sizeBytes: 1024 })).toEqual({
      contentType: "application/pdf",
      sizeBytes: 1024,
    })
    expect(() => validateDocumentUpload({ fileName: "empty.pdf", contentType: "application/pdf", sizeBytes: 0 })).toThrow()
    expect(() => validateDocumentUpload({ fileName: "huge.pdf", contentType: "application/pdf", sizeBytes: 101 * 1024 * 1024 })).toThrow()
  })

  it("binds multipart continuation calls to the project encoded by the upload path", () => {
    expect(projectIdFromDocumentStoragePath("org-1", "org-1/project-1/documents/uploads/file.pdf")).toBe("project-1")
    expect(projectIdFromDocumentStoragePath("org-1", "org-2/project-1/documents/uploads/file.pdf")).toBeNull()
    expect(projectIdFromDocumentStoragePath("org-1", "org-1/project-1/other/file.pdf")).toBeNull()
  })
})
