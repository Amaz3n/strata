"use client"

import { CheckCircle2, Circle } from "lucide-react"

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import Link from "next/link"

interface OnboardingChecklistProps {
  members: number
  projects: number
  contacts: number
}

export function OnboardingChecklist({ members, projects, contacts }: OnboardingChecklistProps) {
  const steps = [
    {
      label: "Invite your team",
      href: "/team",
      done: members > 1,
    },
    {
      label: "Create your first project",
      href: "/projects",
      done: projects > 0,
    },
    {
      label: "Add contacts/companies",
      href: "/contacts",
      done: contacts > 0,
    },
  ]

  const remaining = steps.filter((s) => !s.done)
  if (remaining.length === 0) return null

  return (
    <Card>
      <CardHeader>
        <CardTitle>Finish onboarding</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-3">
          {steps.map((step) => (
            <div key={step.label} className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                {step.done ? (
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                ) : (
                  <Circle className="h-4 w-4 text-muted-foreground" />
                )}
                <span className={step.done ? "text-muted-foreground line-through" : ""}>{step.label}</span>
              </div>
              {!step.done && (
                <Button variant="ghost" size="sm" asChild>
                  <Link href={step.href}>Go</Link>
                </Button>
              )}
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  )
}


