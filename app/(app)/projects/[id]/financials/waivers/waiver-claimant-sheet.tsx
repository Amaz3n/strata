"use client"

import { type CSSProperties, useEffect } from "react"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { z } from "zod"

import type { CommitmentSummary } from "@/lib/services/commitments"
import { formatLocalDate } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ShieldCheck } from "@/components/icons"

const claimantSchema = z.object({
  commitment_id: z.string().uuid({ message: "Choose a first-tier commitment" }),
  claimant_company_name: z
    .string()
    .trim()
    .min(2, "Enter the supplier or sub-subcontractor name")
    .max(200),
  amount_dollars: z.coerce.number().min(0, "Amount can't be negative"),
  waiver_type: z.enum(["conditional", "unconditional", "final"]),
})

export type ClaimantFormValues = z.infer<typeof claimantSchema>

const DEFAULTS: ClaimantFormValues = {
  commitment_id: "",
  claimant_company_name: "",
  amount_dollars: 0,
  waiver_type: "conditional",
}

interface WaiverClaimantSheetProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  commitments: CommitmentSummary[]
  periodEnd: string
  isSubmitting?: boolean
  onSubmit: (values: ClaimantFormValues) => Promise<boolean>
}

export function WaiverClaimantSheet({
  open,
  onOpenChange,
  commitments,
  periodEnd,
  isSubmitting,
  onSubmit,
}: WaiverClaimantSheetProps) {
  const form = useForm<ClaimantFormValues>({
    resolver: zodResolver(claimantSchema),
    defaultValues: DEFAULTS,
  })

  useEffect(() => {
    if (open) form.reset(DEFAULTS)
  }, [open, form])

  const firstTierCommitments = commitments.filter((item) => item.company_id)

  const handleSubmit = form.handleSubmit(async (values) => {
    const ok = await onSubmit(values)
    if (ok) onOpenChange(false)
  })

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="right"
        mobileFullscreen
        className="sm:max-w-lg sm:ml-auto sm:mr-4 sm:mt-4 sm:h-[calc(100vh-2rem)] shadow-2xl flex flex-col p-0 fast-sheet-animation"
        style={{ animationDuration: "150ms", transitionDuration: "150ms" } as CSSProperties}
      >
        <SheetHeader className="px-6 pt-6 pb-4 border-b bg-muted/30">
          <SheetTitle className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-primary" />
            Add sub-tier claimant
          </SheetTitle>
          <SheetDescription className="text-sm text-muted-foreground">
            Require a supplier or sub-subcontractor waiver for the pay period ending{" "}
            {formatLocalDate(periodEnd, "MMM d, yyyy")}. The first-tier sub is emailed to collect it.
          </SheetDescription>
        </SheetHeader>

        <Form {...form}>
          <form className="flex-1 flex flex-col overflow-hidden" onSubmit={handleSubmit}>
            <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
              <FormField
                control={form.control}
                name="commitment_id"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>First-tier commitment</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value}>
                      <FormControl>
                        <SelectTrigger className="w-full">
                          <SelectValue placeholder="Choose commitment" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent>
                        {firstTierCommitments.map((item) => (
                          <SelectItem key={item.id} value={item.id}>
                            {item.company_name ?? "Company"} · {item.title}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormDescription>
                      The prime subcontract this claimant flows through.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <FormField
                control={form.control}
                name="claimant_company_name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Claimant</FormLabel>
                    <FormControl>
                      <Input placeholder="Supplier or sub-subcontractor" {...field} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />

              <div className="grid gap-4 sm:grid-cols-2">
                <FormField
                  control={form.control}
                  name="amount_dollars"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Amount</FormLabel>
                      <FormControl>
                        <div className="relative">
                          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                            $
                          </span>
                          <Input
                            type="number"
                            min="0"
                            step="0.01"
                            className="pl-6 tabular-nums"
                            {...field}
                          />
                        </div>
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <FormField
                  control={form.control}
                  name="waiver_type"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Waiver type</FormLabel>
                      <Select onValueChange={field.onChange} value={field.value}>
                        <FormControl>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                          <SelectItem value="conditional">Conditional</SelectItem>
                          <SelectItem value="unconditional">Unconditional</SelectItem>
                          <SelectItem value="final">Final</SelectItem>
                        </SelectContent>
                      </Select>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>

            <SheetFooter className="border-t bg-background/80 px-6 py-4 flex flex-row gap-2">
              <Button
                type="button"
                variant="outline"
                className="flex-1"
                onClick={() => onOpenChange(false)}
              >
                Cancel
              </Button>
              <Button type="submit" className="flex-1" disabled={isSubmitting}>
                Add claimant
              </Button>
            </SheetFooter>
          </form>
        </Form>
      </SheetContent>
    </Sheet>
  )
}
