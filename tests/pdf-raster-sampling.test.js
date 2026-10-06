require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  sharp = require("sharp");
const {
  assessPdfRasterSampling,
  inspectPdfRasterSampling,
  validPdfRasterSampling,
} = require("../lib/drawings/pdf-raster-sampling");
const full = { x0: 0, y0: 0, x1: 1, y1: 1 },
  image = {
    width: 3000,
    height: 1500,
    matrix: [720, 0, 0, 360, 20, 40],
    opaqueUnclipped: true,
  };
test("native density comes from embedded pixels and physical transforms, including page origin and rotation", () => {
  for (const [bounds, source] of [
    [[20, 40, 740, 400], image],
    [[20, 40, 380, 760], { ...image, matrix: [0, 720, -360, 0, 380, 40] }],
  ]) {
    const sample = assessPdfRasterSampling(bounds, full, [source]);
    assert.equal(sample.kind, "native-raster");
    assert.ok(Math.abs(sample.minimumSourceDpi - 300) < 1e-9);
    assert.ok(Math.abs(sample.renderScale - 300 / 72) < 1e-9);
    assert.equal(validPdfRasterSampling(sample), true);
  }
});
test("unequal pixel spacing retains the lower density and warns instead of selecting the sharper axis", () => {
  const sample = assessPdfRasterSampling([20, 40, 740, 400], full, [
    { ...image, width: 6000 },
  ]);
  assert.equal(sample.minimumSourceDpi, 300);
  assert.equal(sample.maximumSourceDpi, 600);
  assert.ok(sample.warnings.some((w) => /unequal/.test(w)));
});
test("low resolution and processing caps do not manufacture source detail", () => {
  const low = assessPdfRasterSampling([20, 40, 740, 400], full, [
    { ...image, width: 1000, height: 500 },
  ]);
  assert.equal(low.minimumSourceDpi, 100);
  assert.ok(low.warnings.some((w) => /below 200/.test(w)));
  assert.equal(low.renderScale, 100 / 72);
  const high = assessPdfRasterSampling([20, 40, 740, 400], full, [
    { ...image, width: 9000, height: 4500 },
  ]);
  assert.equal(high.minimumSourceDpi, 900);
  assert.equal(high.renderScale, 600 / 72);
  assert.ok(high.warnings.some((w) => /600 DPI/.test(w)));
});
test("partial, clipped, overlaid, sheared and absent images cannot qualify an entire view", () => {
  for (const images of [
    [],
    [{ ...image, opaqueUnclipped: false }],
    [image, image],
    [{ ...image, matrix: [360, 0, 0, 360, 20, 40] }],
    [{ ...image, matrix: [720, 0, 360, 360, 20, 40] }],
  ]) {
    const sample = assessPdfRasterSampling([20, 40, 740, 400], full, images);
    assert.equal(sample.kind, "unverified");
    assert.equal(sample.minimumSourceDpi, null);
    assert.ok(sample.warnings.some((w) => /unverified/.test(w)));
  }
  const local = assessPdfRasterSampling(
    [20, 40, 740, 400],
    { x0: 0.1, y0: 0.1, x1: 0.4, y1: 0.4 },
    [{ ...image, width: 1500, matrix: [360, 0, 0, 360, 20, 40] }],
  );
  assert.equal(local.kind, "native-raster");
});
test("sampling metadata and processing budgets reject corrupt values", () => {
  const sample = assessPdfRasterSampling([20, 40, 740, 400], full, [image]);
  for (const bad of [
    null,
    { ...sample, minimumSourceDpi: null },
    { ...sample, kind: "unverified" },
    { ...sample, renderScale: 100 },
    { ...sample, warnings: [null] },
  ])
    assert.equal(validPdfRasterSampling(bad), false);
  assert.throws(
    () => assessPdfRasterSampling([0, 0, 0, 1], full, [image]),
    /frame/,
  );
  assert.throws(
    () => assessPdfRasterSampling([0, 0, 1, 1], full, Array(4097).fill(image)),
    /frame/,
  );
});
test("real PDF image sampling follows rotated crop frames and detects clipping", async () => {
  const {
      PDFDocument,
      degrees,
      pushGraphicsState,
      popGraphicsState,
      rectangle,
      clip,
      endPath,
    } = require("pdf-lib"),
    m = await import("mupdf");
  const pixels = await sharp({
    create: { width: 600, height: 300, channels: 3, background: "white" },
  })
    .png()
    .toBuffer();
  for (const clipped of [false, true])
    for (const rotation of [0, 90]) {
      const pdf = await PDFDocument.create(),
        p = pdf.addPage([144, 72]),
        embedded = await pdf.embedPng(pixels);
      p.setRotation(degrees(rotation));
      if (clipped)
        p.pushOperators(
          pushGraphicsState(),
          rectangle(0, 0, 72, 72),
          clip(),
          endPath(),
        );
      p.drawImage(embedded, { x: 0, y: 0, width: 144, height: 72 });
      if (clipped) p.pushOperators(popGraphicsState());
      const doc = m.Document.openDocument(await pdf.save(), "application/pdf"),
        page = doc.loadPage(0);
      try {
        const sample = inspectPdfRasterSampling(m, page, full);
        assert.equal(sample.kind, clipped ? "unverified" : "native-raster");
        if (!clipped) assert.ok(Math.abs(sample.minimumSourceDpi - 300) < 1e-6);
      } finally {
        page.destroy();
        doc.destroy();
      }
    }
});
