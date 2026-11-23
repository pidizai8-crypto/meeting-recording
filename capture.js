// Browser-only ESM. Importing the module never opens a device or AudioContext.
const PCM_RATE = 16000
const FRAME = 320 // 20 ms at 16 kHz
const RECORDER_CHUNK = 64 * 1024
const PRE_ROLL = 8, POST_ROLL = 6, RELEASE = 24, MAX_FRAMES = 600

// Windowed-sinc resampling keeps its phase across render blocks. The small
// lookahead is zero-padded at stop so the last real samples are delivered.
class PcmResampler {
  constructor(rate, sample) {
    this.ratio = rate / PCM_RATE
    this.sample = sample
    this.total = this.written = 0
    this.tail = new Float32Array(0)
    this.radius = Math.ceil(8 * Math.max(1, this.ratio))
    const cutoff = 0.92 / Math.max(1, this.ratio)
    this.kernels = Array.from({ length: 64 }, (_, phase) => {
      const taps = new Float32Array(2 * this.radius)
      let sum = 0
      for (let k = 0; k < taps.length; k++) {
        const t = k - this.radius + 1 - phase / 64
        const a = Math.PI * t * cutoff
        taps[k] = cutoff * (a ? Math.sin(a) / a : 1) * (0.5 + 0.5 * Math.cos(Math.PI * t / this.radius))
        sum += taps[k]
      }
      return taps.map(value => value / sum)
    })
  }
  push(block, final = false) {
    if (this.ratio === 1) {
      for (const value of block) this.sample(value)
      return
    }
    const first = this.total - this.tail.length
    const data = new Float32Array(this.tail.length + block.length)
    data.set(this.tail)
    data.set(block, this.tail.length)
    this.total += block.length
    const count = Math.round(this.total / this.ratio)
    while (this.written < count) {
      const position = this.written * this.ratio
      const center = Math.floor(position)
      if (!final && center + this.radius >= this.total) break
      const taps = this.kernels[Math.floor((position - center) * 64)]
      const offset = center - this.radius + 1 - first
      let value = 0
      for (let k = Math.max(0, -offset); k < Math.min(taps.length, data.length - offset); k++) {
        value += data[offset + k] * taps[k]
      }
      this.sample(value)
      this.written++
    }
    this.tail = data.slice(Math.max(0, Math.floor(this.written * this.ratio) - this.radius + 1 - first))
  }
}

// Pitch and spectral power help the capture gate keep quiet voiced frames.
class VoiceFeatures {
  constructor() {
    this.length = 512
    this.real = new Float32Array(this.length)
    this.imag = new Float32Array(this.length)
    this.cos = new Float32Array(this.length / 2)
    this.sin = new Float32Array(this.length / 2)
    this.order = new Uint16Array(this.length)
    this.window = Float32Array.from({ length: FRAME }, (_, i) => 0.5 - 0.5 * Math.cos(i * 2 * Math.PI / (FRAME - 1)))
    for (let i = 0; i < this.length; i++) {
      this.order[i] = (this.order[i >> 1] >> 1) | ((i & 1) * this.length / 2)
      if (i < this.cos.length) {
        this.cos[i] = Math.cos(-2 * Math.PI * i / this.length)
        this.sin[i] = Math.sin(-2 * Math.PI * i / this.length)
      }
    }
    this.decimated = new Float32Array(FRAME / 2)
    this.correlation = new Float32Array(108)
  }
  spectrum(samples) {
    const { length, real, imag, cos, sin, order } = this
    real.fill(0)
    imag.fill(0)
    for (let i = 0; i < samples.length; i++) real[order[i]] = samples[i] * this.window[i]
    for (let width = 2; width <= length; width *= 2) {
      const half = width / 2
      for (let base = 0; base < length; base += width) {
        for (let j = 0; j < half; j++) {
          const k = j * length / width, a = base + j, b = a + half
          const x = real[b] * cos[k] - imag[b] * sin[k]
          const y = real[b] * sin[k] + imag[b] * cos[k]
          real[b] = real[a] - x
          imag[b] = imag[a] - y
          real[a] += x
          imag[a] += y
        }
      }
    }
    const bands = [0, 0, 0, 0, 0, 0, 0]
    const ends = [250, 500, 1000, 2000, 3500, 5500, 8000]
    let band = 0, total = 1e-12
    for (let i = 2; i < length / 2; i++) {
      if (i * PCM_RATE / length >= ends[band]) band++
      const power = real[i] * real[i] + imag[i] * imag[i]
      bands[band] += power
      total += power
    }
    return bands.map(power => Math.sqrt(power / total))
  }
  pitch(samples) {
    const n = Math.floor(samples.length / 2)
    const x = this.decimated, scores = this.correlation
    for (let i = 0; i < n; i++) x[i] = 0.5 * (samples[2 * i] + samples[2 * i + 1])
    const limit = Math.min(106, n - 48)
    let best = 0
    for (let lag = 17; lag <= limit; lag++) {
      let xy = 0, xx = 0, yy = 0
      for (let i = lag; i < n; i++) {
        xy += x[i] * x[i - lag]
        xx += x[i] * x[i]
        yy += x[i - lag] * x[i - lag]
      }
      scores[lag] = xy / Math.sqrt(xx * yy + 1e-20)
      best = Math.max(best, scores[lag])
    }
    for (let lag = 18; lag < limit; lag++) {
      if (scores[lag] >= Math.max(0.68, best * 0.92) && scores[lag] >= scores[lag - 1] && scores[lag] >= scores[lag + 1]) {
        return Math.log2(8000 / lag)
      }
    }
    return null
  }
}

