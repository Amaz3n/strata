"use client"

import { useState } from "react"

import { ProvisionOrgForm } from "@/components/admin/provision-form"
import { Button } from "@/components/ui/button"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"

interface PlanOption {
  code: string
  name: string
  pricingModel: string
  isActive: boolean
}

interface ProvisionOrgSheetProps {
  plans: PlanOption[]
  action?: (prevState: { error?: string; message?: string }, formData: FormData) => Promise<{ error?: string; message?: string }>
}

export function ProvisionOrgSheet({ plans, action }: ProvisionOrgSheetProps) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <Button onClick={() => setOpen(true)}>Provision Organization</Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          side="right"
          mobileFullscreen
          className="sm:max-w-lg sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation"
          style={
            {
              animationDuration: "150ms",
              transitionDuration: "150ms",
            } as React.CSSProperties
          }
        >
          <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
            <SheetTitle>Provision Organization</SheetTitle>
            <SheetDescription>Create a new client org and invite the primary contact as owner.</SheetDescription>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto px-6 py-4">
            <ProvisionOrgForm action={action} plans={plans} />
          </div>
        </SheetContent>
      </Sheet>
    </>
  )
}
