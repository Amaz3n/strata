"use client"

import { useState, useTransition } from "react"
import type { PunchItem } from "@/lib/types"
import { createPunchItemAction } from "./actions"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

interface Props {
  token: string
  items: PunchItem[]
}

export function PunchListPortalClient({ token, items: initialItems }: Props) {
  const [items, setItems] = useState(initialItems)
  const [form, setForm] = useState({ title: "", description: "", location: "", severity: "" })
  const [isPending, startTransition] = useTransition()

  const handleSubmit = () => {
    if (!form.title.trim()) return
    startTransition(async () => {
      try {
        const created = await createPunchItemAction({ token, ...form })
        setItems((prev) => [created, ...prev])
        setForm({ title: "", description: "", location: "", severity: "" })
      } catch (error) {
        console.error("Failed to add punch item", error)
      }
    })
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-background to-muted px-4 py-6">
      <div className="mx-auto max-w-4xl space-y-4">
        <header className="space-y-1 text-center">
          <p className="text-xs uppercase tracking-wide text-muted-foreground">Punch List</p>
          <h1 className="text-2xl font-bold">Add and track items</h1>
          <p className="text-sm text-muted-foreground">Create items during walkthroughs with photos later.</p>
        </header>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add new item</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <Input
              placeholder="Title"
              value={form.title}
              onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
            />
            <Textarea
              placeholder="Describe the issue"
              value={form.description}
              onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
            />
            <Input
              placeholder="Location (e.g., Kitchen, north wall)"
              value={form.location}
              onChange={(e) => setForm((f) => ({ ...f, location: e.target.value }))}
            />
            <Input
              placeholder="Severity (optional)"
              value={form.severity}
              onChange={(e) => setForm((f) => ({ ...f, severity: e.target.value }))}
            />
            <Button onClick={handleSubmit} disabled={isPending || !form.title.trim()}>
              {isPending ? <Spinner className="mr-2 h-4 w-4" /> : null}
              Add item
            </Button>
          </CardContent>
        </Card>

        <div className="space-y-3">
          {items.map((item) => (
            <Card key={item.id}>
              <CardHeader className="flex flex-row items-center justify-between">
                <CardTitle className="text-base">{item.title}</CardTitle>
                <Badge variant="secondary" className="capitalize text-[11px]">
                  {item.status}
                </Badge>
              </CardHeader>
              <CardContent className="space-y-1">
                {item.description && <p className="text-sm text-muted-foreground">{item.description}</p>}
                {item.location && <p className="text-xs text-muted-foreground">Location: {item.location}</p>}
                {item.severity && <p className="text-xs text-muted-foreground">Severity: {item.severity}</p>}
              </CardContent>
            </Card>
          ))}
          {items.length === 0 && (
            <Card>
              <CardContent className="p-6 text-muted-foreground text-center">No punch items yet.</CardContent>
            </Card>
          )}
        </div>
      </div>
    </div>
  )
}



