import type * as MuPDF from "mupdf";
import type { AreaRegion } from "./area-takeoff";

/** Render only the requested PDF region, at source resolution. Allocating the
 * regional pixmap avoids rendering an enormous page merely to crop a room.
 * The returned frame includes pixel rounding and is authoritative for overlays. */
export function renderPdfRegion(mupdf: typeof MuPDF, page: MuPDF.Page, options: {
  region: AreaRegion;
  scale: number;
  maximumDimension?: number;
}) {
  const { region: r } = options, maximum = options.maximumDimension ?? 4096;
  if (![r.x0, r.y0, r.x1, r.y1, options.scale, maximum].every(Number.isFinite)
    || r.x0 < 0 || r.y0 < 0 || r.x1 > 1 || r.y1 > 1 || r.x1 <= r.x0 || r.y1 <= r.y0
    || options.scale <= 0 || !Number.isInteger(maximum) || maximum < 4 || maximum > 8192)
    throw new Error("Invalid PDF region or render budget");
  const [ox, oy, ex, ey] = page.getBounds(), width = ex - ox, height = ey - oy;
  if (!(width > 0 && height > 0)) throw new Error("Invalid PDF page bounds");
  // Reserve rounding on both edges within the allocation budget.
  const scale = Math.min(options.scale, (maximum - 2) / Math.max(width * (r.x1 - r.x0), height * (r.y1 - r.y0)));
  const left = Math.floor(r.x0 * width * scale), top = Math.floor(r.y0 * height * scale);
  const right = Math.ceil(r.x1 * width * scale), bottom = Math.ceil(r.y1 * height * scale);
  const pixmap = new mupdf.Pixmap(mupdf.ColorSpace.DeviceRGB, [left, top, right, bottom], false);
  try {
    pixmap.clear(255);
    const device = new mupdf.DrawDevice(mupdf.Matrix.identity, pixmap);
    try {
      page.run(device, [scale, 0, 0, scale, -ox * scale, -oy * scale]);
      device.close();
    } finally { device.destroy(); }
    return {
      data: new Uint8Array(pixmap.asPNG()), width: pixmap.getWidth(), height: pixmap.getHeight(), scale,
      region: { x0: left / (width * scale), y0: top / (height * scale), x1: right / (width * scale), y1: bottom / (height * scale) },
    };
  } finally { pixmap.destroy(); }
}
