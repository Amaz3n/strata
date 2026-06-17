import "server-only"

/**
 * Convert a .docx file into a self-contained, styled HTML document suitable for
 * rendering inside a sandboxed iframe in the file viewer.
 *
 * Uses mammoth (https://github.com/mwilliamson/mammoth.js) which maps Word's
 * semantic structure (headings, lists, tables, bold/italic, images) into clean
 * HTML. It deliberately does NOT reproduce exact page layout/pagination — it is
 * a readable preview, not a pixel-perfect render.
 *
 * Legacy binary .doc files are NOT supported by mammoth and will throw.
 */
export async function convertDocxToPreviewHtml(
  sourceBytes: Buffer
): Promise<{ html: string }> {
  const mammothModule: any = await import("mammoth")
  const mammoth: any = mammothModule.default ?? mammothModule

  const { value: bodyHtml } = await mammoth.convertToHtml(
    { buffer: sourceBytes },
    {
      // Inline images as data URIs so the preview is fully self-contained.
      convertImage: mammoth.images.imgElement(async (image: any) => {
        const buffer = await image.read("base64")
        return { src: `data:${image.contentType};base64,${buffer}` }
      }),
    }
  )

  const safeBody = sanitizePreviewHtml(bodyHtml)
  return { html: wrapPreviewDocument(safeBody) }
}

/**
 * Defense-in-depth sanitization. mammoth never emits scripts or event handlers,
 * and the preview is served into a sandboxed iframe (no script execution), but
 * we still strip anything script-like before it is stored/served.
 */
function sanitizePreviewHtml(html: string): string {
  return html
    .replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, "")
    .replace(/<\s*script[^>]*>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "")
    .replace(/\son\w+\s*=\s*[^\s>]+/gi, "")
    .replace(/javascript:/gi, "")
}

function wrapPreviewDocument(bodyHtml: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:;" />
<style>
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 0; background: #f1f5f9; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
    color: #1e293b;
    line-height: 1.6;
    padding: 32px 16px 64px;
  }
  .doc {
    max-width: 816px;
    margin: 0 auto;
    background: #ffffff;
    padding: 64px 72px;
    border-radius: 8px;
    box-shadow: 0 1px 3px rgba(15, 23, 42, 0.12), 0 8px 24px rgba(15, 23, 42, 0.08);
  }
  .doc :first-child { margin-top: 0; }
  .doc :last-child { margin-bottom: 0; }
  .doc h1 { font-size: 1.75rem; line-height: 1.3; margin: 1.6em 0 0.6em; }
  .doc h2 { font-size: 1.4rem; line-height: 1.3; margin: 1.5em 0 0.5em; }
  .doc h3 { font-size: 1.2rem; margin: 1.4em 0 0.5em; }
  .doc p { margin: 0 0 1em; }
  .doc ul, .doc ol { margin: 0 0 1em; padding-left: 1.5em; }
  .doc li { margin: 0.25em 0; }
  .doc img { max-width: 100%; height: auto; }
  .doc table { border-collapse: collapse; width: 100%; margin: 1em 0; font-size: 0.95em; }
  .doc th, .doc td { border: 1px solid #cbd5e1; padding: 6px 10px; text-align: left; vertical-align: top; }
  .doc th { background: #f8fafc; font-weight: 600; }
  .doc a { color: #2563eb; }
  @media (max-width: 720px) {
    body { padding: 12px 8px 48px; }
    .doc { padding: 28px 24px; border-radius: 6px; }
  }
</style>
</head>
<body>
<article class="doc">
${bodyHtml || '<p style="color:#64748b">This document has no readable text content.</p>'}
</article>
</body>
</html>`
}
