import { createMeetingArchive } from './archive.js'
import { createMeetingEngine } from './engine.js'
import { createLoopbackHost } from './loopback.js'
import { createVoiceEmbedding } from './voice-embedding.js'
import { recognizeMeetingTurns } from './recognize-turns.js'

export const inject = ['connection']

// A 96 KiB binary chunk encodes to 128 KiB plus the small RPC envelope.
async function readArchiveMessage(request) {
  const limit = 144 * 1024
  if (Number(request.headers.get('content-length')) > limit) return new Response(null, { status: 413 })
  if (!request.body) return null
  const reader = request.body.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) {
        await reader.cancel()
        return new Response(null, { status: 413 })
      }
      chunks.push(value)
    }
    return JSON.parse(Buffer.concat(chunks, size).toString('utf8'))
  } catch { return null }
  finally { reader.releaseLock() }
}

export function apply(ctx) {
  const engine = createMeetingEngine(ctx)
  const lifetime = new AbortController()
  const loopback = createLoopbackHost()
  const voices = createVoiceEmbedding()
  const archive = createMeetingArchive(ctx.get('profileContext')?.dir || process.env.DSH_PROFILE_DIR, async (path, signal) => {
    const desktop = ctx.get('sessionController')
    if (!desktop?.canOpenWorkspacePath()) throw new Error('当前 Host 没有可用的桌面文件管理器。')
    await desktop.openWorkspacePath({ path }, signal)
  })
  const methods = {
    ...archive,
    loopbackStart: (_data,signal) => loopback.start(signal),
    loopbackRead: (data,signal) => loopback.read(data,signal),
    loopbackStop: async data => { await loopback.stop(data); return null },
    status: () => engine.status(),
    prepare: async () => {
      await engine.prepare({ signal: lifetime.signal })
      return engine.status()
    },
    transcribe: async (data, signal) => {
      if (typeof data?.pcm !== 'string' || data.pcm.length > 1280000) throw new Error('Invalid PCM segment size')
      const pcm = Buffer.from(data.pcm, 'base64')
      if (!pcm.length || pcm.length % 2 || pcm.toString('base64') !== data.pcm) throw new Error('Invalid PCM segment')
      const language = data.language ?? 'zh'
      if (!['zh','auto'].includes(language)) throw new Error('Unsupported meeting language')
      if (!data.speakerTurns) return engine.transcribe(pcm, { signal, language })
      if (pcm.length > 30 * 32000) throw new Error('Invalid PCM segment size')
      return recognizeMeetingTurns(pcm,language,signal,engine,voices)
    },
    summarize: async (data, signal) => {
      if (typeof data?.transcript !== 'string' || typeof data?.notes !== 'string') throw new Error('Invalid meeting text')
      return engine.summarize({ title: String(data.title || '').slice(0, 300), transcript: data.transcript, notes: data.notes }, { signal })
    },
  }
  ctx.inject(['tools'], scoped => scoped.tools.register({
    name: 'summarize_meeting_text',
    description: 'Generate meeting minutes from a supplied transcript and notes using the default DSH model.',
    parameters: { type: 'object', properties: { title: { type: 'string' }, transcript: { type: 'string' }, notes: { type: 'string' } }, required: ['transcript'], additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute: (args, exec) => methods.summarize({ ...args, notes: args.notes || '' }, AbortSignal.any([exec.signal, lifetime.signal])),
  }))
  ctx.effect(() => () => { lifetime.abort(); return Promise.all([loopback.dispose(),voices.dispose()]) }, 'meeting recorder lifetime')
  // Connection admits only authenticated owners to exact routes and limits buffered bodies.
  for (const [method, invoke] of Object.entries(methods)) {
    const endpoint = 'meetingRecorder/' + method
    const isArchive = Object.hasOwn(archive, method)
    ctx.connection.fetch.register({
      path: '/api/' + endpoint, methods: ['POST'], requestBody: isArchive ? 'streaming' : 'buffered',
      async fetch(request) {
        if (request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') return new Response(null,{status:415})
        const message = isArchive ? await readArchiveMessage(request) : await request.json().catch(() => null)
        if (message instanceof Response) return message
        if (message?.type !== 'client-request' || typeof message.rpcId !== 'string' || message.method !== endpoint) return new Response(null,{status:400})
        const reply = result => Response.json({type:'server-response',rpcId:message.rpcId,result})
        try {
          const value = await invoke(message.payload,AbortSignal.any([request.signal,lifetime.signal]))
          return reply({ok:true,value:value ?? null})
        } catch (error) {
          return reply({ok:false,error:{code:'meeting/failed',message:String(error?.message || error),details:{}}})
        }
      },
    })
  }
}
