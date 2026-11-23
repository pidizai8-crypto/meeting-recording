function meetingClock(ms) {
  const sec = Math.max(0, Math.floor((ms || 0) / 1000))
  return (sec >= 3600 ? Math.floor(sec / 3600) + ':' : '') + String(Math.floor(sec / 60) % 60).padStart(2, '0') + ':' + String(sec % 60).padStart(2, '0')
}

function meetingRuntime(ctx, t) {
  const sessions = new Map()
  const db = meetingDatabase(() => {
    for (const session of sessions.values()) {
      if (!session.snapshot().initialized) session.fail(t('storageUpgradeBlocked'))
    }
  })
  const lifetime = new AbortController()
  let owner = null
  async function call(method, args = {}, signal = lifetime.signal) {
    const result = await ctx.connection.rpc.call('/api', 'meetingRecorder/' + method, args, signal)
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  const library = meetingLibrary(db,call,t)
  const recognition = new Map()
  function createSession(sessionId) {
    const listeners = new Set()
    let view = { initialized:false, meeting:null, history:[], turns:[], notes:[], phase:'idle', status:null, problem:'', speechError:'', working:false, preparing:false, summarizing:false, selecting:false }
    let capture = null, liveFrom = 0, selection = 0, disposed = false
    let draftTransfer = null, continuedDraftId = null
    let draining = false, preparing = false, checking = null, transcribing = null, engineError = ''
    view = {...view,activeId:library.activeId,historyBusy:library.busyId,draftNotebook:'',notebookState:'saved'}
    const queues = new Map(), speechErrors = new Map()
    const update = patch => { if (!disposed) { view = {...view, ...patch}; for (const fn of listeners) fn() } }
    const message = error => String(error?.message || error)
    const fail = error => update({problem:message(error)})
    const elapsed = () => liveFrom ? Math.max(0,performance.now() - liveFrom) : (view.meeting?.duration || 0)
    function updateMeeting(id,change) { library.publish({type:'patch',id,change}) }
    const unsubscribe = library.subscribe(event => {
      const {type,id,change} = event
      const selected = view.meeting?.id === id
      if (type === 'draft') {
        if (event.sessionId === sessionId && draftTransfer?.text === undefined) {
          update({draftNotebook:event.text,...(!view.meeting && {notebookState:event.notebookState})})
        }
      } else if (type === 'patch') {
        const metadata = meetingHistoryRow(change)
        const history = Object.keys(metadata).length ? view.history.map(row => row.id === id ? {...row,...metadata} : row) : view.history
        const patch = {history}
        if (selected) {
          patch.meeting = {...view.meeting,...change}
          if (event.notebookState) patch.notebookState = event.notebookState
        }
        update(patch)
      } else if (type === 'busy') update(id ? {historyBusy:id,problem:view.meeting?.saveError || ''} : {historyBusy:null})
      else if (type === 'active') update({activeId:id})
      else if (type === 'new') update({history:[meetingHistoryRow(event.row),...view.history.filter(row => row.id !== id)]})
      else if (type === 'segment' && selected && !view.turns.some(row => row.key === event.row.key)) update({turns:[...view.turns,event.row].sort((a,b) => a.startMs - b.startMs)})
      else if (type === 'transcribed' && selected) {
        const changed = new Map(event.rows.map(row => [row.key,row]))
        update({turns:[...view.turns.filter(row => !changed.has(row.key)),...event.rows].sort((a,b) => a.startMs-b.startMs)})
      } else if (type === 'turn' && selected) update({turns:view.turns.map(row => row.key === event.key ? {...row,...event.patch} : row)})
      else if (type === 'remove') {
        queues.delete(id); speechErrors.delete(id)
        const history = view.history.filter(row => row.id !== id)
        update(selected ? {history,meeting:null,turns:[],notes:[],notebookState:'saved',problem:''} : {history})
        if (selected) void select(null).catch(fail)
      }
    })
    function historical(row) {
      return {...row,saveState:row.saveState === 'recording' && row.id !== library.activeId ? 'interrupted' : row.saveState || (row.hasAudio?'saved':'failed')}
    }
    async function refreshHistory() {
      const revision = library.revision
      const history = (await db.history()).map(historical)
      if (revision === library.revision) update({history})
      else if (!disposed) return refreshHistory()
    }
    async function status() {
      if (!checking) checking = call('status').then(result => { update({status:result}); return result }).finally(() => {checking = null})
      return checking
    }
    const isReady = value => ['ready','standby'].includes(value?.phase)
    function feedback() {
      const id = view.meeting?.id
      const working = !!transcribing && transcribing === id
      const backgroundWorking = !!transcribing && transcribing !== id
      const speechError = speechErrors.get(id) || engineError
      if (view.working !== working || view.backgroundWorking !== backgroundWorking || view.speechError !== speechError) update({working,backgroundWorking,speechError})
    }
    function enqueue(id,row) {
      if (!queues.has(id)) queues.set(id,{scan:false,rows:new Map()})
      const queue = queues.get(id)
      if (row) queue.rows.set(row.key,row)
      else queue.scan = true
    }
    async function select(id) {
      if (view.phase !== 'idle' || view.summarizing) return
      const turn = ++selection
      continuedDraftId = null
      update({selecting:true})
      try {
        let history, meeting, turns, notes, draftNotebook, pending, revision
        // A queued RPC or an edit can commit while historical records are being read.
        do {
          revision = library.revision
          const [rows,storedDraft,pendingIds] = await Promise.all([db.history(),db.readDraft(sessionId),db.pendingMeetings()])
          history = rows.map(historical)
          draftNotebook = library.draft(sessionId,true)?.text ?? storedDraft
          pending = pendingIds
          ;[meeting,turns,notes] = id ? await Promise.all([db.meeting(id),db.turns(id),db.notes(id)]) : [null,[],[]]
          if (meeting) {
            meeting = historical(meeting)
            const edit = library.draft(meeting.id)
            meeting.notebook = edit?.text ?? meetingNotebook(meeting,notes)
            if (edit) meeting.notebookFormat = 'markdown'
            if (meeting.saveState === 'interrupted') meeting.hasAudio = await db.hasAudio(meeting.id)
          }
        } while (turn === selection && !disposed && revision !== library.revision)
        if (turn !== selection || disposed) return
        if (!view.initialized) for (const row of history) {
          if (row.sessionId === sessionId && row.id !== library.activeId && pending.has(row.id)) enqueue(row.id)
        }
        if (meeting && meeting.id !== library.activeId && pending.has(meeting.id)) enqueue(meeting.id)
        const edit = meeting ? library.draft(meeting.id) : library.draft(sessionId,true)
        update({history,meeting:meeting || null,turns,notes,draftNotebook,notebookState:edit?.state || 'saved',problem:meeting?.saveError || '',initialized:true,selecting:false})
        feedback()
        if (queues.size || (!view.status && (meeting?.hasAudio || turns.length))) {
          void status().then(drain).catch(error => {engineError = message(error); feedback()})
        }
      } finally { if (turn === selection) update({selecting:false}) }
    }
    async function transcribe(row) {
      const bytes = await db.readPcm(row.meetingId,row.key)
      if (!bytes) {
        const latest = await db.turn(row.meetingId,row.key)
        if (!latest || latest.done) return
        throw new Error(t('missingAudio'))
      }
      let binary = ''
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192))
      const result = await call('transcribe',{pcm:btoa(binary),language:row.language || 'zh',speakerTurns:true})
      if (disposed) return
      const parts = Array.isArray(result.parts) ? result.parts : [{from:0,to:row.endMs-row.startMs,text:result.text}]
      if (!parts.length || parts.some(p => !Number.isFinite(p.from) || !Number.isFinite(p.to) || p.to < p.from || typeof p.text !== 'string')) {
        throw new Error(t('invalidTranscript'))
      }
      const rows = await db.finishTurn(row,parts)
      library.publish({type:'transcribed',id:row.meetingId,rows})
    }
    async function drain() {
      if (draining || disposed || !isReady(view.status)) return
      draining = true
      try {
        while (!disposed && queues.size && isReady(view.status)) {
          const [id,queue] = queues.entries().next().value
          // Rotate after each turn so an earlier meeting cannot starve a live one.
          queues.delete(id)
          queues.set(id,queue)
          if (speechErrors.has(id)) { queues.delete(id); continue }
          try {
            if (queue.scan) {
              queue.scan = false
              for (const row of await db.turns(id)) if (!row.done) queue.rows.set(row.key,row)
            }
            if (disposed) break
            const row = queue.rows.values().next().value
            if (row) {
              transcribing = id
              feedback()
              const key = row.meetingId + '/' + row.key
              if (!recognition.has(key)) recognition.set(key,transcribe(row).finally(() => recognition.delete(key)))
              await recognition.get(key)
              queue.rows.delete(row.key)
            }
            if (!queue.scan && !queue.rows.size) queues.delete(id)
          } catch (error) {
            // PCM remains durable. An explicit retry rescans just this meeting.
            if (!disposed) speechErrors.set(id,message(error))
            queues.delete(id)
          }
        }
      } finally { transcribing = null; draining = false; feedback() }
    }
    function clearSpeechError() {
      engineError = ''
      const id = view.meeting?.id
      if (speechErrors.delete(id)) enqueue(id)
      feedback()
    }
    async function prepare() {
      if (preparing) return
      preparing = true
      clearSpeechError()
      update({preparing:true})
      const timer = setInterval(() => { void status().catch(() => {}) }, 1200)
      try { await call('prepare'); await status(); await drain() }
      catch (error) { engineError = message(error); feedback(); await status().catch(() => {}) }
      finally { clearInterval(timer); preparing = false; update({preparing:false}) }
    }
    async function start(mode, language = 'zh') {
      if (owner || view.phase !== 'idle') throw new Error(t('alreadyRecording'))
      if (!view.initialized || view.selecting || view.summarizing) return
      const meeting = {id:crypto.randomUUID(),sessionId,started:Date.now(),mode,language,duration:0,hasAudio:false,saveState:'recording',names:{},summary:''}
      let releaseRecordingLock
      const holdRecording = new Promise(resolve => {releaseRecordingLock = resolve})
      const writes = new Set()
      let header = null, headerSaved = false, audioWrite = null, chunks = 0, sequence = 0, stamp = 0
      let firstError = '', finalizing = null, cancelledStart = false, interrupted = false
      function recordError(error) {
        if (cancelledStart && error?.name === 'AbortError') return
        if (!firstError) firstError = message(error)
        if (capture === current) fail(firstError)
      }
      function track(operation) {
        writes.add(operation)
        operation.catch(error => {
          recordError(error)
          void device.stop().catch(recordError)
        }).finally(() => writes.delete(operation))
      }
      async function saveResult(duration) {
        await Promise.allSettled([...writes])
        if (!headerSaved) return // Device access or the atomic header write failed.
        const hasAudio = chunks > 0
        if (!hasAudio && !firstError) firstError = t('noAudio')
        const saveState = !hasAudio ? 'failed' : firstError ? 'partial' : interrupted ? 'interrupted' : 'saved'
        const result = {duration,hasAudio,saveState,saveError:firstError}
        try {
          await db.update(meeting.id,result)
        } catch (error) {
          recordError(error)
          result.saveState = hasAudio ? 'partial' : 'failed'
          result.saveError = firstError
          // If the journal cannot be finalized, reload sees the durable recording marker.
          await db.update(meeting.id,result).catch(recordError)
        }
        updateMeeting(meeting.id,result)
        if (firstError && capture === current) fail(firstError)
      }
      function finalize() {
        if (!finalizing) {
          const duration = liveFrom ? elapsed() : 0
          liveFrom = 0
          finalizing = saveResult(duration).finally(() => {
            releaseRecordingLock()
            if (capture === current) { capture = null; owner = null; library.setActive(null); update({phase:'idle'}) }
          })
        }
        return finalizing
      }
      // Keep the existing editor live while IndexedDB commits. Keystrokes made in
      // the draft during that window follow the commit, or return to the draft on failure.
      function beginRecording() {
        const shownDraft = view.draftNotebook
        const transfer = {text:undefined,write:null}
        draftTransfer = transfer
        transfer.header = Promise.resolve().then(async () => {
          let row
          try {
            await library.flush(sessionId,true)
            row = await db.beginMeeting(meeting,shownDraft,() => transfer.text)
          } catch (error) {
            draftTransfer = null
            if (transfer.text !== undefined) await library.setNotebook(sessionId,transfer.text,true).catch(() => {})
            throw error
          }
          headerSaved = true
          library.setActive(meeting.id)
          library.publish({type:'new',id:meeting.id,row})
          continuedDraftId = view.meeting ? null : meeting.id
          draftTransfer = null
          if (transfer.text !== undefined && transfer.text !== row.notebook) {
            row = {...row,notebook:transfer.text}
            transfer.write = library.setNotebook(meeting.id,transfer.text)
            transfer.write.catch(() => {}) // setNotebook callers receive the save failure.
          }
          update({meeting:row,turns:[],notes:[],draftNotebook:'',notebookState:transfer.write ? 'saving' : 'saved',problem:''})
          feedback()
        })
        return transfer.header
      }
      const device = createMeetingCapture({
        desktopAudio: desktopMeetingAudioAvailable() ? (context,signal,onError) => windowsMeetingAudio(call,context,signal,onError) : undefined,
        onState(phase) {
          if (phase === 'recording') {
            liveFrom = performance.now()
            header = beginRecording()
            track(header)
            if (globalThis.navigator?.locks) void navigator.locks.request('dsh-meeting:' + meeting.id,() => holdRecording).catch(recordError)
            update({phase})
          } else if (phase === 'idle') { void finalize().catch(recordError) }
          else update({phase})
        },
        onSegment({pcm,startMs,endMs,source}) {
          if (!header) return
          const row = {meetingId:meeting.id,key:++sequence,startMs,endMs,speaker:source+'-unknown',source,language,text:'',done:false}
          track(header.then(() => db.addTurn(row,pcm)).then(() => {
            library.publish({type:'segment',id:meeting.id,row})
            enqueue(meeting.id,row)
            void drain()
          }))
        },
        onRecordingChunk({blob,index}) {
          if (!header) return
          const duration = elapsed()
          // Container chunks depend on their prefix. Never append beyond a failed write.
          audioWrite = (audioWrite || header).then(() => db.addChunk(meeting.id,index,blob)).then(async () => {
            chunks++
            if (chunks === 1 || duration - stamp >= 5000) {
              stamp = duration
              await db.update(meeting.id,{hasAudio:true,duration})
              updateMeeting(meeting.id,{hasAudio:true,duration})
            }
          })
          track(audioWrite)
        },
        onError:recordError,
      })
      const current = {
        async stop(unloading = false) {
          if (!header) cancelledStart = true
          if (unloading) interrupted = true
          await device.stop()
          await finalize()
        },
      }
      owner = api
      capture = current
      try {
        // Device selection needs the original button's browser activation.
        await device.start(mode)
        await header
        void status().then(drain).catch(error => {engineError = message(error); feedback()})
      } catch (error) {
        const cancelled = cancelledStart && error?.name === 'AbortError'
        if (!cancelled) recordError(error)
        await device.stop().catch(recordError)
        await finalize()
        if (!cancelled) throw error
      }
    }
    async function stop() { await capture?.stop() }
    function setNotebook(id,text) {
      if (typeof text !== 'string') return Promise.reject(new TypeError('Invalid notebook'))
      if (!view.initialized || view.selecting) return Promise.reject(new Error(t('meetingGone')))
      if (id === null && !view.meeting) {
        const transfer = draftTransfer
        if (!transfer) return library.setNotebook(sessionId,text,true)
        transfer.text = text
        update({draftNotebook:text,notebookState:'saving'})
        return transfer.header.then(() => transfer.write)
      }
      // The old draft editor can deliver one last input before React mounts the meeting editor.
      if (id === null && continuedDraftId === view.meeting?.id) id = continuedDraftId
      if (!id || id !== view.meeting?.id) return Promise.reject(new Error(t('meetingGone')))
      if (id === library.busyId) return Promise.reject(new Error(t('meetingBusy')))
      return library.setNotebook(id,text)
    }
    const speaker = row => meetingSpeaker(row,view.meeting?.names,t)
    async function editSpeaker(row, value, all) {
      const name = value.trim()
      if (!name || view.meeting?.id !== row.meetingId) return
      if (all && !row.speaker?.endsWith('-unknown')) {
        const names = await db.renameSpeaker(row.meetingId,row.speaker,name,row.key)
        updateMeeting(row.meetingId,{names})
        library.publish({type:'turn',id:row.meetingId,key:row.key,patch:{override:''}})
      } else {
        await db.editTurn(row.meetingId,row.key,{override:name})
        library.publish({type:'turn',id:row.meetingId,key:row.key,patch:{override:name}})
      }
    }
    async function summarize() {
      if (view.summarizing || !view.meeting) return
      const m = view.meeting
      if (library.busyId === m.id || library.summarizing.has(m.id)) throw new Error(t('meetingBusy'))
      const transcript = meetingTranscript(view.turns,m.names,t)
      const notes = m.notebook || ''
      library.summarizing.add(m.id)
      update({summarizing:true,problem:''})
      try {
        await library.flush(m.id)
        const summary = await call('summarize',{title:m.title || t('title'),transcript,notes})
        await db.update(m.id,{summary}); updateMeeting(m.id,{summary})
      } finally { library.summarizing.delete(m.id); update({summarizing:false}) }
    }
    async function refresh() {
      clearSpeechError()
      if (!view.initialized) await select()
      await status()
      await drain()
    }
    const api = {subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }, snapshot:() => view,
      notebookKey:() => !view.meeting || continuedDraftId === view.meeting.id ? 'draft' : view.meeting.id,
      elapsed, start, stop, setNotebook, select, showDraft:() => select(null), refreshHistory, prepare, refresh, summarize, speaker, editSpeaker, audio:id => db.audio(id), fail,
      renameMeeting:library.renameMeeting, deleteMeeting:library.deleteMeeting, openFolder:library.openFolder,
      dispose() { disposed = true; unsubscribe(); void capture?.stop(true).catch(() => {}); listeners.clear() },
    }
    void select().catch(fail)
    return api
  }
  return { session(id) { if (!sessions.has(id)) sessions.set(id,createSession(id)); return sessions.get(id) },
    dispose() { for (const s of sessions.values()) s.dispose(); sessions.clear(); lifetime.abort() } }
}
