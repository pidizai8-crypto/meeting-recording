import { Buffer } from 'node:buffer'
import { fork } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ENTRY = fileURLToPath(new URL('./voice-engine/worker.cjs', import.meta.url))
const BYTES_PER_SECOND = 32000
const TIMEOUT_MS = 8000

/** Local, asynchronous s16le/16 kHz mono -> 192 L2-normalized CAM++ coordinates. */
export function createVoiceEmbedding() {
  let child, current, idleTimer, retryAfter = 0, disposed = false
  const queue = []

  function finish(request, value) {
    clearTimeout(request.timer)
    request.signal?.removeEventListener('abort', request.cancel)
    if (request === current) current = undefined
    else {
      const index = queue.indexOf(request)
      if (index >= 0) queue.splice(index, 1)
    }
    request.resolve(value)
  }

  function stop() {
    clearTimeout(idleTimer)
    const previous = child
    child = undefined
    if (previous) previous.kill()
  }

  function fail(reason) {
    stop()
    retryAfter = Date.now() + 30000
    console.warn('[meeting-notes] Speaker embedding unavailable:', reason)
    if (current) finish(current, null)
    while (queue.length) finish(queue[0], null)
  }

  function start() {
    // A Desktop host runs Electron as Node. Anchor module resolution at its real
    // entry point so profile-installed plugins can share the shipping Node-API addon.
    const hostEntry = resolve(process.argv[1] || ENTRY)
    const worker = fork(ENTRY, [hostEntry], {
      execPath: process.env.DSH_NODE_EXECUTABLE || process.execPath, execArgv: [],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'], serialization: 'json',
    })
    child = worker
    worker.on('error', error => { if (child === worker) fail(error.message) })
    worker.on('exit', (code, signal) => {
      if (child === worker) fail(`worker exited (${signal ?? code})`)
    })
    worker.on('message', result => {
      if (child !== worker || !current) return
      if (result?.error) { fail(result.error); return }
      finish(current, result.embedding)
      dispatch()
    })
  }

  function dispatch() {
    if (current) return
    clearTimeout(idleTimer)
    if (!queue.length) {
      if (child) idleTimer = setTimeout(stop,60_000).unref()
      return
    }
    current = queue.shift()
    try {
      if (!child) start()
      const worker = child
      worker.send(current.pcm.toString('base64'), error => { if (error && worker === child) fail(error.message) })
    } catch (error) { fail(error.message) }
  }

  return {
    extract(pcm, signal) {
      if (disposed || signal?.aborted || Date.now() < retryAfter || queue.length >= 16 ||
          !(pcm instanceof Uint8Array) || pcm.byteLength < BYTES_PER_SECOND ||
          pcm.byteLength > 30 * BYTES_PER_SECOND || pcm.byteLength % 2) return Promise.resolve(null)
      return new Promise(resolve => {
        const request = { pcm: Buffer.from(pcm), signal, resolve }
        request.cancel = () => {
          // Isolate cancellation of native synchronous inference to its own process.
          if (current === request) stop()
          finish(request, null)
          dispatch()
        }
        request.timer = setTimeout(() => {
          if (current === request) fail('inference timed out')
          else finish(request, null)
        }, TIMEOUT_MS)
        signal?.addEventListener('abort', request.cancel, { once: true })
        queue.push(request)
        dispatch()
      })
    },
    dispose() {
      disposed = true
      stop()
      if (current) finish(current, null)
      while (queue.length) finish(queue[0], null)
    },
  }
}
