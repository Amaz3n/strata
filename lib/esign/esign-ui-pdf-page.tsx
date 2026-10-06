"use client"

import { useEffect, useRef, useState, type ComponentType } from "react"

/** Keep offscreen canvases out of memory while retaining measured page geometry. */
export function ESignPdfPage({ Page, pageNumber, width, textLayer = false, renderAll = false }: {
  Page: ComponentType<any>
  pageNumber: number
  width: number
  textLayer?: boolean
  renderAll?: boolean
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(pageNumber === 1)
  const [aspect, setAspect] = useState(792 / 612)
  useEffect(() => {
    const element = ref.current
    if (!element) return
    const observer = new IntersectionObserver(entries => setVisible(entries[0].isIntersecting), { rootMargin: "1000px 0px" })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return <div ref={ref} style={{ width, minHeight: width * aspect }}>
    {visible || renderAll ? <Page pageNumber={pageNumber} width={width} renderTextLayer={textLayer} renderAnnotationLayer={false}
      onLoadSuccess={(page: { getViewport: (options: { scale: number }) => { width: number; height: number } }) => {
        const viewport = page.getViewport({ scale: 1 })
        setAspect(viewport.height / viewport.width)
      }} /> : <div aria-label={`Page ${pageNumber}`} style={{ height: width * aspect }} className="bg-white" />}
  </div>
}
