require("../scripts/register-ts-node-test")

const assert = require("node:assert/strict")
const test = require("node:test")

const { preservesNativeRecognitionDensity } = require("../lib/drawings/recognition-image-source")

test("native density is preserved only when the render reaches every source sample", () => {
  const scan = (minimumSourceDpi, maximumSourceDpi) => ({
    kind: "native-raster",
    minimumSourceDpi,
    maximumSourceDpi,
  })

  assert.equal(preservesNativeRecognitionDensity(scan(700, 700), 600), false, "capped below the source")
  assert.equal(preservesNativeRecognitionDensity(scan(300, 600), 300), false, "anisotropic source")
  assert.equal(preservesNativeRecognitionDensity(scan(300, 300), 300), true)
})
