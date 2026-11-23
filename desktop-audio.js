// Browser-side Windows loopback bridge. Module evaluation never requests audio.
export function desktopMeetingAudioAvailable() {
  const { window, location, navigator } = globalThis
  if (!window || window.top !== window || location?.protocol !== 'dsh-app:' || location.host !== 'app') return false
  const platform = navigator?.userAgentData?.platform || navigator?.platform
  return platform ? /^(Win32|Win64|Windows)$/i.test(platform) : /\bWindows NT\b/i.test(navigator?.userAgent || '')
}

function desktopAudioAbort(signal) {
  return signal.reason instanceof Error ? signal.reason : new DOMException('System audio capture cancelled', 'AbortError')
}

function desktopAudioWait(start, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(desktopAudioAbort(signal))
    if (signal.aborted) abort()
    else signal.addEventListener('abort', abort, { once: true })
    start.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function desktopAudioDelay(ms, signal) {
  signal.throwIfAborted()
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(desktopAudioAbort(signal)) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve() }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}

// Each reply is at most 500 ms. The hardware rate may differ from the AudioContext rate.
function desktopPcmBuffer(context, rate, encoded) {
  const maxBytes = Math.ceil(rate / 2) * 2
  if (typeof encoded !== 'string' || encoded.length > Math.ceil(maxBytes / 3) * 4 || encoded.length % 4) {
    throw new Error('Invalid Windows loopback PCM frame')
  }
  if (!encoded.length) return null
  const bytes = atob(encoded)
  if (bytes.length % 2 || !bytes.length || bytes.length > maxBytes) throw new Error('Invalid Windows loopback PCM length')
  const buffer = context.createBuffer(1, bytes.length / 2, rate)
  const output = buffer.getChannelData(0)
  for (let i = 0; i < output.length; i++) {
    const word = bytes.charCodeAt(i * 2) | bytes.charCodeAt(i * 2 + 1) << 8
    output[i] = ((word << 16) >> 16) / 32768
  }
  return buffer
}

/** Start capture through the authenticated page RPC. The caller owns the AudioContext and the recording signal. */
export async function windowsMeetingAudio(call, context, signal, onError) {
  if (!desktopMeetingAudioAvailable()) throw new DOMException('Windows desktop capture is unavailable', 'NotSupportedError')
  signal.throwIfAborted()
  const lifetime = new AbortController()
  const live = lifetime.signal
  const sources = new Set()
  let id, destination, closed = false, cursor = 0

  function stopRemote() {
    if (!id) return
    const grantedId = id
    id = undefined
    const cleanup = new AbortController()
    const deadline = setTimeout(() => cleanup.abort(), 5000)
    // Caller cancellation must not cancel this cleanup RPC. Each grant is returned only once.
    void Promise.resolve().then(() => call('loopbackStop', { id: grantedId }, cleanup.signal)).catch(() => {}).finally(() => clearTimeout(deadline))
  }
  function close() {
    if (!closed) {
      closed = true
      signal.removeEventListener('abort', close)
      globalThis.removeEventListener?.('pagehide', close)
      lifetime.abort()
      for (const source of sources) {
        source.onended = null
        try { source.stop() } catch { /* start() may have failed */ }
        source.disconnect()
      }
      sources.clear()
      if (destination) {
        for (const track of destination.stream.getTracks()) track.stop()
        destination.disconnect()
      }
    }
    // An RPC transport may deliver a grant after caller cancellation.
    stopRemote()
  }
  function schedule(buffer) {
    // The destination stays live and emits silence whenever no source is scheduled.
    // A small jitter buffer absorbs normal RPC scheduling delays. Never compress a real silent gap.
    const now = context.currentTime
    const start = cursor > now ? cursor : now + 0.08
    const source = context.createBufferSource()
    sources.add(source)
    source.buffer = buffer
    source.onended = () => { sources.delete(source); source.disconnect() }
    source.connect(destination)
    source.start(start)
    cursor = start + buffer.duration
  }
  async function read(rate) {
    while (!live.aborted) {
      if (context.state === 'closed') throw new Error('Recording audio context closed')
      // Only one read can be outstanding. Bound scheduled audio to 750 ms plus one render quantum.
      // Recheck the context clock after every wait; it can pause while the page is hidden.
      const ahead = cursor - context.currentTime
      if (ahead > 0.25) {
        await desktopAudioDelay(Math.max(4, Math.min(100, (ahead - 0.20) * 1000)), live)
        continue
      }
      const packet = await call('loopbackRead', { id }, live)
      live.throwIfAborted()
      if (typeof packet?.ended !== 'boolean') throw new Error('Invalid Windows loopback response')
      const buffer = desktopPcmBuffer(context, rate, packet.pcm)
      if (buffer) schedule(buffer)
      if (packet.ended) {
        // The last packet may still contain sound. Wait for its scheduled audio before reporting device loss.
        while (cursor > context.currentTime && context.state === 'running') {
          await desktopAudioDelay(Math.max(4, Math.min(100, (cursor - context.currentTime) * 1000)), live)
        }
        throw new DOMException('Windows system audio capture ended', 'NotReadableError')
      }
      if (!buffer) await desktopAudioDelay(16, live)
    }
  }
  signal.addEventListener('abort', close, { once: true })
  globalThis.addEventListener?.('pagehide', close, { once: true })
  try {
    // Keep this continuation attached even when the public start promise has already rejected.
    const start = Promise.resolve(call('loopbackStart', {}, live)).then(grant => {
      if (typeof grant?.id !== 'string' || !grant.id) throw new Error('Invalid Windows loopback capture identifier')
      id = grant.id
      if (closed) { stopRemote(); throw desktopAudioAbort(live) }
      if (!Number.isInteger(grant.sampleRate) || grant.sampleRate < 8000 || grant.sampleRate > 192000) {
        throw new Error('Invalid Windows loopback sample rate')
      }
      return grant.sampleRate
    })
    const rate = await desktopAudioWait(start, live)
    live.throwIfAborted()
    destination = context.createMediaStreamDestination()
    destination.channelCount = 1
    destination.channelCountMode = 'explicit'
    void read(rate).catch(error => {
      if (closed) return
      close()
      onError?.(error instanceof Error ? error : new Error(String(error)))
    })
    return destination.stream
  } catch (error) {
    close()
    throw error
  }
}