class SpeechSegments {
  constructor(source, rate, emit) {
    this.source = source
    this.emit = emit
    this.extract = new VoiceFeatures()
    this.noise = 0.0015
    this.dc = this.cursor = this.used = 0
    this.frame = new Float32Array(FRAME)
    this.before = []
    this.active = null
    this.continued = false
    this.converter = new PcmResampler(rate, value => {
      this.dc += 0.012 * (value - this.dc)
      this.frame[this.used++] = value - this.dc
      if (this.used === FRAME) this.consumeFrame()
    })
  }
  push(samples) { this.converter.push(samples) }
  consumeFrame() {
    const samples = this.frame.subarray(0, this.used)
    this.frame = new Float32Array(FRAME)
    this.used = 0
    const start = this.cursor
    this.cursor += samples.length
    let sum = 0
    for (const value of samples) sum += value * value
    const rms = Math.sqrt(sum / samples.length)
    let feature = null
    if (rms > Math.max(0.003, this.noise * 2.6)) {
      const bands = this.extract.spectrum(samples)
      const pitch = this.extract.pitch(samples)
      const speechPower = bands.slice(0, 5).reduce((acc, v) => acc + v * v, 0)
      feature = pitch !== null || speechPower > (this.active ? 0.50 : 0.65)
    }
    if (!feature && !this.active) this.noise += 0.025 * (Math.min(rms, 0.012) - this.noise)
    const frame = { samples, start, feature }
    if (!this.active && !feature) {
      this.before.push(frame)
      if (this.before.length > PRE_ROLL) this.before.shift()
      this.continued = false
      return
    }
    if (!this.active) {
      this.active = this.before
      this.before = []
      this.quiet = 0
    }
    this.active.push(frame)
    this.quiet = feature ? 0 : this.quiet + 1
    if (this.quiet >= RELEASE) this.finish(false)
    else if (this.active.length >= MAX_FRAMES) this.finish(true)
  }
  finish(atLimit) {
    if (!this.active) return
    const all = this.active
    const keep = atLimit ? all.length : all.length - Math.max(0, this.quiet - POST_ROLL)
    const frames = all.slice(0, keep)
    const voicedFrames = frames.reduce((count,frame) => count + Number(!!frame.feature),0)
    this.active = null
    const continuation = this.continued
    this.continued = atLimit && this.quiet === 0
    if (!atLimit) this.before = all.slice(Math.max(keep, all.length - PRE_ROLL))
    if (!voicedFrames || (voicedFrames < 3 && !continuation)) return
    const start = frames[0].start, last = frames[frames.length - 1]
    const end = last.start + last.samples.length
    const pcm = new Uint8Array((end - start) * 2)
    const view = new DataView(pcm.buffer)
    let offset = 0
    for (const frame of frames) {
      for (const value of frame.samples) {
        const clipped = Math.max(-1, Math.min(1, value))
        view.setInt16(offset, Math.round(clipped * (clipped < 0 ? 32768 : 32767)), true)
        offset += 2
      }
    }
    this.emit({ source: this.source, startMs: start / 16, endMs: end / 16, pcm })
  }
  flush() {
    this.converter.push(new Float32Array(0), true)
    if (this.used) this.consumeFrame()
    this.finish(false)
    this.before = []
  }
}

