import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, realpath, rename, rmdir, unlink } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const PARTS = ['audio', 'transcript', 'notebook', 'summary']
const AUDIO_EXT = new Map(Object.entries({
  'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3',
  'audio/wav': 'wav', 'audio/x-wav': 'wav', 'video/webm': 'webm', 'video/mp4': 'mp4',
}))
const TEXT_EXT = { transcript: 'txt', notebook: 'txt', summary: 'md' }
const FORMAT = 'dsh-meeting-notes/1'
const MANIFEST = 'meeting.json'
const CHUNK_BYTES = 96 * 1024
const NOFOLLOW = constants.O_NOFOLLOW || 0

function check(condition, message) {
  if (!condition) throw new Error(message)
}
function validId(id) { return typeof id === 'string' && id.length === 36 && UUID.test(id) }
function meetingName(name) {
  check(typeof name === 'string' && name.trim() && name.length <= 300, '会议名称无效。')
  return name.trim()
}
function description(data) {
  const { started, duration, mode, audioType, sizes } = data
  const name = meetingName(data.name)
  check(Number.isFinite(started) && started >= 0 && Number.isFinite(duration) && duration >= 0, '会议时间无效。')
  check(['mic', 'system', 'both'].includes(mode), '录音来源无效。')
  check(typeof audioType === 'string' && audioType.length <= 200, '录音格式无效。')
  check(PARTS.every(part => Number.isSafeInteger(sizes?.[part]) && sizes[part] >= 0), '归档文件大小无效。')
  const notebookFormat = data.notebookFormat === 'markdown' ? 'markdown' : 'plain'
  return { name, started, duration, mode, audioType, notebookFormat, sizes: Object.fromEntries(PARTS.map(part => [part, sizes[part]])) }
}
function extension(part, { audioType, notebookFormat }) {
  if (part === 'notebook' && notebookFormat === 'markdown') return 'md'
  return part === 'audio' ? AUDIO_EXT.get(audioType.split(';', 1)[0].trim().toLowerCase()) || 'bin' : TEXT_EXT[part]
}
function stagedName(token, part) { return `.upload-${token}-${part}` }
function publishedName(token, part, ext) { return `${part}-${token.slice(0, 8)}.${ext}` }

