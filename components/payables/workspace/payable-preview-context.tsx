"use client"

import { createContext } from "react"

/** Waiver preparation shares the bill's existing document pane. */
export const PayablePreviewContext = createContext<HTMLDivElement | null>(null)
