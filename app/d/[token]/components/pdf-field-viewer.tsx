"use client"

import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react"

import { Check, CheckCircle2, ChevronLeft, ChevronRight, Loader2, PenLine } from "@/components/icons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

import { isFieldComplete, normalizeFieldLabel, type SigningField } from "./types"

interface PdfFieldViewerProps {
  PDFComponents: { Document: any; Page: any } | null
  fileUrl: string
  fieldsByPage: Record<number, SigningField[]>
  signerRole: string
  values: Record<string, unknown>
  activeFieldId: string | null
  currentPageIndex: number
  pageCount: number
  onFieldSelect: (fieldId: string) => void
  onPageChange: (pageIndex: number) => void
  onPageCountChange: (count: number) => void
  onApplyFieldValue: (
    field: SigningField,
    value: unknown,
    options?: { advance?: boolean; updateSignerName?: boolean },
  ) => void
  onSignatureRequested: (field: SigningField) => void
}

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value))
}

export function PdfFieldViewer({
  PDFComponents,
  fileUrl,
  fieldsByPage,
  signerRole,
  values,
  activeFieldId,
  currentPageIndex,
  pageCount,
  onFieldSelect,
  onPageChange,
  onPageCountChange,
  onApplyFieldValue,
  onSignatureRequested,
}: PdfFieldViewerProps) {
  const wrapperRef = useRef<HTMLDivElement | null>(null)
  const pageRefs = useRef<Record<number, HTMLDivElement | null>>({})
  const overlayRefs = useRef<Record<string, HTMLElement | null>>({})
  const [pageWidth, setPageWidth] = useState(1100)

  useEffect(() => {
    const element = wrapperRef.current
    if (!element) return

    const observer = new ResizeObserver((entries) => {
      const next = clamp(entries[0]?.contentRect.width ?? 1100, 360, 1500)
      setPageWidth(next - 18)
    })

    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!activeFieldId) return
    overlayRefs.current[activeFieldId]?.scrollIntoView({ block: "center", behavior: "smooth" })
  }, [activeFieldId])

  useEffect(() => {
    const container = wrapperRef.current
    if (!container) return

    const onScroll = () => {
      const containerRect = container.getBoundingClientRect()
      const containerCenter = containerRect.top + containerRect.height / 2

      let bestIndex = currentPageIndex
      let bestDistance = Number.POSITIVE_INFINITY

      for (let i = 0; i < pageCount; i += 1) {
        const pageEl = pageRefs.current[i]
        if (!pageEl) continue
        const rect = pageEl.getBoundingClientRect()
        const pageCenter = rect.top + rect.height / 2
        const distance = Math.abs(pageCenter - containerCenter)

        if (distance < bestDistance) {
          bestDistance = distance
          bestIndex = i
        }
      }

      if (bestIndex !== currentPageIndex) {
        onPageChange(bestIndex)
      }
    }

    container.addEventListener("scroll", onScroll, { passive: true })
    return () => container.removeEventListener("scroll", onScroll)
  }, [currentPageIndex, onPageChange, pageCount])

  const scrollToPage = (pageIndex: number) => {
    const clamped = Math.max(0, Math.min(pageCount - 1, pageIndex))
    const target = pageRefs.current[clamped]
    if (!target) return

    target.scrollIntoView({ behavior: "smooth", block: "start" })
    onPageChange(clamped)
  }

  const handleInlineKeyDown = (
    event: KeyboardEvent<HTMLInputElement>,
    field: SigningField,
    nextValue: string,
  ) => {
    if (event.key === "Enter") {
      event.preventDefault()
      onApplyFieldValue(field, nextValue, {
        advance: true,
        updateSignerName: field.field_type === "name",
      })
    }
  }

  const renderPage = (pageIndex: number) => {
    const pageFields = fieldsByPage[pageIndex] ?? []

    return (
      <div
        key={pageIndex}
        ref={(node) => {
          pageRefs.current[pageIndex] = node
        }}
        className="relative mx-auto w-fit overflow-hidden rounded-md border bg-background shadow-sm"
      >
        {PDFComponents && (
          <PDFComponents.Page
            pageNumber={pageIndex + 1}
            width={pageWidth}
            renderTextLayer={false}
            renderAnnotationLayer={false}
          />
        )}

        <div className="absolute inset-0">
          {pageFields.map((field) => {
            const belongsToCurrentSigner = !field.signer_role || field.signer_role === signerRole
            const filled = isFieldComplete(field, values)
            const rawValue = values[field.id]
            const value = typeof rawValue === "string" ? rawValue : ""
            const isActive = field.id === activeFieldId
            const label = normalizeFieldLabel(field)

            const overlayClassName = cn(
              "absolute overflow-hidden rounded-sm border text-[10px] font-medium uppercase tracking-wide transition-all duration-200",
              belongsToCurrentSigner && !filled && "hover:bg-primary/5",
              isActive && "z-20 border-primary bg-primary/10 text-primary ring-1 ring-primary/35",
              !isActive && filled && "border-emerald-500/70 bg-emerald-500/10 text-emerald-700",
              !isActive && !filled && belongsToCurrentSigner && "border-border border-dashed bg-background/85 text-foreground",
              !belongsToCurrentSigner && "border-border bg-muted/50 text-muted-foreground",
            )

            const style = {
              left: `${field.x * 100}%`,
              top: `${field.y * 100}%`,
              width: `${field.w * 100}%`,
              height: `${field.h * 100}%`,
            }

            if (!belongsToCurrentSigner) {
              return (
                <div key={field.id} className={overlayClassName} style={style}>
                  {field.field_type === "signature" && value ? (
                    <img src={value} alt={label} className="h-full w-full object-contain p-0.5" />
                  ) : (
                    <div className="flex h-full items-center justify-between gap-1 px-1.5">
                      <span className="truncate">{label}</span>
                      {filled ? <CheckCircle2 className="h-3 w-3 shrink-0" /> : null}
                    </div>
                  )}
                </div>
              )
            }

            if (field.field_type === "signature") {
              return (
                <button
                  key={field.id}
                  type="button"
                  ref={(node) => {
                    overlayRefs.current[field.id] = node
                  }}
                  className={overlayClassName}
                  style={style}
                  onClick={() => {
                    onFieldSelect(field.id)
                    onSignatureRequested(field)
                  }}
                >
                  {value ? (
                    <img src={value} alt={label} className="h-full w-full object-contain p-0.5" />
                  ) : (
                    <div className="flex h-full items-center justify-center gap-1 px-1.5 text-[9px]">
                      <PenLine className="h-3 w-3" />
                      Click to sign
                    </div>
                  )}
                </button>
              )
            }

            if (field.field_type === "checkbox") {
              return (
                <button
                  key={field.id}
                  type="button"
                  ref={(node) => {
                    overlayRefs.current[field.id] = node
                  }}
                  className={overlayClassName}
                  style={style}
                  onClick={() => {
                    onFieldSelect(field.id)
                    onApplyFieldValue(field, rawValue !== true, { advance: true })
                  }}
                >
                  <div className="flex h-full items-center justify-center px-1.5">
                    <span
                      className={cn(
                        "inline-flex h-[78%] w-[78%] items-center justify-center rounded-[2px] border",
                        rawValue === true
                          ? "border-emerald-600 bg-emerald-600/15 text-emerald-700"
                          : "border-muted-foreground/40 bg-background/80 text-transparent",
                      )}
                    >
                      {rawValue === true ? <Check className="h-3 w-3" /> : null}
                    </span>
                  </div>
                </button>
              )
            }

            if (isActive) {
              return (
                <div
                  key={field.id}
                  ref={(node) => {
                    overlayRefs.current[field.id] = node
                  }}
                  className={overlayClassName}
                  style={style}
                >
                  <Input
                    autoFocus
                    value={value}
                    onChange={(event) => {
                      const nextValue =
                        field.field_type === "initials"
                          ? event.target.value.toUpperCase().slice(0, 8)
                          : event.target.value
                      onApplyFieldValue(field, nextValue, {
                        updateSignerName: field.field_type === "name",
                      })
                    }}
                    onKeyDown={(event) => {
                      const nextValue =
                        field.field_type === "initials"
                          ? event.currentTarget.value.toUpperCase().slice(0, 8)
                          : event.currentTarget.value
                      handleInlineKeyDown(event, field, nextValue)
                    }}
                    type={field.field_type === "date" ? "date" : "text"}
                    className="h-full rounded-none border-0 bg-transparent px-1.5 py-0 text-[11px] font-medium focus-visible:ring-0"
                  />
                </div>
              )
            }

            return (
              <button
                key={field.id}
                type="button"
                ref={(node) => {
                  overlayRefs.current[field.id] = node
                }}
                className={overlayClassName}
                style={style}
                onClick={() => onFieldSelect(field.id)}
              >
                <div className="flex h-full items-center justify-between gap-1 px-1.5">
                  <span className="truncate">{label}</span>
                  {filled ? <CheckCircle2 className="h-3 w-3 shrink-0" /> : null}
                </div>
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  return (
    <section className="rounded-lg border bg-card">
      <div className="border-b px-4 py-2.5">
        <div className="flex items-center justify-center gap-3">
          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            onClick={() => scrollToPage(currentPageIndex - 1)}
            disabled={currentPageIndex <= 0}
            aria-label="Previous page"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>

          <div className="min-w-14 text-center text-sm font-medium">
            {Math.min(currentPageIndex + 1, Math.max(pageCount, 1))}
          </div>

          <Button
            type="button"
            size="icon"
            variant="ghost"
            className="h-8 w-8"
            onClick={() => scrollToPage(currentPageIndex + 1)}
            disabled={pageCount <= 0 || currentPageIndex >= pageCount - 1}
            aria-label="Next page"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <div ref={wrapperRef} className="h-[calc(100vh-13.5rem)] min-h-[500px] overflow-auto p-3 sm:p-4">
        {!PDFComponents ? (
          <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading document preview…
          </div>
        ) : (
          <PDFComponents.Document
            file={fileUrl}
            onLoadSuccess={(info: { numPages: number }) => onPageCountChange(info.numPages)}
          >
            <div className="space-y-4">
              {Array.from({ length: pageCount || 1 }).map((_, pageIndex) => renderPage(pageIndex))}
            </div>
          </PDFComponents.Document>
        )}
      </div>
    </section>
  )
}
