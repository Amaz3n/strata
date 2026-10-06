require("../scripts/register-ts-node-test");
const test = require("node:test"),
  assert = require("node:assert/strict"),
  Module = require("node:module"),
  { Readable } = require("node:stream");
process.env.R2_ENDPOINT = "https://storage.invalid";
process.env.R2_ACCESS_KEY_ID = "local-test-key";
process.env.R2_SECRET_ACCESS_KEY = "local-test-secret";
let handler,
  calls = 0;
class Command {
  constructor(input) {
    this.input = input;
  }
}
class GetObjectCommand extends Command {}
class ListObjectsV2Command extends Command {}
const load = Module._load;
Module._load = function (request, parent, main) {
  if (
    request === "@aws-sdk/client-s3" &&
    parent?.filename.endsWith("/lib/storage/drawings-tiles-storage.ts")
  )
    return {
      GetObjectCommand,
      ListObjectsV2Command,
      PutObjectCommand: Command,
      DeleteObjectsCommand: Command,
      S3Client: class {
        async send(c) {
          calls++;
          return handler(c);
        }
      },
    };
  return load.call(this, request, parent, main);
};
const {
  downloadTilesObject,
  listTilesObjectsBounded,
} = require("../lib/storage/drawings-tiles-storage");
Module._load = load;
test.beforeEach(() => {
  calls = 0;
});
test("oversized metadata rejects and closes the object stream before buffering", async () => {
  const body = Readable.from([Buffer.alloc(20)]);
  handler = async () => ({ Body: body, ContentLength: 20 });
  await assert.rejects(
    downloadTilesObject({
      supabase: {},
      path: "org/sheet/fact.json",
      maxBytes: 10,
    }),
    /byte budget/,
  );
  assert.equal(body.destroyed, true);
});
test("actual streamed bytes enforce the budget even when size metadata is absent or too small", async () => {
  for (const ContentLength of [undefined, 1]) {
    const body = Readable.from([Buffer.from("123456"), Buffer.from("7890")]);
    handler = async () => ({ Body: body, ContentLength });
    await assert.rejects(
      downloadTilesObject({
        supabase: {},
        path: "org/sheet/fact.json",
        maxBytes: 8,
      }),
      /byte budget/,
    );
    assert.equal(body.destroyed, true);
  }
  handler = async () => ({
    Body: Readable.from([Buffer.from("123456"), Buffer.from("7890")]),
  });
  assert.equal(
    (
      await downloadTilesObject({ supabase: {}, path: "org/sheet/fact.json" })
    ).toString(),
    "1234567890",
  );
});
test("short or missing-truncation listings never establish complete source history", async () => {
  for (const IsTruncated of [true, undefined, false]) {
    handler = async (c) => {
      assert.ok(c instanceof ListObjectsV2Command);
      assert.equal(c.input.MaxKeys, 129);
      assert.equal(c.input.Prefix, "drawings-tiles/org/sheet/facts/");
      return {
        Contents: [
          { Key: "drawings-tiles/org/sheet/facts/fact.json", Size: 20 },
        ],
        IsTruncated,
      };
    };
    const result = await listTilesObjectsBounded({
      supabase: {},
      prefix: "org/sheet/facts/",
      limit: 129,
    });
    assert.equal(result.complete, IsTruncated === false);
    assert.deepEqual(result.objects, [
      { name: "org/sheet/facts/fact.json", size: 20 },
    ]);
  }
});
test("invalid list or byte budgets fail before a storage request", async () => {
  handler = async () => {
    throw Error("Unexpected storage call");
  };
  for (const limit of [0, 1001, NaN, 1.5])
    await assert.rejects(
      listTilesObjectsBounded({ supabase: {}, prefix: "org/sheet/", limit }),
      /budget/,
    );
  for (const maxBytes of [0, -1, NaN, 1.5])
    await assert.rejects(
      downloadTilesObject({
        supabase: {},
        path: "org/sheet/fact.json",
        maxBytes,
      }),
      /budget/,
    );
  assert.equal(calls, 0);
});
