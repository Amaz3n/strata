"use client"

import type { Contact, CostCode, Invoice, Project } from "@/lib/types"
import type { InvoiceInput } from "@/lib/validation/invoices"
import { Sheet, SheetContent } from "@/components/ui/sheet"
import { MiddayInvoiceWrapper } from "./midday-invoice-wrapper"

type Props = {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: Project[]
  defaultProjectId?: string
  onSubmit: (values: InvoiceInput, sendToClient: boolean) => Promise<void>
  isSubmitting?: boolean
  mode?: "create" | "edit"
  invoice?: Invoice | null
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
  mode = "create",
  invoice,
  builderInfo,
  contacts,
  costCodes,
}: Props) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="sm:max-w-3xl sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 bg-[#fdfdfd] dark:bg-[#0f0f0f] [&>button[aria-label='Close']]:hidden [&_[data-slot=sheet-close]]:hidden"
      >
        <div className="flex h-full flex-col gap-4 px-4 py-8 sm:px-5 sm:py-10">
          <div className="flex-1 overflow-hidden">
            <div className="h-full w-full mx-auto max-w-2xl">
              <MiddayInvoiceWrapper
                projects={projects}
                defaultProjectId={defaultProjectId}
                onSubmit={onSubmit}
                isSubmitting={isSubmitting}
                mode={mode}
                invoice={invoice ?? undefined}
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
