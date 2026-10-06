const assert = require("node:assert/strict")
const test = require("node:test")
const { Readable } = require("node:stream")

const { freshRequire, stubModule } = require("./support/modules")

process.env.R2_ENDPOINT = "https://storage.invalid"
process.env.R2_ACCESS_KEY_ID = "local-test-key"
process.env.R2_SECRET_ACCESS_KEY = "local-test-secret"

// The S3 SDK is the network boundary: each test decides what the bucket answers.
const bucket = { requests: [], respond: async () => ({}) }

class Command {
  constructor(input) {
    this.input = input
  }
}
class GetObjectCommand extends Command {}
class ListObjectsV2Command extends Command {}

stubModule("@aws-sdk/client-s3", {
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand: Command,
  DeleteObjectsCommand: Command,
  S3Client: class {
    async send(command) {
      bucket.requests.push(command)
      return bucket.respond(command)
    }
  },
})

const { downloadTilesObject, listTilesObjectsBounded } = freshRequire("lib/storage/drawings-tiles-storage.ts")

test.beforeEach(() => {
  bucket.requests = []
  bucket.respond = async () => ({})
})

test("an object whose declared size exceeds the budget is refused and its stream closed", async () => {
  const body = Readable.from([Buffer.alloc(20)])
  bucket.respond = async () => ({ Body: body, ContentLength: 20 })

  await assert.rejects(
    downloadTilesObject({ supabase: {}, path: "org/sheet/fact.json", maxBytes: 10 }),
    /byte budget/,
  )
  assert.equal(body.destroyed, true)
})

test("streamed bytes enforce the budget when the declared size is missing or understated", async () => {
  for (const ContentLength of [undefined, 1]) {
    const body = Readable.from([Buffer.from("123456"), Buffer.from("7890")])
    bucket.respond = async () => ({ Body: body, ContentLength })

    await assert.rejects(
      downloadTilesObject({ supabase: {}, path: "org/sheet/fact.json", maxBytes: 8 }),
      /byte budget/,
    )
    assert.equal(body.destroyed, true, `ContentLength ${ContentLength}`)
  }
})

test("an object within budget downloads whole", async () => {
  bucket.respond = async () => ({ Body: Readable.from([Buffer.from("123456"), Buffer.from("7890")]) })

  const bytes = await downloadTilesObject({ supabase: {}, path: "org/sheet/fact.json" })

  assert.equal(bytes.toString(), "1234567890")
})

test("a listing is complete only when storage says it was not truncated", async () => {
  for (const IsTruncated of [true, undefined, false]) {
    bucket.respond = async () => ({
      Contents: [{ Key: "drawings-tiles/org/sheet/facts/fact.json", Size: 20 }],
      IsTruncated,
    })

    const result = await listTilesObjectsBounded({ supabase: {}, prefix: "org/sheet/facts/", limit: 129 })

    assert.equal(result.complete, IsTruncated === false, `IsTruncated ${IsTruncated}`)
    assert.deepEqual(result.objects, [{ name: "org/sheet/facts/fact.json", size: 20 }])
  }
  const [request] = bucket.requests
  assert.ok(request instanceof ListObjectsV2Command)
  assert.equal(request.input.Prefix, "drawings-tiles/org/sheet/facts/")
  assert.equal(request.input.MaxKeys, 129)
})

test("invalid list or byte budgets are refused before any storage request", async () => {
  for (const limit of [0, 1001, NaN, 1.5]) {
    await assert.rejects(listTilesObjectsBounded({ supabase: {}, prefix: "org/sheet/", limit }), /budget/)
  }
  for (const maxBytes of [0, -1, NaN, 1.5]) {
    await assert.rejects(
      downloadTilesObject({ supabase: {}, path: "org/sheet/fact.json", maxBytes }),
      /budget/,
    )
  }
  assert.equal(bucket.requests.length, 0)
})
