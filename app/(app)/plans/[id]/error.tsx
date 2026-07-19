"use client"

import { Button } from "@/components/ui/button"

export default function PlanDetailError({ reset }: { reset: () => void }) {
  return <div className="p-12 text-center"><p className="font-medium">This plan could not be loaded.</p><Button className="mt-4" variant="outline" onClick={reset}>Try again</Button></div>
}