async function stat(path) {
  try { return await lstat(path, { bigint: true }) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
}
function identity(s) { return `${s.dev}/${s.ino}/${s.birthtimeNs}` }
function sameFile(s, ref) {
  return s?.isFile() && ref && identity(s) === ref.identity &&
    (ref.mtime === undefined || (s.mtimeNs.toString() === ref.mtime && Number(s.size) === ref.bytes))
}
function fileRef(name, s, completed = false) {
  const ref = { name, identity: identity(s) }
  if (completed) Object.assign(ref, { bytes: Number(s.size), mtime: s.mtimeNs.toString() })
  return ref
}
// Names in a user-visible JSON document are never accepted as general paths.
function validRef(ref) {
  if (!ref || typeof ref.name !== 'string' || typeof ref.identity !== 'string') return false
  return PARTS.some(part => {
    if (ref.name.startsWith('.upload-') && ref.name.endsWith(`-${part}`)) {
      return validId(ref.name.slice(8, -part.length - 1))
    }
    const [stem, ext, ...extra] = ref.name.split('.')
    if (extra.length || !stem.startsWith(`${part}-`) || !/^[0-9a-f]{8}$/.test(stem.slice(part.length + 1))) return false
    if (part === 'audio') return ['bin', ...AUDIO_EXT.values()].includes(ext)
    return ext === TEXT_EXT[part] || (part === 'notebook' && ext === 'md')
  })
}
async function removeOwned(dir, ref) {
  check(validRef(ref), '归档清单包含无效文件名。')
  const path = join(dir, ref.name)
  if (sameFile(await stat(path), ref)) await unlink(path)
}
async function directory(path, create) {
  if (create) {
    try { await mkdir(path, { mode: 0o700 }) }
    catch (error) { if (error.code !== 'EEXIST') throw error }
  }
  const s = await stat(path)
  if (!s) return false
  check(s.isDirectory() && !s.isSymbolicLink(), '归档目录不是普通目录。')
  return true
}
async function manifest(dir, id) {
  const path = join(dir, MANIFEST)
  const s = await stat(path)
  if (!s) return null
  check(s.isFile() && s.nlink === 1n && s.size <= 256n * 1024n, '会议清单无效。')
  const file = await open(path, constants.O_RDONLY | NOFOLLOW)
  try {
    check(identity(await file.stat({ bigint: true })) === identity(s), '会议清单已被替换。')
    const m = JSON.parse(await file.readFile('utf8'))
    check(m.format === FORMAT && m.id === id && m.files && Array.isArray(m.retired), '无法确认归档的归属。')
    const refs = [...Object.values(m.files), ...m.retired]
    if (m.pending) {
      check(validId(m.pending.token) && m.pending.parts, '上传清单无效。')
      description(m.pending.data)
      for (const [part, ref] of Object.entries(m.pending.parts)) {
        check(PARTS.includes(part) && ref.name === stagedName(m.pending.token, part), '上传清单无效。')
        refs.push(ref)
      }
    }
    check(refs.every(validRef), '归档清单包含无效文件名。')
    return m
  } finally { await file.close() }
}
async function saveManifest(dir, m, first = false) {
  const path = join(dir, MANIFEST)
  const tmp = join(dir, `.meeting-${randomUUID()}.tmp`)
  const file = await open(tmp, 'wx', 0o600)
  try {
    try { await file.writeFile(JSON.stringify(m, null, 2) + '\n'); await file.sync() }
    finally { await file.close() }
    if (first) await link(tmp, path)
    else await rename(tmp, path)
  } finally { await unlink(tmp).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}
async function readablePart(dir, ref, flags) {
  const path = join(dir, ref.name)
  const s = await stat(path)
  check(sameFile(s, ref) && s.nlink === 1n, '上传文件已被替换，请重新归档。')
  const file = await open(path, flags | NOFOLLOW)
  const opened = await file.stat({ bigint: true }).catch(async error => { await file.close(); throw error })
  if (sameFile(opened, ref) && opened.nlink === 1n) return file
  await file.close()
  throw new Error('上传文件已被替换，请重新归档。')
}
async function cleanup(dir, m) {
  if (!m.retired.length) return
  for (const ref of m.retired) await removeOwned(dir, ref)
  m.retired = []
  await saveManifest(dir, m)
}
// A crash between linking complete files and switching the manifest leaves the old snapshot valid.
// The pending token and file identities suffice to collect those links on abort or next begin.
function discardPending(m) {
  if (!m.pending) return
  for (const [part, ref] of Object.entries(m.pending.parts)) {
    m.retired.push(ref, { ...ref, name: publishedName(m.pending.token, part, extension(part, m.pending.data)) })
  }
  delete m.pending
}
function active(m, token) {
  check(validId(token) && m?.pending?.token === token, '上传已过期，请重新归档。')
  return m.pending
}

/** The profile and desktop opener come only from the Host composition. */
export function createMeetingArchive(profileDir, openFolder) {
  const locks = new Map()
  async function folder(id, create) {
    check(typeof profileDir === 'string' && isAbsolute(profileDir), '无法定位 DSH 配置目录。')
    let path = await realpath(profileDir)
    for (const segment of ['data', 'meeting-notes']) {
      path = join(path, segment)
      if (!await directory(path, create)) return null
    }
    path = join(path, id)
    if (await directory(path, false)) return path
    if (!create) return null
    await mkdir(path, { mode: 0o700 })
    await saveManifest(path, { format: FORMAT, id, generation: null, files: {}, retired: [] }, true)
    return path
  }
  function operation(fn, create = false) {
    return async (data, signal) => {
      const id = data?.id
      check(validId(id), '会议 ID 无效。')
      const previous = locks.get(id) || Promise.resolve()
      const run = previous.catch(() => {}).then(async () => {
        signal?.throwIfAborted()
        const payload = create ? description(data) : data
        const dir = await folder(id, create)
        const m = dir ? await manifest(dir, id) : null
        if (create) check(m, '会议目录已被其他文件占用。')
        return fn(payload, dir, m, signal)
      })
      locks.set(id, run)
      try { return await run }
      finally { if (locks.get(id) === run) locks.delete(id) }
    }
  }
  return {
    archiveBegin: operation(async (info, dir, m) => {
      discardPending(m)
      await cleanup(dir, m)
      // MediaRecorder bytes for a meeting are append-only. Only reuse this exact, still-present file.
      const saved = m.files.audio
      const skipAudio = !!(saved && info.sizes.audio > 0 && m.audioType === info.audioType &&
        saved.bytes === info.sizes.audio && sameFile(await stat(join(dir, saved.name)), saved))
      const pending = { token: randomUUID(), data: info, skipAudio, parts: {} }
      try {
        for (const part of PARTS) {
          if (part === 'audio' && (skipAudio || !info.sizes.audio)) continue
          const name = stagedName(pending.token, part)
          const file = await open(join(dir, name), 'wx', 0o600)
          try { pending.parts[part] = fileRef(name, await file.stat({ bigint: true })) }
          finally { await file.close() }
        }
        m.pending = pending
        await saveManifest(dir, m)
      } catch (error) {
        for (const ref of Object.values(pending.parts)) await removeOwned(dir, ref)
        throw error
      }
      return { uploadId: pending.token, chunkBytes: CHUNK_BYTES, skipAudio }
    }, true),
    archiveChunk: operation(async ({ uploadId, part, offset, base64 }, dir, m) => {
      const pending = active(m, uploadId)
      check(PARTS.includes(part) && Object.hasOwn(pending.parts, part), '无效的上传文件。')
      check(Number.isSafeInteger(offset) && offset >= 0 && typeof base64 === 'string' && base64.length <= 4 * CHUNK_BYTES / 3, '归档分块无效。')
      const bytes = Buffer.from(base64, 'base64')
      const end = offset + bytes.length
      check(bytes.length && bytes.toString('base64') === base64 && end <= pending.data.sizes[part], '归档分块大小或编码无效。')
      const file = await readablePart(dir, pending.parts[part], constants.O_RDWR)
      try {
        const size = (await file.stat()).size
        check(offset <= size, '归档分块缺少前序数据。')
        const overlap = Math.min(size - offset, bytes.length)
        if (overlap) {
          const existing = Buffer.alloc(overlap)
          const { bytesRead } = await file.read(existing, 0, overlap, offset)
          check(bytesRead === overlap && existing.equals(bytes.subarray(0, overlap)), '重复的归档分块内容不一致。')
        }
        for (let i = overlap; i < bytes.length;) {
          const { bytesWritten } = await file.write(bytes, i, bytes.length - i, offset + i)
          check(bytesWritten > 0, '归档分块未写入。')
          i += bytesWritten
        }
        return { nextOffset: end }
      } finally { await file.close() }
    }),
    archiveCommit: operation(async ({ id, uploadId }, dir, m, signal) => {
      check(validId(uploadId), '上传 ID 无效。')
      if (m?.generation === uploadId) {
        await cleanup(dir, m)
        return { id }
      }
      const pending = active(m, uploadId)
      // Validate the whole upload before any finished filename appears in Explorer.
      for (const [part, ref] of Object.entries(pending.parts)) {
        const s = await stat(join(dir, ref.name))
        check(sameFile(s, ref) && Number(s.size) === pending.data.sizes[part], '归档内容不完整，请重试。')
      }
      const files = {}
      if (pending.skipAudio) {
        const ref = m.files.audio
        check(sameFile(await stat(join(dir, ref.name)), ref), '上次归档的录音已变动，请重新归档。')
        files.audio = ref
      }
      for (const [part, ref] of Object.entries(pending.parts)) {
        signal?.throwIfAborted()
        const src = join(dir, ref.name)
        const ext = extension(part, pending.data)
        const name = publishedName(uploadId, part, ext)
        const dest = join(dir, name)
        const s = await stat(src)
        check(sameFile(s, ref) && Number(s.size) === pending.data.sizes[part], '归档内容不完整，请重试。')
        // A retry can observe its own previously created hard link. Never replace a foreign entry.
        const existing = await stat(dest)
        if (existing) check(sameFile(existing, ref), '归档文件名已被占用，请重新归档。')
        else await link(src, dest)
        const output = fileRef(name, s, true)
        if (part !== 'audio') {
          const file = await open(src, constants.O_RDONLY | NOFOLLOW)
          try {
            const hash = createHash('sha256')
            for await (const chunk of file.createReadStream({ autoClose: false })) hash.update(chunk)
            output.sha256 = hash.digest('hex')
          } finally { await file.close() }
          const old = m.files[part]
          if (old?.sha256 === output.sha256 && old.name.endsWith('.' + ext) && sameFile(await stat(join(dir, old.name)), old)) {
            files[part] = old
            m.retired.push(output)
          }
        }
        files[part] ??= output
        m.retired.push(ref)
      }
      for (const [part, old] of Object.entries(m.files)) {
        if (old.name !== files[part]?.name) m.retired.push(old)
      }
      Object.assign(m, pending.data, { generation: uploadId, files })
      delete m.pending
      await saveManifest(dir, m)
      await cleanup(dir, m)
      return { id }
    }),
    archiveAbort: operation(async ({ id, uploadId }, dir, m) => {
      if (validId(uploadId) && m?.pending?.token === uploadId) {
        discardPending(m)
        await saveManifest(dir, m)
        await cleanup(dir, m)
      }
      return { id }
    }),
    archiveOpen: operation(async ({ id }, dir, m, signal) => {
      check(m?.generation, '这场会议尚未归档。')
      await openFolder(dir, signal)
      return { id }
    }),
    archiveRename: operation(async ({ id, name }, dir, m) => {
      const value = meetingName(name)
      if (m && (m.name !== value || (m.pending && m.pending.data.name !== value))) {
        m.name = value
        if (m.pending) m.pending.data.name = value
        await saveManifest(dir, m)
      }
      return { id }
    }),
    archiveDelete: operation(async ({ id }, dir, m) => {
      if (!m) return { id }
      discardPending(m)
      m.retired.push(...Object.values(m.files))
      m.files = {}
      m.generation = null
      await saveManifest(dir, m)
      await cleanup(dir, m)
      await unlink(join(dir, MANIFEST))
      try { await rmdir(dir) }
      catch (error) { if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error }
      return { id }
    }),
  }
}
