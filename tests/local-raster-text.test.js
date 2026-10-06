require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict");
const sharp = require("sharp");
const {
  recognizeLocalRasterText,
} = require("../lib/services/local-raster-text");
test("local OCR reads supplied pixels with the bundled model", async () => {
  const image = await sharp(
    Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="800" height="220"><rect width="800" height="220" fill="white"/><text x="70" y="130" font-family="Arial" font-size="70" fill="black">BEDROOM</text></svg>',
    ),
  )
    .png()
    .toBuffer();
  const lines = await recognizeLocalRasterText(image);
  assert.ok(
    lines.some((l) => l.text.trim() === "BEDROOM" && l.confidence >= 70),
  );
  assert.ok(
    lines.every(
      (l) =>
        l.bbox.x0 >= 0 &&
        l.bbox.x1 <= 800 &&
        l.bbox.y0 >= 0 &&
        l.bbox.y1 <= 220,
    ),
  );
});
test("malformed source pixels return a bounded failure", async () => {
  await assert.rejects(
    recognizeLocalRasterText(Buffer.from("not an image"), 2000),
    /OCR/,
  );
});
test("a hard time budget stops OCR initialization without returning guessed text", async () => {
  await assert.rejects(
    recognizeLocalRasterText(Buffer.from("not an image"), 1),
    /time budget/,
  );
  await assert.rejects(recognizeLocalRasterText(Buffer.alloc(0)), /Invalid/);
});

test("concurrent OCR requests respect capacity and deadline failures", async () => {
  const pending = Array.from({ length: 10 }, () =>
    recognizeLocalRasterText(Buffer.from("not an image"), 1),
  );
  const results = await Promise.allSettled(pending);
  assert.ok(
    results.every(
      (r) =>
        r.status === "rejected" &&
        /time budget|capacity/.test(r.reason.message),
    ),
  );
  assert.ok(
    results.some(
      (r) => r.status === "rejected" && /capacity/.test(r.reason.message),
    ),
  );
  const blank = await sharp({
    create: { width: 100, height: 100, channels: 3, background: "#ffffff" },
  })
    .png()
    .toBuffer();
  // The caller deadline can expire before the killed child emits close. The
  // capacity slot must remain occupied until that process actually terminates.
  // Check bounded recovery rather than assuming both events share a tick.
  const recoveryDeadline = Date.now() + 2000;
  for (;;) {
    try {
      assert.deepEqual(await recognizeLocalRasterText(blank, 2000), []);
      break;
    } catch (error) {
      if (!/capacity/.test(error.message) || Date.now() >= recoveryDeadline)
        throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
});
