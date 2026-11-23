import assert from 'node:assert/strict'
import { test } from 'node:test'
import { splitSpeakerTurns } from '../speaker-turns.js'

const RATE = 16_000
const samples = seconds => Math.round(seconds * RATE)
const A = 200, B = 500, C = 900

function tone(seconds, frequency, gain = 0.4) {
  const pcm = Buffer.alloc(samples(seconds) * 2)
  for (let i = 0; i < pcm.length / 2; i++) {
    pcm.writeInt16LE(Math.round(32767 * gain * Math.sin(2 * Math.PI * frequency * i / RATE)), i * 2)
  }
  return pcm
}

// A deterministic model double labels non-silent 20 ms frames by tone, then
// normalizes their counts. Straddling a transition returns a mixed embedding.
function toneEmbedding(pcm) {
  const counts = [0, 0, 0]
  for (let start = 0; start + 640 <= pcm.length; start += 640) {
    let crossings = 0, peak = 0, previous = 0
    for (let j = start; j < start + 640; j += 2) {
      const value = pcm.readInt16LE(j)
      if (value > 0 && previous <= 0) crossings++
      previous = value
      peak = Math.max(peak, Math.abs(value))
    }
    if (peak > 100) counts[crossings < 7 ? 0 : crossings < 15 ? 1 : 2]++
  }
  const norm = Math.hypot(...counts)
  return norm ? counts.map(n => n / norm) : null
}

function checkTurns(pcm, turns, expectedSpeakers) {
  assert.equal(turns.length, expectedSpeakers.length, JSON.stringify(turns.map(t => t.endSample / RATE)))
  let next = 0
  for (const [i, { startSample, endSample, embedding }] of turns.entries()) {
    assert.equal(startSample, next)
    assert.ok(endSample > startSample && Number.isInteger(endSample))
    assert.ok(Math.abs(Math.hypot(...embedding) - 1) < 1e-6)
    assert.ok(embedding[expectedSpeakers[i]] > 0.9, JSON.stringify(embedding))
    next = endSample
  }
  assert.equal(next, pcm.length / 2)
}

test('empty, sub-second and digital silence need no inference', async () => {
  const unused = () => assert.fail('unexpected inference')
  assert.deepEqual(await splitSpeakerTurns(Buffer.alloc(0), unused), [])
  for (const pcm of [tone(0.39, A), tone(12, 0), Buffer.alloc(2)]) {
    assert.deepEqual(await splitSpeakerTurns(pcm, unused), [{ startSample: 0, endSample: pcm.length / 2, embedding: null }])
  }
  await assert.rejects(splitSpeakerTurns(Buffer.alloc(3), unused), /s16le/)
})

test('a short Uint8Array view preserves byte offsets, signal and the full last sample', async () => {
  const input = tone(1.2345, B)
  const backing = Buffer.concat([Buffer.from([255]), input, Buffer.from([255])])
  const view = new Uint8Array(backing.buffer, backing.byteOffset + 1, input.length)
  const signal = new AbortController().signal
  let calls = 0
  const turns = await splitSpeakerTurns(view, (crop, received) => {
    assert.equal(received, signal)
    assert.deepEqual(crop, input)
    calls++
    return toneEmbedding(crop)
  }, signal)
  assert.equal(calls, 1)
  checkTurns(input, turns, [1])
})

test('the same speaker stays together over syllable gaps and changes in level', async () => {
  const pcm = Buffer.concat(Array.from({ length: 12 }, (_, i) =>
    Buffer.concat([tone(0.86, A, i % 2 ? 0.65 : 0.08), tone(0.14, 0)])))
  let calls = 0
  const turns = await splitSpeakerTurns(pcm, crop => { calls++; return toneEmbedding(crop) })
  assert.ok(calls <= 9, `${calls} inferences for 12 s of one speaker`)
  checkTurns(pcm, turns, [0])
})

test('a brief pause is retained and the split falls inside it', async () => {
  const pcm = Buffer.concat([tone(3.67, A), tone(0.09, 0), tone(3.14, B)])
  const turns = await splitSpeakerTurns(pcm, toneEmbedding)
  checkTurns(pcm, turns, [0, 1])
  assert.ok(turns[0].endSample >= samples(3.67) && turns[0].endSample <= samples(3.76))
})

test('uninterrupted changes can be found away from regular window boundaries', async () => {
  for (const [first, second] of [[1.55, 1.75], [2.1, 6.9], [4.17, 5.42], [8.1, 2.3]]) {
    const pcm = Buffer.concat([tone(first, A), tone(second, B)])
    const turns = await splitSpeakerTurns(pcm, toneEmbedding)
    checkTurns(pcm, turns, [0, 1])
    assert.ok(Math.abs(turns[0].endSample - samples(first)) <= samples(0.13), `cut at ${turns[0].endSample / RATE}, expected ${first}`)
  }
})

test('a returning voice and consecutive new voices receive separate ranges', async () => {
  for (const [lastVoice, expected] of [[A, 0], [C, 2]]) {
    const pcm = Buffer.concat([tone(3.71, A), tone(2.57, B), tone(5.72, lastVoice)])
    let calls = 0, active = 0
    const turns = await splitSpeakerTurns(pcm, async crop => {
      assert.equal(++active, 1)
      calls++
      await Promise.resolve()
      active--
      return toneEmbedding(crop)
    })
    checkTurns(pcm, turns, [0, 1, expected])
    assert.ok(Math.abs(turns[0].endSample - samples(3.71)) <= samples(0.13))
    assert.ok(Math.abs(turns[1].endSample - samples(6.28)) <= samples(0.13))
    assert.ok(calls <= 15, `${calls} inferences for two changes in 12 s`)
  }
})

test('an isolated unstable window and unavailable embeddings do not create speakers', async () => {
  const pcm = tone(9, A)
  let calls = 0
  const turns = await splitSpeakerTurns(pcm, crop => ++calls === 3 ? [0, 1, 0] : toneEmbedding(crop))
  checkTurns(pcm, turns, [0])
  assert.deepEqual(await splitSpeakerTurns(pcm, () => null), [{ startSample: 0, endSample: pcm.length / 2, embedding: null }])
})

test('a missing mixed window still permits corroborated evidence on both sides', async () => {
  const pcm = Buffer.concat([tone(4, A), tone(4, B)])
  const turns = await splitSpeakerTurns(pcm, crop => {
    const vector = toneEmbedding(crop)
    return vector[0] > 0.2 && vector[1] > 0.2 ? null : vector
  })
  checkTurns(pcm, turns, [0, 1])
})

test('cancellation before and during inference, and extractor errors, propagate', async () => {
  const pcm = tone(5, A)
  const controller = new AbortController()
  const reason = new Error('capture stopped')
  let calls = 0
  await assert.rejects(splitSpeakerTurns(pcm, async (crop, signal) => {
    assert.equal(signal, controller.signal)
    calls++
    controller.abort(reason)
    return toneEmbedding(crop)
  }, controller.signal), e => e === reason)
  await assert.rejects(splitSpeakerTurns(pcm, () => calls++, controller.signal), e => e === reason)
  assert.equal(calls, 1)
  const failure = new Error('model failed')
  await assert.rejects(splitSpeakerTurns(pcm, () => { throw failure }), e => e === failure)
})
