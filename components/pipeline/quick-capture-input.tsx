"use client"

import { useState, useTransition, useRef, useEffect } from "react"
import { useRouter } from "next/navigation"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Label } from "@/components/ui/label"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import type { TeamMember } from "@/lib/types"
import { createProspectAction } from "@/app/(app)/pipeline/actions"
import { useToast } from "@/hooks/use-toast"
import { Plus, Loader2, Zap } from "@/components/icons"
import { cn } from "@/lib/utils"

interface QuickCaptureInputProps {
  teamMembers: TeamMember[]
  className?: string
}

export function QuickCaptureInput({ teamMembers, className }: QuickCaptureInputProps) {
  const [open, setOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const { toast } = useToast()
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)

  const [name, setName] = useState("")
  const [phone, setPhone] = useState("")
  const [source, setSource] = useState("")
  const [owner, setOwner] = useState<string | undefined>()

  useEffect(() => {
    if (open && inputRef.current) {
      inputRef.current.focus()
    }
  }, [open])

  const reset = () => {
    setName("")
    setPhone("")
    setSource("")
    setOwner(undefined)
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    if (!name.trim()) {
      toast({ title: "Name is required" })
      return
    }

    startTransition(async () => {
      try {
        await createProspectAction({
          full_name: name.trim(),
          phone: phone.trim() || undefined,
          crm_source: source.trim() || undefined,
          lead_owner_user_id: owner,
          lead_priority: "normal",
        })
        router.refresh()
        toast({ title: "Prospect added", description: name.trim() })
        reset()
        setOpen(false)
      } catch (error) {
        toast({ title: "Failed to add prospect", description: (error as Error).message })
      }
    })
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button className={cn("gap-2", className)}>
          <Zap className="h-4 w-4" />
          Quick add
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-80" align="end">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <h4 className="font-medium text-sm">Quick capture</h4>
            <p className="text-xs text-muted-foreground">Add a new prospect in seconds</p>
          </div>

          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="quick-name" className="text-xs">Name *</Label>
              <Input
                ref={inputRef}
                id="quick-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="John Smith"
                className="h-9"
              />
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="quick-phone" className="text-xs">Phone</Label>
              <Input
                id="quick-phone"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="(555) 555-5555"
                className="h-9"
              />
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label htmlFor="quick-source" className="text-xs">Source</Label>
                <Input
                  id="quick-source"
                  value={source}
                  onChange={(e) => setSource(e.target.value)}
                  placeholder="Referral"
                  className="h-9"
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Owner</Label>
                <Select value={owner ?? "none"} onValueChange={(v) => setOwner(v === "none" ? undefined : v)}>
                  <SelectTrigger className="h-9">
                    <SelectValue placeholder="Assign" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Unassigned</SelectItem>
                    {teamMembers.map((member) => (
                      <SelectItem key={member.user.id} value={member.user.id}>
                        {member.user.full_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>

          <div className="flex justify-end gap-2 pt-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setOpen(false)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={isPending}>
              {isPending ? (
                <>
                  <Loader2 className="h-3 w-3 mr-1 animate-spin" />
                  Adding...
                </>
              ) : (
                <>
                  <Plus className="h-3 w-3 mr-1" />
                  Add
                </>
              )}
            </Button>
          </div>
        </form>
      </PopoverContent>
    </Popover>
  )
}
