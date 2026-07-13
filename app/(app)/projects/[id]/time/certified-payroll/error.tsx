"use client"
import { Button } from "@/components/ui/button"
export default function ErrorState({ reset }: { error: Error; reset: () => void }) { return <div className="p-8 text-center"><p className="text-sm font-medium">Certified payroll could not be loaded.</p><Button className="mt-4" variant="outline" onClick={reset}>Try again</Button></div> }
