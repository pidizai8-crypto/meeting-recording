import { Buffer } from 'node:buffer'

const RATE = 16_000
const FRAME = 160 // 10 ms, only used to locate a cut after speaker evidence nominates it.
const WINDOW = 2 * RATE
const HOP = 1.35 * RATE
const MIN_TURN = 1.3 * RATE
const CONFIRM_WINDOW = 2.4 * RATE
const SEARCH_RADIUS = 0.65 * RATE

// CAM++ unit-vector cosine. The broad screen also admits windows straddling a change.
const SCREEN = 0.58
const DIFFERENT = 0.25
const SAME_SIDE = 0.50
const MARGIN = 0.15

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return NaN
  let dot = 0
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i]
  return dot
}

// Energy and short-lag autocorrelations provide timing cues independent of gain.
// The cumulative sums let every candidate reuse the same 10 ms measurements.
function frameProfile(bytes, samples) {
  const lags = [4, 12, 32]
  const sums = Array.from({ length: lags.length + 1 }, () => new Float64Array(Math.ceil(samples / FRAME) + 1))
  for (let start = 0, frame = 1; start < samples; start += FRAME, frame++) {
    const end = Math.min(start + FRAME, samples)
    let energy = 0
    for (let i = start; i < end; i++) energy += bytes.readInt16LE(i * 2) ** 2
    sums[0][frame] = sums[0][frame - 1] + energy / (end - start)
    for (const [k, lag] of lags.entries()) {
      let corr = 0
      for (let i = start + lag; i < end; i++) corr += bytes.readInt16LE(i * 2) * bytes.readInt16LE((i - lag) * 2)
      sums[k + 1][frame] = sums[k + 1][frame - 1] + corr / (energy || 1)
    }
  }
  const powers = Array.from(sums[0].subarray(1), (value, i) => value - sums[0][i])
  const sorted = powers.slice().sort((a, b) => a - b)
  const quiet = sorted[Math.floor(sorted.length * 0.70)] * 0.008
  const pauses = []
  for (let i = 0; i < powers.length;) {
    if (powers[i] > quiet) { i++; continue }
    const start = i++
    while (i < powers.length && powers[i] <= quiet) i++
    if (start > 0 && i < powers.length && i - start >= 6) {
      pauses.push({ center: (start + i) * FRAME / 2, seconds: (i - start) * FRAME / RATE })
    }
  }
  return { sums, pauses }
}

function locateBoundary({ sums, pauses }, estimate, samples, radius = SEARCH_RADIUS) {
  const first = Math.ceil(Math.max(MIN_TURN, estimate - radius) / FRAME)
  const last = Math.floor(Math.min(samples - MIN_TURN, estimate + radius) / FRAME)
  let best = Math.round(estimate), bestScore = -Infinity
  const [energy, ...features] = sums
  for (let i = first; i <= last; i++) {
    const middle = (energy[i + 2] - energy[i - 2]) / 4
    const before = (energy[i - 2] - energy[i - 16]) / 14
    const after = (energy[i + 16] - energy[i + 2]) / 14
    // Both flanks must support a dip. A sustained drop in level alone is not a pause.
    const dip = Math.max(0, 1 - (middle + 1) / (Math.min(before, after) + 1))
    let change = 0
    for (const feature of features) {
      const difference = (feature[i + 9] - 2 * feature[i] + feature[i - 9]) / 9
      change += difference ** 2
    }
    const distance = Math.abs(i * FRAME - estimate) / radius
    // One cue is enough. A distant syllable gap often has both a dip and a
    // spectral change and would win twice if these scores were added together.
    const score = Math.max(dip, 0.85 * Math.min(1, Math.sqrt(change))) - 1.25 * distance
    if (score > bestScore) { bestScore = score; best = i * FRAME }
  }
  // A 100–300 ms pause can have no energy at either immediate flank. Score
  // its interior directly so the first phoneme after the pause stays intact.
  for (const { center, seconds } of pauses) {
    if (center < first * FRAME || center > last * FRAME) continue
    const score = 1 + Math.min(1.3, seconds * 4) - 1.25 * Math.abs(center - estimate) / radius
    if (score > bestScore) { bestScore = score; best = center }
  }
  return best
}

// Interpolate the affinities of a mixed middle window. Two staggered windows
// may both straddle a change. If both lack embeddings, bridge to the next one.
function proposals(windows, profile, samples) {
  const result = []
  for (let i = 0; i < windows.length - 1; i++) {
    const left = windows[i]
    if (!left.embedding) continue
    const reach = !windows[i + 1]?.embedding && !windows[i + 2]?.embedding ? 3 : 2
    for (let j = i + 1; j <= Math.min(i + reach, windows.length - 1); j++) {
      const right = windows[j]
      const between = cosine(left.embedding, right.embedding)
      if (!(between < SCREEN)) continue
      let estimate = (left.center + right.center) / 2
      if (j === i + 2 && windows[i + 1].embedding) {
        const mid = windows[i + 1]
        const balance = cosine(mid.embedding, left.embedding) - cosine(mid.embedding, right.embedding)
        const gap = 1 - between
        const edge = balance > 0 ? right.center : left.center
        estimate = mid.center + (edge - mid.center) * Math.abs(balance) / (gap + Math.abs(balance))
      }
      if (estimate < MIN_TURN - SEARCH_RADIUS || estimate > samples - MIN_TURN + SEARCH_RADIUS) continue
      const sample = locateBoundary(profile, estimate, samples)
      result.push({ sample, left, right, between })
    }
  }
  return result.sort((a, b) => a.between - b.between)
}

