import "server-only";
import { loadMupdf } from "@/lib/services/mupdf-loader";
/** Locate the renderer's signature row, including when the body spans pages. */
export async function waiverSignatureFields(bytes: Uint8Array, inlineDateCount = 0) {
  const mupdf = await loadMupdf();
  const doc = mupdf.Document.openDocument(bytes, "application/pdf");
  try {
    const inlineDates: Array<{
      page_index: number;
      field_type: "date";
      label: string;
      required: boolean;
      signer_role: string;
      x: number;
      y: number;
      w: number;
      h: number;
    }> = [];
    for (let i = 0; inlineDateCount > 0 && i < doc.countPages(); i++) {
      const page = doc.loadPage(i);
      try {
        const [x0, y0, x1, y1] = page.getBounds();
        for (const hit of page.search("________________")) {
          const q = hit[0];
          const left = Math.min(q[0], q[2], q[4], q[6]),
            top = Math.min(q[1], q[3], q[5], q[7]);
          const right = Math.max(q[0], q[2], q[4], q[6]),
            bottom = Math.max(q[1], q[3], q[5], q[7]);
          inlineDates.push({
            page_index: i,
            field_type: "date",
            label: "Date signed",
            required: true,
            signer_role: "claimant",
            x: (left - x0) / (x1 - x0),
            y: (top - y0) / (y1 - y0),
            w: (right - left) / (x1 - x0),
            h: (bottom - top) / (y1 - y0),
          });
        }
      } finally {
        page.destroy();
      }
    }
    if (inlineDates.length !== inlineDateCount) throw new Error("The signature date fields are ambiguous. Replace other blank lines with descriptive text in Settings and try again.")
    for (let i = doc.countPages() - 1; i >= 0; i--) {
      const page = doc.loadPage(i);
      try {
        const hits = page.search("Authorized signature");
        if (!hits.length) continue;
        const quad = hits[hits.length - 1][0];
        const [x0, y0, x1, y1] = page.getBounds();
        const top = Math.min(quad[1], quad[3], quad[5], quad[7]);
        const width = x1 - x0,
          height = y1 - y0;
        return [
          ...inlineDates,
          {
            page_index: i,
            field_type: "signature" as const,
            label: "Authorized signature",
            required: true,
            signer_role: "claimant",
            x: 52 / width,
            y: (top - y0 - 34) / height,
            w: 220 / width,
            h: 28 / height,
          },
          {
            page_index: i,
            field_type: "date" as const,
            label: "Date signed",
            required: true,
            signer_role: "claimant",
            x: 321 / width,
            y: (top - y0 - 28) / height,
            w: 200 / width,
            h: 22 / height,
          },
        ];
      } finally {
        page.destroy();
      }
    }
    throw new Error(
      "Could not locate the signature line. Review this template in Settings.",
    );
  } finally {
    doc.destroy();
  }
}
