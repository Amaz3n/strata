import "server-only";
import type { WaiverTemplateDraft } from "@/lib/templates/waiver-template";
import { loadMupdf } from "@/lib/services/mupdf-loader";
/** Locate the renderer's signature row, including when the body spans pages. */
export async function waiverSignatureFields(
  bytes: Uint8Array,
  inlineDateCount = 0,
  template?: WaiverTemplateDraft,
) {
  if (template?.document?.mode === "original")
    return template.document.placements
      .filter((p) => p.kind !== "text")
      .map((p) => ({
        page_index: p.page,
        field_type: p.kind as "signature" | "date" | "initials",
        label:
          p.kind === "signature"
            ? "Authorized signature"
            : p.kind === "initials"
              ? "Initials"
              : "Date signed",
        required: true,
        signer_role: p.signerRole ?? "claimant",
        x: p.x,
        y: p.y,
        w: p.width,
        h: p.height,
      }));
  if (template?.document?.mode === "editable") {
    const mupdf = await loadMupdf();
    const doc = mupdf.Document.openDocument(bytes, "application/pdf");
    const fields: Array<{
      page_index: number;
      field_type: "signature" | "date";
      label: string;
      required: boolean;
      signer_role: string;
      x: number;
      y: number;
      w: number;
      h: number;
    }> = [];
    try {
      for (let i = 0; i < doc.countPages(); i++) {
        const page = doc.loadPage(i);
        try {
          const [x0, y0, x1, y1] = page.getBounds(),
            width = x1 - x0,
            height = y1 - y0;
          for (const role of [
            ...new Set([
              "claimant",
              ...template.document.blocks
                .filter((b) => b.kind === "signature")
                .map((b) => b.signerRole ?? "claimant"),
            ]),
          ])
            for (const hit of page.search(
              role === "claimant"
                ? "Authorized signature"
                : `${role} signature`,
            )) {
              const top = Math.min(hit[0][1], hit[0][3], hit[0][5], hit[0][7]);
              fields.push({
                page_index: i,
                field_type: "signature",
                label:
                  role === "claimant"
                    ? "Authorized signature"
                    : `${role} signature`,
                required: true,
                signer_role: role,
                x: 52 / width,
                y: (top - y0 - 34) / height,
                w: (width - 104 - 30) / 2 / width,
                h: 28 / height,
              });
              fields.push({
                page_index: i,
                field_type: "date",
                label: "Date signed",
                required: true,
                signer_role: role,
                x: (52 + (width - 104 - 30) / 2 + 30) / width,
                y: (top - y0 - 28) / height,
                w: (width - 104 - 30) / 2 / width,
                h: 22 / height,
              });
            }
          // Only generated date blanks use Courier. Literal underlines in the
          // imported wording remain Helvetica and are never signature fields.
          const structured = page.toStructuredText();
          let quads: number[][] = [];
          const flush = () => {
            if (!quads.length) return;
            if (quads.length !== 16)
              throw new Error(
                "A signing date does not fit its line. Adjust the document layout.",
              );
            const xs = quads.flatMap((q) => [q[0], q[2], q[4], q[6]]);
            const ys = quads.flatMap((q) => [q[1], q[3], q[5], q[7]]);
            fields.push({
              page_index: i,
              field_type: "date",
              label: "Date signed",
              required: true,
              signer_role: "claimant",
              x: (Math.min(...xs) - x0) / width,
              y: (Math.min(...ys) - y0) / height,
              w: (Math.max(...xs) - Math.min(...xs)) / width,
              h: (Math.max(...ys) - Math.min(...ys)) / height,
            });
            quads = [];
          };
          try {
            structured.walk({
              onChar(c, _origin, font, _size, quad) {
                if (c === "_" && /Courier/i.test(font.getName())) {
                  quads.push([...quad]);
                  if (quads.length === 16) flush();
                } else flush();
              },
              endLine: flush,
            });
            flush();
          } finally {
            structured.destroy();
          }
        } finally {
          page.destroy();
        }
      }
      const expected = Math.max(
        1,
        template.document.blocks.filter((b) => b.kind === "signature").length,
      );
      if (
        fields.filter((f) => f.field_type === "signature").length !== expected
      )
        throw new Error(
          "Signature labels are ambiguous. Remove duplicate signature labels from the wording.",
        );
      if (!fields.some((f) => f.field_type === "signature"))
        throw new Error("No signature section found in this template");
      if (fields.some((f) => f.y < 0 || f.y + f.h > 1))
        throw new Error("A signature field falls outside the page");
      return fields;
    } finally {
      doc.destroy();
    }
  }
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
    if (inlineDates.length !== inlineDateCount)
      throw new Error(
        "The signature date fields are ambiguous. Replace other blank lines with descriptive text in Settings and try again.",
      );
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
