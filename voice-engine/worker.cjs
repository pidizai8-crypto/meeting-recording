const { createHash } = require('node:crypto')
const { readFileSync } = require('node:fs')
const { dirname, join } = require('node:path')

const SAMPLE_RATE = 16000
const DIMENSION = 192
const FRAME = 512

function model(name, sha256) {
  const path = join(__dirname, name)
  if (createHash('sha256').update(readFileSync(path)).digest('hex') !== sha256) {
    throw new Error(`Model checksum failed (${name})`)
  }
  return path
}

function load() {
  const anchors = [__dirname, dirname(process.argv[2])]
  if (process.env.DSH_INSTALL_DIR) anchors.push(process.env.DSH_INSTALL_DIR)
  const sherpa = require(require.resolve('sherpa-onnx-node', { paths: anchors }))
  const embedding = new sherpa.SpeakerEmbeddingExtractor({
    model: model('campplus-zh-en-fp16.onnx', '62eb2d79d363c1fd5ee093a4b0dcb5470d5ad3b7452612b67cce9b89f36c8ef3'),
    numThreads: 2, provider: 'cpu', debug: 0,
  })
  if (embedding.dim !== DIMENSION) throw new Error('Unexpected CAM++ embedding dimension')
  const detector = new sherpa.Vad({
    sileroVad: {
      model: model('silero-vad.onnx', '2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f'),
      threshold: 0.45, windowSize: FRAME, minSpeechDuration: 0.15, minSilenceDuration: 0.18, maxSpeechDuration: 30,
    }, sampleRate: SAMPLE_RATE, numThreads: 1, provider: 'cpu', debug: 0,
  }, 32)

  return pcm => {
    const bytes = new DataView(pcm.buffer, pcm.byteOffset, pcm.byteLength)
    const count = bytes.byteLength / 2
    const samples = new Float32Array(Math.ceil(count / FRAME) * FRAME)
    for (let i = 0; i < count; i++) samples[i] = bytes.getInt16(i * 2, true) / 32768
    detector.reset()
    for (let i = 0; i < count; i += FRAME) detector.acceptWaveform(samples.subarray(i, i + FRAME))
    detector.flush()
    const stream = embedding.createStream()
    let speechSamples = 0
    while (!detector.isEmpty()) {
      // Desktop Electron requires copied buffers for native outputs.
      const segment = detector.front(false)
      detector.pop()
      const size = Math.min(segment.samples.length, count - segment.start)
      if (size > 0) {
        speechSamples += size
        stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples: segment.samples.subarray(0, size) })
      }
    }
    if (speechSamples < SAMPLE_RATE * 0.8) return null
    stream.inputFinished()
    if (!embedding.isReady(stream)) return null
    const vector = embedding.compute(stream, false)
    if (vector.length !== DIMENSION) return null
    const norm = Math.hypot(...vector)
    return norm > 1e-8 && Number.isFinite(norm) ? Array.from(vector, value => value / norm) : null
  }
}

let extract
process.on('message', pcm => {
  try {
    extract ??= load()
    process.send({ embedding: extract(Buffer.from(pcm, 'base64')) })
  } catch (error) {
    process.send({ error: error.message })
  }
})
process.on('disconnect', () => process.exit(0))
