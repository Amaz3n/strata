#!/usr/bin/env node
require('./register-ts-node-test')
const fs = require('node:fs')
const { replayAreaDetection } = require('../lib/drawings/area-replay')
const [source, output, mode] = process.argv.slice(2)
if (!source || !output) throw Error('Usage: node scripts/replay-area-takeoff.js replay.json result.json')
if (mode && mode !== '--compare-current') throw Error('Unknown mode; use --compare-current for a non-exact engine comparison.')
replayAreaDetection(JSON.parse(fs.readFileSync(source, 'utf8')), { compareCurrentEngine: mode === '--compare-current' }).then(result => {
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ areas: result.detection.proposals.length, recognition: result.recognition, replay: result.replay, output }))
}).catch(error => { console.error(error.message); process.exitCode = 1 })