function confirmsChange(left, right, before, after) {
  const leftFit = cosine(before, left), rightFit = cosine(after, right)
  const leftCross = cosine(before, right), rightCross = cosine(after, left)
  if (!(leftFit >= SAME_SIDE && rightFit >= SAME_SIDE &&
        leftFit - leftCross >= MARGIN && rightFit - rightCross >= MARGIN)) return false
  const near = cosine(before, after)
  if (near < DIFFERENT) return true
  // Some distinct voices still score above the single-pair threshold. Require
  // both local crops to match their own anchors and four consistently lower
  // cross-speaker scores. A single ambiguous comparison cannot propose a cut.
  const anchor = cosine(left, right)
  const highestCross = Math.max(anchor, near, leftCross, rightCross)
  const within = Math.min(leftFit, rightFit)
  return within >= 0.72 && within - highestCross >= 0.27 && highestCross < 0.55 &&
    (anchor + near + leftCross + rightCross) / 4 < 0.465
}

function meanEmbedding(evidence) {
  if (!evidence.length) return null
  const sum = Array.from(evidence[0])
  for (let i = 1; i < evidence.length; i++) {
    for (let j = 0; j < sum.length; j++) sum[j] += evidence[i][j]
  }
  const norm = Math.sqrt(sum.reduce((power, value) => power + value * value, 0))
  return norm ? sum.map(value => value / norm) : null
}

/**
 * Split 16 kHz mono s16le bytes into contiguous, half-open sample ranges.
 * extract receives a zero-copy Buffer view and the caller's signal and returns
 * a unit speaker vector or null. Errors and cancellation propagate to the caller.
 */
export async function splitSpeakerTurns(pcm, extract, signal) {
  signal?.throwIfAborted()
  if (!(pcm instanceof Uint8Array) || pcm.byteLength % 2) throw new TypeError('Expected complete s16le PCM samples')
  const bytes = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength)
  const samples = bytes.length / 2
  if (!samples) return []

  const evidence = new Map()
  async function measure(start, end) {
    const key = `${start}:${end}`
    if (evidence.has(key)) return evidence.get(key)
    signal?.throwIfAborted()
    const embedding = await extract(bytes.subarray(start * 2, end * 2), signal)
    signal?.throwIfAborted()
    const item = { start, end, center: (start + end) / 2, embedding }
    evidence.set(key, item)
    return item
  }

  if (samples < RATE || !bytes.some(byte => byte !== 0)) return [{ startSample: 0, endSample: samples, embedding: null }]
  if (samples < 2 * MIN_TURN) return [{ startSample: 0, endSample: samples, embedding: (await measure(0, samples)).embedding }]

  const width = Math.min(WINDOW, Math.floor(samples / 2))
  const steps = Math.ceil((samples - width) / HOP)
  const windows = []
  for (let i = 0; i <= steps; i++) {
    const start = Math.round(i * (samples - width) / steps)
    windows.push(await measure(start, start + width))
  }
  const profile = frameProfile(bytes, samples)
  const cuts = [], tried = []
  // Each extra pair must confirm both sides near the cut. Bound work even if
  // the model returns unstable embeddings throughout a noisy recording.
  const pairBudget = Math.ceil(samples / WINDOW)
  for (const { sample, left, right } of proposals(windows, profile, samples)) {
    if (tried.length >= pairBudget) break
    if (tried.some(other => Math.abs(other - sample) < 0.40 * RATE)) continue
    if (cuts.some(other => Math.abs(other.sample - sample) < MIN_TURN)) continue
    tried.push(sample)
    const before = await measure(Math.max(0, sample - CONFIRM_WINDOW), sample)
    const after = await measure(sample, Math.min(samples, sample + CONFIRM_WINDOW))
    if (confirmsChange(left.embedding, right.embedding, before.embedding, after.embedding)) {
      cuts.push({ sample, before: before.embedding, after: after.embedding })
    }
  }

  cuts.sort((a, b) => a.sample - b.sample)
  const boundaries = [0]
  for (const [i, { sample, before, after }] of cuts.entries()) {
    let cut = sample
    if (!profile.pauses.some(pause => pause.center === sample)) {
      // A 1.6 s window centered on the proposed cut estimates contamination
      // from either side. Avoid moving a cut that already lies in a pause.
      const probe = await measure(sample - 0.8 * RATE, sample + 0.8 * RATE)
      const balance = cosine(probe.embedding, before) - cosine(probe.embedding, after)
      if (Math.abs(balance) > 0.12) {
        const fraction = Math.max(-1, Math.min(1, balance / (1 - cosine(before, after))))
        const target = sample + fraction * 0.6 * RATE
        const adjusted = locateBoundary(profile, target, samples, 0.16 * RATE)
        if (adjusted - boundaries.at(-1) >= MIN_TURN && (cuts[i + 1]?.sample ?? samples) - adjusted >= MIN_TURN) cut = adjusted
      }
    }
    boundaries.push(cut)
  }

  const turns = []
  let start = 0
  for (const end of [...boundaries.slice(1), samples]) {
    const inside = [...evidence.values()].filter(item => item.embedding && item.start >= start && item.end <= end)
    let embedding = meanEmbedding(inside.map(item => item.embedding))
    if (!embedding) embedding = (await measure(start, end)).embedding
    turns.push({ startSample: start, endSample: end, embedding })
    start = end
  }
  return turns
}
