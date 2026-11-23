import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { win32 } from 'node:path'

const SAMPLE_RATE = 16000
const PACKET_BYTES = 6400 // 200 ms of mono 16-bit PCM
const MAX_BUFFER = SAMPLE_RATE * 2 * 1.5
const HEADER = Buffer.from('WLP1')
const scriptPath = fileURLToPath(new URL('./Loopback.cs', import.meta.url))
const command = [
  "$ErrorActionPreference = 'Stop'",
  '[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)',
  'try { Add-Type -Path $env:DSH_MEETING_LOOPBACK_SOURCE; [DshMeeting.Loopback]::Run() }',
  'catch { [Console]::Error.WriteLine($_.Exception.GetBaseException().Message); exit 1 }',
].join('\n')

function makeChild() {
  if (process.platform !== 'win32') throw new Error('System audio loopback requires Windows')
  const shell = win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
  return spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, DSH_MEETING_LOOPBACK_SOURCE: scriptPath },
  })
}

function aborted() { return new DOMException('System audio request was cancelled', 'AbortError') }
function rejectIfAborted(signal) { if (signal?.aborted) throw aborted() }
function watch(signal, callback) {
  signal?.addEventListener('abort', callback, { once: true })
  return () => signal?.removeEventListener('abort', callback)
}
function deferred() {
  let resolve, reject
  const promise = new Promise((a, b) => { resolve = a; reject = b })
  return { promise, resolve, reject }
}

// A single host instance belongs to one owner-only RPC registration. Constructing
// it does no I/O. No default-device access happens until the owner calls start().
export function createLoopbackHost() {
  let current = null, disposed = false, last = null

  function pulse(s) { s.waiting?.resolve() }
  function closeInput(s, immediate) {
    if (immediate) {
      try { s.child.kill() } catch { /* close/error will settle the pending operations */ }
    } else if (!s.child.stdin.destroyed) s.child.stdin.end()
  }
  function failure(s, error) {
    if (s.error || s.closed) return
    s.error = error
    s.ready.reject(error)
    s.bytes = Buffer.alloc(0)
    clearTimeout(s.idleTimer)
    pulse(s)
    closeInput(s, true)
  }
  function armIdle(s) {
    clearTimeout(s.idleTimer)
    s.idleTimer = setTimeout(() => failure(s, new Error('System audio reader inactive for 10 seconds')), 10000)
    s.idleTimer.unref?.()
  }
  function handleData(s, data) {
    if (s.error || s.closed) return
    if (!s.started) {
      const needed = HEADER.length - s.headerBytes
      const take = Math.min(needed, data.length)
      if (!data.subarray(0, take).equals(HEADER.subarray(s.headerBytes, s.headerBytes + take))) {
        failure(s, new Error('Invalid WASAPI helper handshake'))
        return
      }
      s.headerBytes += take
      if (s.headerBytes < HEADER.length) return
      s.started = true
      clearTimeout(s.startTimer)
      s.ready.resolve()
      if (!s.stopping) armIdle(s)
      data = data.subarray(take)
    }
    if (!data.length) return
    if (data.length + s.bytes.length > MAX_BUFFER) {
      failure(s, new Error('System audio buffer overrun: reader did not keep up'))
      return
    }
    s.bytes = Buffer.concat([s.bytes, data])
    if (s.bytes.length >= 2) pulse(s)
  }
  function onClose(s, code) {
    if (s.closed) return
    clearTimeout(s.startTimer)
    clearTimeout(s.idleTimer)
    clearTimeout(s.stopTimer)
    if (!s.error && !s.stopping && (!s.started || code !== 0)) {
      s.error = new Error(`System audio process exited (${code ?? 'signal'})${s.stderr.length ? ': ' + s.stderr.toString('utf8').trim() : ''}`)
    }
    if (!s.error && (s.bytes.length & 1)) s.error = new Error('Truncated system audio PCM sample')
    s.closed = true
    if (!s.started) s.ready.reject(s.error || aborted())
    if (current === s) current = null
    if (s.error) s.bytes = Buffer.alloc(0)
    // Allow an in-flight reader to consume final complete samples after process exit.
    last = s
    pulse(s)
    s.done.resolve()
  }
  async function start(signal) {
    rejectIfAborted(signal)
    if (disposed) throw new Error('System audio host disposed')
    if (current) throw new Error('System audio capture is already active')
    const child = makeChild()
    const s = {
      child, id: randomUUID(), bytes: Buffer.alloc(0), headerBytes: 0,
      stderr: Buffer.alloc(0), ready: deferred(), done: deferred(),
    }
    current = s
    last = null
    child.stdin.on('error', () => {}) // may close during startup, cancellation or a device error
    child.stderr.on('data', bytes => {
      s.stderr = Buffer.from(Buffer.concat([s.stderr, bytes]).subarray(-2048))
    })
    child.stdout.on('data', data => handleData(s, data))
    child.stdout.on('error', error => failure(s, error))
    child.on('error', error => failure(s, error))
    child.once('close', code => onClose(s, code))
    s.startTimer = setTimeout(() => failure(s, new Error('System audio initialization timed out after 12 seconds')), 12000)
    s.startTimer.unref?.()
    const remove = watch(signal, () => failure(s, aborted()))
    try {
      await s.ready.promise
      rejectIfAborted(signal)
      if (s.error || s.stopping || s.closed) throw s.error || aborted()
      return { id: s.id, sampleRate: SAMPLE_RATE }
    } catch (error) {
      if (!s.closed) await s.done.promise
      throw error
    } finally { remove() }
  }
  function session(id) {
    if (current && current.id === id) return current
    if (last && last.id === id) return last
    throw new Error('Unknown system audio capture id')
  }
  async function read({ id }, signal) {
    rejectIfAborted(signal)
    const s = session(id)
    if (s.error) throw s.error
    if (s.waiting) throw new Error('Concurrent reads from system audio capture')
    if (!s.closed && !s.stopping) armIdle(s)
    if (s.bytes.length < 2 && !s.closed) {
      const wake = deferred()
      s.waiting = wake
      const timer = setTimeout(wake.resolve, 500)
      const remove = watch(signal, () => wake.reject(aborted()))
      try { await wake.promise } finally { clearTimeout(timer); remove(); s.waiting = null }
    }
    rejectIfAborted(signal)
    if (s.error) throw s.error
    const count = Math.min(PACKET_BYTES, s.bytes.length) & ~1
    const pcm = s.bytes.toString('base64', 0, count)
    s.bytes = s.bytes.length === count ? Buffer.alloc(0) : s.bytes.subarray(count)
    return { pcm, ended: Boolean(s.closed && !s.bytes.length) }
  }
  async function stop({ id }) {
    const s = session(id)
    if (!s.closed && !s.stopping) {
      s.stopping = true
      clearTimeout(s.idleTimer)
      // A compiled helper drains its current packet and releases COM before exit.
      // The startup compiler has no active capture yet and can be terminated directly.
      closeInput(s, !s.started)
      s.stopTimer = setTimeout(() => closeInput(s, true), 600)
      s.stopTimer.unref?.()
    }
    await s.done.promise
  }
  async function dispose() {
    disposed = true
    if (current) await stop({ id: current.id })
    last = null
  }
  return { start, read, stop, dispose }
}