// The render thread transfers batches to the page and never plays back audio.
// A flush acknowledgement orders the last short batch ahead of teardown.
const MEETING_PROCESSOR = `
class MeetingInput extends AudioWorkletProcessor {
  constructor(options) {
    super()
    this.count = options.numberOfInputs
    this.size = 2048
    this.reset()
    this.port.onmessage = ({data}) => {
      if (data === 'flush') {
        this.finished = true
        this.send()
        this.port.postMessage('flushed')
      }
    }
  }
  reset() {
    this.blocks = Array.from({length: this.count}, () => new Float32Array(this.size))
    this.used = 0
  }
  send() {
    if (!this.used) return
    const blocks = this.used === this.size ? this.blocks : this.blocks.map(block => block.slice(0, this.used))
    this.port.postMessage(blocks, blocks.map(block => block.buffer))
    this.reset()
  }
  process(inputs, outputs) {
    if (this.finished) return false
    const length = outputs[0][0].length
    for (let pos = 0; pos < length;) {
      const take = Math.min(length - pos, this.size - this.used)
      for (let i = 0; i < this.count; i++) {
        const mono = inputs[i][0]
        if (mono) this.blocks[i].set(mono.subarray(pos, pos + take), this.used)
      }
      this.used += take
      pos += take
      if (this.used === this.size) this.send()
    }
    return true
  }
}
registerProcessor('meeting-input', MeetingInput)`

function endedError(text) { return new DOMException(text, 'NotReadableError') }
function cancelled() { return new DOMException('Capture start was cancelled', 'AbortError') }
function stopTracks(stream) { for (const track of stream.getTracks()) track.stop() }

