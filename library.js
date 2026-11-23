// The archive is a local snapshot. Browser recordings remain playable before the first export.
function meetingSpeaker(row, names, t) {
  const id = row.speaker || ''
  if (row.override || names?.[id]) return row.override || names[id]
  if (!id || id.endsWith('-unknown')) return t(id.startsWith('system-') || row.source === 'system' ? 'unknownSystemSpeaker' : 'unknownMicSpeaker')
  return (id.startsWith('system-') ? t('remoteSpeaker') : t('micSpeaker')) + ' ' + id.split('-').pop()
}
function meetingTranscript(turns, names, t) {
  return turns.filter(row => row.text).map(row => `[${meetingClock(row.startMs)}] ${meetingSpeaker(row,names,t)}: ${row.text}`).join('\n')
}
function meetingNotebook(meeting, notes) {
  if (typeof meeting.notebook === 'string') return meeting.notebook
  const entries = notes.map(note => `[${meetingClock(note.at)}] ${note.text}`)
  // Bring over an unsubmitted draft from the former note form as well.
  try { const draft = sessionStorage.getItem('meeting-note-draft:' + meeting.id); if (draft) entries.push(draft) } catch { /* Storage can be disabled. */ }
  return entries.join('\n\n')
}
async function uploadMeetingFolder(call, meeting, turns, notes, audio, t) {
  const id = meeting.id
  const parts = {
    audio:audio || new Blob(),
    transcript:new Blob([meetingTranscript(turns,meeting.names,t)]),
    notebook:new Blob([meetingNotebook(meeting,notes)]),
    summary:new Blob([meeting.summary || '']),
  }
  const sizes = Object.fromEntries(Object.entries(parts).map(([key,blob]) => [key,blob.size]))
  const name = meeting.title || `${t('untitled')} ${new Date(meeting.started).toLocaleString()}`
  const {uploadId,chunkBytes,skipAudio} = await call('archiveBegin',{id,name,started:meeting.started,duration:Math.round(meeting.duration || 0),mode:meeting.mode,audioType:audio?.type || '',notebookFormat:meeting.notebookFormat === 'markdown' ? 'markdown' : 'plain',sizes})
  try {
    if (!Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > 1024 * 1024) throw new Error('Invalid meeting archive chunk size')
    for (const [part,blob] of Object.entries(parts)) {
      if (part === 'audio' && skipAudio) continue
      for (let offset = 0; offset < blob.size;) {
        const bytes = new Uint8Array(await blob.slice(offset,offset+chunkBytes).arrayBuffer())
        let binary = ''
        for (let i=0; i<bytes.length; i+=8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192))
        const {nextOffset} = await call('archiveChunk',{id,uploadId,part,offset,base64:btoa(binary)})
        if (nextOffset !== offset + bytes.length) throw new Error('Incomplete meeting archive chunk')
        offset = nextOffset
      }
    }
    await call('archiveCommit',{id,uploadId})
  } catch (error) {
    await call('archiveAbort',{id,uploadId}).catch(() => {})
    throw error
  }
  await call('archiveOpen',{id})
}

function meetingLibrary(db,call,t) {
  const subscribers = new Set(), notebooks = new Map(), sessionDrafts = new Map(), busy = new Set(), summarizing = new Set()
  let activeId = null, revision = 0
  const publish = event => { revision++; for (const notify of subscribers) notify(event) }
  function setNotebook(id,text,sessionDraft = false) {
    if (typeof text !== 'string') return Promise.reject(new TypeError('Invalid notebook'))
    const cache = sessionDraft ? sessionDrafts : notebooks
    let draft = cache.get(id)
    if (!draft) { draft = {}; cache.set(id,draft) }
    const notify = state => {
      draft.state = state
      publish(sessionDraft ? {type:'draft',sessionId:id,text:draft.text,notebookState:state}
        : {type:'patch',id,change:{notebook:draft.text,notebookFormat:'markdown'},notebookState:state})
    }
    draft.text = text
    if (!draft.write) {
      draft.write = Promise.resolve().then(async () => {
        for (;;) {
          const next = draft.text
          if (sessionDraft) await db.saveDraft(id,next)
          else if (!await db.update(id,{notebook:next,notebookFormat:'markdown'})) throw new Error(t('meetingGone'))
          if (draft.text === next) break
        }
        cache.delete(id)
        if (!sessionDraft) {
          try { sessionStorage.removeItem('meeting-note-draft:' + id) } catch { /* optional legacy draft */ }
        }
        notify('saved')
      }).catch(error => {
        draft.write = null; notify('error')
        throw error
      })
    }
    const write = draft.write
    notify('saving')
    return write
  }
  async function flush(id,sessionDraft = false) {
    const draft = (sessionDraft ? sessionDrafts : notebooks).get(id)
    if (draft) await (draft.write || setNotebook(id,draft.text,sessionDraft))
  }
  async function manage(id,operation) {
    if (busy.size || id === activeId || summarizing.has(id)) throw new Error(t('meetingBusy'))
    busy.add(id); publish({type:'busy',id})
    const run = async () => {
      const row = await db.meeting(id)
      if (!row) throw new Error(t('meetingGone'))
      return operation(row)
    }
    try {
      if (!globalThis.navigator?.locks) return await run()
      return await navigator.locks.request('dsh-meeting:' + id,{ifAvailable:true},lock => {
        if (!lock) throw new Error(t('meetingBusy'))
        return run()
      })
    } finally { busy.delete(id); publish({type:'busy',id:null}) }
  }
  return {
    get revision() { return revision }, get activeId() { return activeId }, get busyId() { return busy.values().next().value ?? null },
    setActive(id) { activeId = id; publish({type:'active',id}) },
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn) },
    publish, draft:(id,sessionDraft = false) => (sessionDraft ? sessionDrafts : notebooks).get(id), summarizing, setNotebook, flush,
    renameMeeting(id,title) {
      title = title.trim()
      if (!title || title.length > 120) return Promise.reject(new Error(t('invalidTitle')))
      return manage(id,async () => {
        await call('archiveRename',{id,name:title})
        if (!await db.update(id,{title})) throw new Error(t('meetingGone'))
        publish({type:'patch',id,change:{title}})
      })
    },
    deleteMeeting(id) {
      return manage(id,async () => {
        await notebooks.get(id)?.write?.catch(() => {})
        await call('archiveDelete',{id})
        await db.remove(id); notebooks.delete(id)
        try { sessionStorage.removeItem('meeting-note-draft:' + id) } catch { /* optional legacy draft */ }
        publish({type:'remove',id})
      })
    },
    openFolder(id) {
      return manage(id, async () => {
        await flush(id)
        const [row,turns,notes,audio] = await Promise.all([db.meeting(id),db.turns(id),db.notes(id),db.audio(id)])
        if (!row) throw new Error(t('meetingGone'))
        await uploadMeetingFolder(call,row,turns,notes,audio,t)
      })
    },
  }
}
