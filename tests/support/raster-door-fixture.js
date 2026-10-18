const {extractRasterPlanEvidence}=require('../../lib/drawings/raster-plan-evidence')
const {sourceWallNetwork}=require('../../lib/drawings/vector-wall-network')
function fixture(options = {}) {
  const width = 600,
    height = 600,
    pixels = new Uint8Array(width * height).fill(255);
  const draw = (a, b, thick = 1) => {
    const n = Math.ceil(Math.max(Math.abs(b[0] - a[0]), Math.abs(b[1] - a[1])));
    for (let i = 0; i <= n; i++) {
      const x = Math.round(a[0] + ((b[0] - a[0]) * i) / n),
        y = Math.round(a[1] + ((b[1] - a[1]) * i) / n);
      for (let dx = 0; dx < thick; dx++)
        for (let dy = 0; dy < thick; dy++)
          if (x + dx >= 0 && y + dy >= 0 && x + dx < width && y + dy < height)
            pixels[(y + dy) * width + x + dx] = 0;
    }
  };
  for (const [a, b] of [
    [
      [150, 60],
      [520, 60],
    ],
    [
      [150, 80],
      [520, 80],
    ],
    [
      [500, 60],
      [500, 540],
    ],
    [
      [520, 60],
      [520, 540],
    ],
    [
      [150, 520],
      [520, 520],
    ],
    [
      [150, 540],
      [520, 540],
    ],
    [
      [150, 60],
      [150, 220],
    ],
    [
      [170, 60],
      [170, 220],
    ],
    [
      [150, 350],
      [150, 540],
    ],
    [
      [170, 350],
      [170, 540],
    ],
    [
      [400, 300],
      [500, 300],
    ],
    [
      [400, 320],
      [500, 320],
    ],
  ])
    draw(a, b, 2);
  if (!options.unfilledWalls) for (let x = 170; x < 500; x += 10) {
    draw([x, 60], [x, 80]);
    draw([x, 520], [x, 540]);
  }
  if (!options.unfilledWalls) for (let y = 80; y < 520; y += 10) {
    draw([500, y], [520, y]);
    if (y < 215 || y > 355) draw([150, y], [170, y]);
  }
  if (!options.unfilledWalls) for (let x = 400; x < 500; x += 10) draw([x, 300], [x, 320]);
  if (!options.noJamb) {
    draw([150, 219], [170, 219], 2);
    draw([150, 350], [170, 350], 2);
  }
  if (!options.noLeaf) {
    draw([23, 220], [151, 220]);
    draw([23, 224], [151, 224]);
    if (!options.noEndCap) draw([23, 220], [23, 224]);
  }
  if (!options.noArc)
    for (let i = 0; i <= 1000; i++) {
      const angle = Math.PI / 2 + ((Math.PI / 2) * i) / 1000,
        x = Math.round(151 + 128 * Math.cos(angle)),
        y = Math.round(222 + 128 * Math.sin(angle));
      pixels[y * width + x] = 0;
    }
  const evidence = extractRasterPlanEvidence({
    pixels,
    width,
    height,
    feetPerPixel: 0.02,
    region: { x0: 0, y0: 0, x1: 1, y1: 1 },
  });
  const textRuns = [{ text: "BATH", x: 0.45, y: 0.6, w: 0.08, h: 0.03 }],
    network = sourceWallNetwork({ evidence, sx: 12, sy: 12, textRuns });
  const args = {
    evidence,
    sx: 12,
    sy: 12,
    wallBodies: network.bodies,
    pathKinds: new Map(),
  };
  return {
    rasterInput: {
      pixels,
      width,
      height,
      feetPerPixel: 0.02,
      region: { x0: 0, y0: 0, x1: 1, y1: 1 },
    },
    evidence,
    args,
    input: {
      imageWidth: width,
      imageHeight: height,
      feetPerImagePx: 0.02,
      segments: [],
      textRuns,
      evidence,
      region: { x0: 0, y0: 0, x1: 1, y1: 1 },
      finishPolicy: "include-fixtures",
    },
  };
}
module.exports={fixture}