// The browser does not expose a cancel operation for an open media picker.
// Release a late grant even after another meeting has started.
function abortable(promise, signal) {
  if (signal.aborted) return Promise.reject(cancelled())
  return new Promise((resolve, reject) => {
    const abort = () => reject(cancelled())
    signal.addEventListener('abort', abort, { once: true })
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function bounded(promise, ms, onTimeout) {
  let timer
  const timeout = new Promise(resolve => { timer = setTimeout(() => { onTimeout(); resolve() }, ms) })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/**
 * start('mic' | 'system' | 'both') must be called from the initiating gesture.
 * Callbacks are notifications. The consumer owns async persistence and ordering.
 * onSegment({source, startMs, endMs, pcm: Uint8Array}) uses signed LE
 * 16-bit mono at 16 kHz. Time is relative to this start, per-source on one clock.
 * onRecordingChunk({blob, mimeType, index}) starts at index 0. Concatenate the
 * bytes in order for a single playable recording; individual chunks are partial.
 * stop() also cancels a pending start. Resolve/idle follows final notifications.
 */
export function createMeetingCapture({ onSegment, onRecordingChunk, onState, onError, desktopAudio } = {}) {
  let state = 'idle', current = null
  function report(error) {
    try { onError?.(error) } catch (observerError) { console.error(observerError) }
  }
  function notify(callback, value) {
    try {
      const result = callback?.(value)
      if (result?.then) Promise.resolve(result).catch(report)
    } catch (error) { report(error) }
  }
  function setState(next) { state = next; notify(onState, next) }
  function own(session, node) { session.nodes.push(node); return node }
  function listen(session, target, type, handler) {
    target.addEventListener(type, handler)
    session.off.push(() => target.removeEventListener(type, handler))
  }
  function fail(session, error) {
    if (session !== current || state === 'stopping') return
    session.failure = error
    report(error)
    void stop()
  }
  async function acquire(session, source, request) {
    const { signal } = session.controller
    const stream = await abortable(Promise.resolve(request).then(value => {
      if (signal.aborted) { stopTracks(value); throw cancelled() }
      session.streams.push(value)
      return value
    }), signal)
    if (signal.aborted) throw cancelled()
    const track = stream.getAudioTracks().find(candidate => candidate.readyState === 'live')
    if (!track) throw new DOMException(`${source} did not provide a live audio track`, 'NotFoundError')
    for (const watched of [track, ...stream.getVideoTracks()]) {
      listen(session, watched, 'ended', () => fail(session, endedError(`${source} capture ended`)))
    }
    session.inputs.push({ source, stream: new MediaStream([track]) })
  }
  async function wire(session) {
    const ctx = session.context, inputs = session.inputs, count = inputs.length
    const { signal } = session.controller
    const segments = inputs.map(({ source }) => new SpeechSegments(source, ctx.sampleRate, data => notify(onSegment, data)))
    session.segments = segments
    const feed = blocks => { for (let i = 0; i < count; i++) segments[i].push(blocks[i]) }
    let worklet = null
    if (ctx.audioWorklet && typeof AudioWorkletNode === 'function') {
      const url = URL.createObjectURL(new Blob([MEETING_PROCESSOR], { type: 'text/javascript' }))
      try {
        await abortable(ctx.audioWorklet.addModule(url), signal)
        if (signal.aborted) throw cancelled()
        worklet = own(session, new AudioWorkletNode(ctx, 'meeting-input', {
          numberOfInputs: count, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit',
        }))
      } catch (error) {
        if (signal.aborted || !ctx.createScriptProcessor) throw error
      } finally { URL.revokeObjectURL(url) }
    }
    if (signal.aborted) throw cancelled()
    let inlet
    if (worklet) {
      const flushed = new Promise(resolve => {
        worklet.port.onmessage = ({ data }) => data === 'flushed' ? resolve() : feed(data)
      })
      listen(session, worklet, 'processorerror', () => fail(session, endedError('Audio processor failed')))
      session.off.push(() => { worklet.port.onmessage = null; worklet.port.close() })
      session.drain = () => { worklet.port.postMessage('flush'); return flushed }
      worklet.connect(ctx.destination)
      inlet = worklet
    } else {
      // Chromium can disallow blob worklets through CSP. A channel merger keeps
      // the source order intact in a single, silent ScriptProcessor callback.
      inlet = own(session, ctx.createChannelMerger(count))
      const script = own(session, ctx.createScriptProcessor(1024, count, 1))
      inlet.connect(script)
      script.connect(ctx.destination)
      let delivered = 0, cutoff = Infinity, acknowledge
      const origin = ctx.currentTime
      script.onaudioprocess = ({ inputBuffer }) => {
        const length = Math.min(inputBuffer.length, Math.max(0, cutoff - delivered))
        if (length) feed(inputs.map((_, i) => inputBuffer.getChannelData(i).subarray(0, length)))
        delivered += length
        if (delivered >= cutoff) acknowledge?.()
      }
      session.drain = () => {
        cutoff = Math.round((ctx.currentTime - origin) * ctx.sampleRate)
        return delivered >= cutoff ? Promise.resolve() : new Promise(resolve => { acknowledge = resolve })
      }
      session.off.push(() => { script.onaudioprocess = null })
    }
    const sources = inputs.map(({ stream }, i) => {
      const node = own(session, ctx.createMediaStreamSource(stream))
      const mono = own(session, ctx.createGain())
      mono.channelCount = 1
      mono.channelCountMode = 'explicit'
      node.connect(mono)
      mono.connect(inlet, 0, i)
      return node
    })
    let recordingStream = inputs[0].stream
    if (count > 1) {
      const mixer = own(session, ctx.createGain())
      const destination = own(session, ctx.createMediaStreamDestination())
      mixer.gain.value = 1 / count
      for (const node of sources) node.connect(mixer)
      mixer.connect(destination)
      session.streams.push(destination.stream)
      recordingStream = destination.stream
    }
    const formats = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4']
    const mimeType = formats.find(type => MediaRecorder.isTypeSupported?.(type))
    const recorder = new MediaRecorder(recordingStream, mimeType ? { mimeType } : {})
    session.recorder = recorder
    let index = 0
    listen(session, recorder, 'dataavailable', ({ data }) => {
      const type = data.type || recorder.mimeType
      for (let offset = 0; offset < data.size; offset += RECORDER_CHUNK) {
        const blob = data.slice(offset, Math.min(offset + RECORDER_CHUNK, data.size), type)
        notify(onRecordingChunk, { blob, mimeType: type, index: index++ })
      }
    })
    session.recorded = new Promise(resolve => {
      listen(session, recorder, 'stop', () => {
        resolve()
        if (state === 'recording') fail(session, endedError('Recorder stopped unexpectedly'))
      })
    })
    listen(session, recorder, 'error', event => fail(session, event.error || endedError('Recorder failed')))
    recorder.start(1000)
    session.started = true
  }
  async function start(mode = 'mic') {
    if (state !== 'idle') throw new DOMException('Capture is already active', 'InvalidStateError')
    if (!['mic', 'system', 'both'].includes(mode)) throw new TypeError('Unknown capture mode')
    const session = { controller: new AbortController(), inputs: [], nodes: [], streams: [], off: [], segments: [] }
    current = session
    setState('starting')
    const { signal } = session.controller
    try {
      if (signal.aborted) throw cancelled()
      const devices = globalThis.navigator?.mediaDevices
      const Audio = globalThis.AudioContext || globalThis.webkitAudioContext
      if (!Audio || typeof MediaRecorder !== 'function' || (mode !== 'mic' && !desktopAudio && !devices?.getDisplayMedia) || (mode !== 'system' && !devices?.getUserMedia)) {
        throw new DOMException('This browser lacks the required audio capture APIs', 'NotSupportedError')
      }
      session.context = new Audio()
      // Both resume and the display picker need the initiating user gesture.
      const running = abortable(session.context.resume(), signal)
      running.catch(() => {})
      if (mode !== 'mic') {
        const shared = desktopAudio
          ? desktopAudio(session.context,signal,error => fail(session,error))
          : devices.getDisplayMedia({ video: true, audio: true, systemAudio: 'include' })
        await acquire(session,'system',shared)
      }
      if (signal.aborted) throw cancelled()
      if (mode !== 'system') await acquire(session, 'mic', devices.getUserMedia({ video: false, audio: { echoCancellation: true } }))
      await running
      if (signal.aborted) throw cancelled()
      await wire(session)
      if (signal.aborted) throw cancelled()
      setState('recording')
    } catch (error) {
      const reason = session.failure || error
      if (!signal.aborted && !session.failure) report(reason)
      if (current === session) await stop()
      throw reason
    }
  }
  async function release(session) {
    const pending = []
    try {
      if (session.started) {
        const recorder = session.recorder
        if (recorder.state !== 'inactive') recorder.stop()
        pending.push(bounded(session.recorded, 4000, () => report(endedError('Recorder final chunk timed out'))))
        pending.push(bounded(session.drain(), 750, () => report(endedError('Audio processor flush timed out'))))
      }
      await Promise.all(pending)
    } catch (error) { report(error) }
    finally {
      for (const off of session.off) off()
      for (const node of session.nodes) node.disconnect()
      for (const stream of session.streams) stopTracks(stream)
      for (const segment of session.segments) segment.flush()
      if (session.context && session.context.state !== 'closed') {
        try { await session.context.close() } catch (error) { report(error) }
      }
      current = null
      setState('idle')
    }
  }
  function stop() {
    const session = current
    if (!session) return Promise.resolve()
    if (!session.done) {
      session.done = Promise.resolve().then(() => release(session))
      session.controller.abort()
      setState('stopping')
    }
    return session.done
  }
  return { start, stop, get state() { return state } }
}
