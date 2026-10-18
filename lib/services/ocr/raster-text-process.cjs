/* Private, bounded child process. Model/code come from pinned local packages;
 * images and OCR results stay in local IPC. No language download or telemetry. */
const fs = require("node:fs");
const path = require("node:path");
const { createWorker, OEM, PSM } = require("tesseract.js");
const english = require("@tesseract.js-data/eng");
process.once("message", async ({ image }) => {
  let worker;
  try {
    fs.accessSync(path.join(english.langPath, "eng.traineddata.gz"));
    worker = await createWorker("eng", OEM.LSTM_ONLY, {
      langPath: english.langPath,
      gzip: true,
      cacheMethod: "none",
      errorHandler: () => {},
    });
    await worker.setParameters({ tessedit_pageseg_mode: PSM.SPARSE_TEXT });
    const result = await worker.recognize(
      Buffer.from(image),
      {},
      { blocks: true },
    );
    const lines = (result.data.blocks ?? []).flatMap((block) =>
      block.paragraphs.flatMap((paragraph) =>
        paragraph.lines.map(({ text, confidence, bbox }) => ({
          text,
          confidence,
          bbox,
        })),
      ),
    );
    await worker.terminate();
    worker = null;
    process.send({ lines }, () => process.exit(0));
  } catch {
    if (worker) await worker.terminate().catch(() => {});
    process.send(
      { error: "Local OCR could not process this source window." },
      () => process.exit(1),
    );
  }
});
