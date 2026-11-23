// Audio chunks and pending PCM live in separate stores so history and transcript reads stay small.
function meetingHistoryRow(row) {
  const {notebook,summary,names,voiceGroups,...metadata} = row
  return metadata
}

function meetingDatabase(onUpgradeBlocked = () => {}) {
  let opening
  const open = () => {
    if (!opening) opening = new Promise((resolve, reject) => {
      const request = indexedDB.open('dsh-meeting-recorder-v1', 2)
      request.onupgradeneeded = ({oldVersion}) => {
        const db = request.result
        if (oldVersion < 1) {
          db.createObjectStore('meetings', { keyPath: 'id' }).createIndex('session', 'sessionId')
          for (const name of ['turns', 'pcm', 'audio', 'notes']) {
            db.createObjectStore(name, { keyPath: ['meetingId', 'key'] }).createIndex('meeting', 'meetingId')
          }
        }
        db.createObjectStore('drafts') // sessionId → Markdown
      }
      request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); opening = null }; resolve(db) }
      request.onblocked = onUpgradeBlocked
      request.onerror = () => { opening = null; reject(request.error) }
    })
    return opening
  }
  async function transaction(names, mode, run) {
    const db = await open()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(names, mode)
      let result
      tx.oncomplete = () => resolve(result?.result)
      tx.onabort = () => reject(tx.error || new Error('Storage transaction aborted'))
      try { result = run(name => tx.objectStore(name)) } catch (error) { tx.abort(); reject(error) }
    })
  }
  const list = (name, index, key) => transaction(name, 'readonly', s => s(name).index(index).getAll(key))
  const put = (name, row) => transaction(name, 'readwrite', s => s(name).put(row))
  const patch = (name, key, change) => transaction(name, 'readwrite', s => {
    const updated = {result:false}
    const get = s(name).get(key)
    get.onsuccess = () => {
      if (!get.result) return
      s(name).put({ ...get.result, ...change }); updated.result = true
    }
    return updated
  })
  const childStores = ['turns','pcm','audio','notes']
  return {
    history: () => transaction('meetings','readonly', s => s('meetings').getAll()).then(rows => rows.map(meetingHistoryRow).sort((a,b) => b.started - a.started)),
    meeting: id => transaction('meetings','readonly', s => s('meetings').get(id)),
    remove: id => transaction(['meetings',...childStores], 'readwrite', s => {
      s('meetings').delete(id)
      for (const name of childStores) {
        const store = s(name)
        const cursor = store.index('meeting').openKeyCursor(IDBKeyRange.only(id))
        cursor.onsuccess = () => {
          const row = cursor.result
          if (row) { store.delete(row.primaryKey); row.continue() }
        }
      }
    }),
    readDraft: sessionId => transaction('drafts','readonly', s => s('drafts').get(sessionId)).then(text => text ?? ''),
    saveDraft: (sessionId,text) => transaction('drafts','readwrite', s => text ? s('drafts').put(text,sessionId) : s('drafts').delete(sessionId)),
    beginMeeting: (row, shownDraft, latestInput) => transaction(['drafts','meetings'],'readwrite', s => {
      const result = {result:null}
      const draft = s('drafts').get(row.sessionId)
      draft.onsuccess = () => {
        const stored = draft.result ?? ''
        const notebook = latestInput?.() ?? stored
        result.result = {...row,notebook,notebookFormat:'markdown'}
        s('meetings').add(result.result)
        // Another tab may have saved a different draft while this editor kept typing.
        if (notebook === stored || shownDraft === stored) s('drafts').delete(row.sessionId)
      }
      return result
    }),
    save: row => put('meetings', row), update: (id, change) => patch('meetings', id, change),
    forgetEmpty: id => transaction('meetings', 'readwrite', s => s('meetings').delete(id)),
    pendingMeetings: () => transaction('pcm','readonly', s => {
      const ids = new Set()
      const cursor = s('pcm').index('meeting').openKeyCursor(null,'nextunique')
      cursor.onsuccess = () => { if (cursor.result) { ids.add(cursor.result.key); cursor.result.continue() } }
      return {result:ids}
    }),
    turns: id => list('turns', 'meeting', id).then(rows => rows.sort((a,b) => a.startMs - b.startMs)),
    addTurn: (turn, bytes) => transaction(['turns','pcm'], 'readwrite', s => {
      s('turns').put(turn); s('pcm').put({meetingId: turn.meetingId, key: turn.key, bytes})
    }),
    readPcm: (id, key) => transaction('pcm', 'readonly', s => s('pcm').get([id,key])).then(row => row?.bytes),
    finishTurn: (turn, parts) => transaction(['meetings','turns','pcm'], 'readwrite', s => {
      const result = {result:[]}, key = [turn.meetingId,turn.key]
      const rows = s('turns'), row = rows.get(key), header = s('meetings').get(turn.meetingId)
      header.onsuccess = () => {
        const old = row.result, meeting = header.result
        if (!old || !meeting) return
        if (old.done) {
          // Another client won the transaction. Return its original assignment and every split.
          result.result.push(old)
          for (const childKey of old.childKeys || []) {
            const request = rows.get([turn.meetingId,childKey])
            request.onsuccess = () => { if (request.result) result.result.push(request.result) }
          }
          return
        }
        const groups = meeting.voiceGroups || {}, source = old.source === 'system' ? 'system' : 'mic'
        const spoken = parts.filter(part => part.text || part.languageUncertain)
        const output = spoken.length ? spoken : [{text:'',from:0,to:old.endMs-old.startMs}]
        const labels = meetingTurnLabels(groups,source,output)
        result.result = output.map((part,index) => {
          const speaker = labels[index]
          const offset = ms => Math.min(old.endMs,Math.max(old.startMs,old.startMs+ms))
          return {...old, key:index ? `${turn.key}/${index}` : turn.key, speaker,
            startMs:offset(part.from), endMs:offset(part.to), text:part.text, done:true,
            languageUncertain:!!part.languageUncertain}
        })
        result.result[0].childKeys = result.result.slice(1).map(child => child.key)
        for (const outputRow of result.result) rows.put(outputRow)
        s('meetings').put({...meeting,voiceGroups:groups})
        s('pcm').delete(key)
      }
      return result
    }),
    turn: (id,key) => transaction('turns','readonly', s => s('turns').get([id,key])),
    editTurn: (id,key,change) => patch('turns',[id,key],change),
    renameSpeaker: (id,speakerId,name,selectedKey) => transaction(['meetings','turns'],'readwrite', s => {
      const result = {result:null}
      const meeting = s('meetings').get(id)
      meeting.onsuccess = () => {
        if (!meeting.result) return
        result.result = {...meeting.result.names, [speakerId]:name}
        s('meetings').put({...meeting.result, names:result.result})
        if (selectedKey !== undefined) {
          const turns = s('turns'), selected = turns.get([id,selectedKey])
          selected.onsuccess = () => {
            if (selected.result?.speaker === speakerId && selected.result.override) turns.put({...selected.result,override:''})
          }
        }
      }
      return result
    }),
    hasAudio: id => transaction('audio','readonly', s => s('audio').index('meeting').count(id)).then(count => count > 0),
    addChunk: (id,key,blob) => put('audio',{meetingId:id,key,blob}),
    audio: async id => { const parts = await list('audio','meeting',id); return parts.length ? new Blob(parts.map(row => row.blob), {type: parts[0].blob.type}) : null },
    notes: id => list('notes','meeting',id).then(rows => rows.sort((a,b) => a.at-b.at || a.created-b.created)),
    saveNote: note => put('notes',note),
  }
}
