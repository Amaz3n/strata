import type * as MuPDF from "mupdf"
import { SHEET_METADATA_WINDOWS } from "./sheet-metadata"

/** Rasterize bounded windows directly; never build or download a tile pyramid. */
export function renderPdfLabelImages(mupdf: typeof MuPDF, bytes: Uint8Array) {
  const doc = mupdf.Document.openDocument(bytes, "application/pdf")
  const page = doc.loadPage(0)
  const list = page.toDisplayList(true)
  try {
    const [x, y, right, bottom] = page.getBounds()
    const width = right - x, height = bottom - y
    if (!(width > 0 && height > 0)) throw new Error("Invalid drawing page bounds")
    return SHEET_METADATA_WINDOWS.map((window, index) => {
      const left = x + width * window.x0, top = y + height * window.y0
      const w = width * (window.x1 - window.x0), h = height * (window.y1 - window.y0)
      const scale = (index === 0 ? 1800 : 1600) / Math.max(w, h)
      const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB,
        [0, 0, Math.ceil(w * scale), Math.ceil(h * scale)], false)
      pixmap.clear(255)
      const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap)
      try {
        list.run(device, [scale, 0, 0, scale, -left * scale, -top * scale])
        device.close()
        return { data: Buffer.from(pixmap.asJPEG(85)), mediaType: "image/jpeg" }
      } finally { device.destroy(); pixmap.destroy() }
    })
  } finally { list.destroy(); page.destroy(); doc.destroy() }
}
