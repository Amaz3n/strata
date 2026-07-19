"use client"
import { Button } from "@/components/ui/button"
export default function SalesError({ reset }: { reset: () => void }) { return <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-6"><p className="text-sm font-medium">The Sales desk could not be loaded.</p><Button variant="outline" onClick={reset}>Try again</Button></div> }
