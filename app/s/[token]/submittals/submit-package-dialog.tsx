"use client"

import { useState, useTransition } from "react"

import type { Submittal } from "@/lib/types"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { useToast } from "@/hooks/use-toast"
import { submitSubPortalSubmittalItemAction } from "./actions"

interface SubmitPackageDialogProps {
  token: string
  submittal: Submittal | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSubmitted?: () => void
}

export function SubmitPackageDialog({ token, submittal, open, onOpenChange, onSubmitted }: SubmitPackageDialogProps) {
  const { toast } = useToast()
  const [isPending, startTransition] = useTransition()
  const [description, setDescription] = useState("")
  const [manufacturer, setManufacturer] = useState("")
  const [modelNumber, setModelNumber] = useState("")
  const [file, setFile] = useState<File | null>(null)

  const reset = () => {
    setDescription("")
    setManufacturer("")
    setModelNumber("")
    setFile(null)
  }

  const handleSubmit = () => {
    if (!submittal) return
    if (!description.trim()) {
      toast({ title: "Description required", description: "Describe what you are submitting." })
      return
    }
    startTransition(async () => {
      try {
        const formData = new FormData()
        formData.append("submittal_id", submittal.id)
        formData.append("description", description.trim())
        if (manufacturer.trim()) formData.append("manufacturer", manufacturer.trim())
        if (modelNumber.trim()) formData.append("model_number", modelNumber.trim())
        if (file) formData.append("file", file)

        await submitSubPortalSubmittalItemAction(token, formData)
        toast({ title: "Submitted", description: "Your documents were sent for review." })
        reset()
        onOpenChange(false)
        onSubmitted?.()
      } catch (error) {
        toast({
          title: "Could not submit",
          description: error instanceof Error ? error.message : "Try again.",
        })
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Submit for {submittal ? `Submittal #${submittal.submittal_number}` : "submittal"}
          </DialogTitle>
          <DialogDescription>
            Upload product data, shop drawings, or cut sheets for review.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <Textarea
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What are you submitting? (e.g. Trane XR14 product data)"
            rows={3}
          />
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              value={manufacturer}
              onChange={(e) => setManufacturer(e.target.value)}
              placeholder="Manufacturer (optional)"
            />
            <Input
              value={modelNumber}
              onChange={(e) => setModelNumber(e.target.value)}
              placeholder="Model number (optional)"
            />
          </div>
          <Input
            type="file"
            accept=".pdf,.png,.jpg,.jpeg,.webp,.doc,.docx,.xls,.xlsx"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button onClick={handleSubmit} disabled={isPending}>
              {isPending ? "Submitting..." : "Submit"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
