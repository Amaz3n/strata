"use client"

import type { Contact, CostCode, Project } from "@/lib/types"
import type { InvoiceInput } from "@/lib/validation/invoices"
import { useState } from "react"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { MiddayInvoiceWrapper } from "./midday-invoice-wrapper"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: Project[]
  defaultProjectId?: string
  onSubmit: (values: InvoiceInput, sendToClient: boolean) => Promise<void>
  isSubmitting?: boolean
  builderInfo?: {
    name?: string | null
    email?: string | null
    address?: string | null
  }
  contacts?: Contact[]
  costCodes?: CostCode[]
}

export function MiddayInvoiceSheet({
  open,
  onOpenChange,
  projects,
  defaultProjectId,
  onSubmit,
  isSubmitting,
  builderInfo,
  contacts,
  costCodes,
}: Props) {
  const [submitMode, setSubmitMode] = useState<"draft" | "send">("draft")

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        className="w-full sm:max-w-3xl ml-auto mr-4 mt-4 h-[calc(100vh-2rem)] rounded-lg border shadow-2xl flex flex-col p-0 bg-[#fdfdfd] dark:bg-[#0f0f0f] [&>button[aria-label='Close']]:hidden [&_[data-slot=sheet-close]]:hidden"
      >
        <div className="flex h-full flex-col gap-4 px-4 py-8 sm:px-5 sm:py-10">
          <div className="flex-1 overflow-hidden">
            <div className="h-full w-full mx-auto max-w-2xl">
              <MiddayInvoiceWrapper
                projects={projects}
                defaultProjectId={defaultProjectId}
                onSubmit={async (values, send) => {
                  setSubmitMode(send ? "send" : "draft")
                  await onSubmit(values, send)
                }}
                isSubmitting={isSubmitting}
                submitMode={submitMode}
                builderInfo={builderInfo}
                contacts={contacts}
                costCodes={costCodes}
              />
            </div>
          </div>
        </div>
      </SheetContent>
    </Sheet>
  )
}



