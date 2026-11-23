function RecorderGlyph({name='wave',size=18,className}) {
  const strokes = {
    wave:'M3 10v4m4-9v14m5-17v20m5-16v12m4-8v4',
    mic:'M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3ZM5 11v1a7 7 0 0 0 14 0v-1M12 19v3m-4 0h8',
    note:'M5 4h14v13l-4 4H5zM8 9h8m-8 4h5', summary:'M5 4h14v16H5zM8 8h8m-8 4h8m-8 4h5',
    edit:'m5 16 11-11 3 3L8 19l-4 1z', play:'m7 4 13 8-13 8Z', stop:'M6 6h12v12H6z',
    history:'M4 10a8 8 0 1 1 1 8m-1-8V5m0 5h5m3-3v5l3 2', back:'m10 5-7 7 7 7m-7-7h18',
    folder:'M3 18V6a1 1 0 0 1 1-1h5l2 3h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1Z',
    download:'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
    trash:'M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15m-8 4v7m4-7v7',
  }
  return h('svg',{width:size,height:size,viewBox:'0 0 24 24',fill:'none',stroke:'currentColor',strokeWidth:1.7,strokeLinecap:'round',strokeLinejoin:'round',className,'aria-hidden':true},h('path',{d:strokes[name]}))
}
function meetingButton(label, onClick, options={}) {
  const {icon, ...props} = options
  return h('button',{type:'button',onClick,...props},icon && h(RecorderGlyph,{name:icon,size:16}),label)
}
function RecorderTime({api,phase,duration,t}) {
  const [now,setNow] = React.useState(0)
  React.useEffect(() => { if (phase !== 'recording') return; const update = () => setNow(api.elapsed()); update(); const id = setInterval(update,500); return () => clearInterval(id) },[api,phase])
  return h('span',{className:'mn-time','aria-label':t('clock')},meetingClock(phase === 'recording' ? now : duration))
}
function RecorderEmpty({title,subtitle}) {
  return h('div',{className:'mn-empty'},h('strong',null,title),subtitle && h('p',null,subtitle))
}
function RecorderSheet({title,icon,children}) {
  const heading = React.useId()
  return h('section',{className:'mn-sheet','aria-labelledby':heading},
    h('h3',{id:heading},h(RecorderGlyph,{name:icon,size:16}),title),children)
}
function downloadMeetingNotes(value,meeting,t) {
  const plain = meeting && meeting.notebookFormat !== 'markdown'
  const source = plain ? notebookModel.documentSource(value,true) : null
  const markdown = source ? source.serialize(source.doc) : value
  const url = URL.createObjectURL(new Blob([markdown],{type:'text/markdown;charset=utf-8'}))
  const link = document.createElement('a')
  const title = (meeting?.title || (meeting ? t('notes') : t('draftNotebook'))).replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').slice(0,100)
  link.href = url
  link.download = `${title}.md`
  try { link.click() } finally { setTimeout(() => URL.revokeObjectURL(url),30000) }
}
function RecorderNotes({api,view,t}) {
  const meeting = view.meeting, id = meeting?.id ?? null
  const value = (meeting ? meeting.notebook : view.draftNotebook) ?? ''
  const save = markdown => {
    void api.setNotebook(id,markdown).catch(error => {
      if (api.snapshot().notebookState !== 'error') api.fail(error)
    })
  }
  const status = view.notebookState === 'error' ? 'saveError' : view.notebookState === 'saving' ? 'savingNotes' : 'notesSaved'
  const disabled = !view.initialized || view.selecting || (id !== null && view.historyBusy === id)
  return h(React.Fragment,null,
    h(RecorderMarkdownEditor,{value,format:meeting ? meeting.notebookFormat || 'plain' : 'markdown',onChange:save,disabled,t,
      placeholder:t(meeting ? 'notePlaceholder' : 'noteFirst'),
      getTimestamp:view.phase === 'recording' && id === view.activeId ? () => `[${meetingClock(api.elapsed())}] ` : undefined}),
    view.initialized && (value || status !== 'notesSaved') && h('div',{className:'mn-save-status'},
      h('small',{role:'status','aria-atomic':true},t(status)),
      status === 'saveError' && meetingButton(t('retrySave'),() => save(value)),
      value && h('button',{type:'button',className:'mn-export-notes',title:t('exportNotes'),'aria-label':t('exportNotes'),
        onClick:() => downloadMeetingNotes(value,meeting,t)},h(RecorderGlyph,{name:'download',size:15}))))
}
function RecorderTranscript({api,view,t}) {
  const [edit,setEdit] = React.useState(null), [name,setName] = React.useState(''), [all,setAll] = React.useState(true)
  const rows = view.turns.filter(row => row.text || row.languageUncertain)
  if (!rows.length) {
    const active = !!view.meeting && view.meeting.id === view.activeId, pending = view.turns.some(row => !row.done)
    return h(RecorderEmpty,{icon:'wave',title:t(pending ? (view.working?'recognizing':'waiting') : active?'listening':view.meeting?'noSpeech':'emptyTranscript'),subtitle:t(pending ? (view.working?'listenHint':'awaiting') : active?'listenHint':view.meeting?'noSpeechHint':'emptyHint')})
  }
  return h(React.Fragment,null,h('p',{className:'mn-hint'},t('speakerHint')),
    ...rows.slice().reverse().map(row => h('article',{key:row.key,className:'mn-turn'},
      h('div',{className:'mn-line'},meetingButton(row.override || api.speaker(row),() => {setEdit(row.key);setName(row.override||api.speaker(row));setAll(!row.override && !row.speaker?.endsWith('-unknown'))},{title:t('editSpeaker'),className:'mn-speaker',icon:'edit'}),h('time',null,view.meeting?.mode === 'both' && (row.override || !row.speaker?.endsWith('-unknown')) ? `${t(row.source === 'system' || row.speaker?.startsWith('system-') ? 'system' : 'mic')} · ` : '',meetingClock(row.startMs))),
      edit === row.key && h('form',{className:'mn-edit',onSubmit:async e => {e.preventDefault();try {await api.editSpeaker(row,name,all);setEdit(null)} catch(error){api.fail(error)}}},
        h('label',{className:'mn-label'},t('speakerName'),h('input',{autoFocus:true,value:name,maxLength:80,onChange:e => setName(e.target.value)})),
        !row.speaker?.endsWith('-unknown') && h('label',{className:'mn-check'},h('input',{type:'checkbox',checked:all,onChange:e => setAll(e.target.checked)}),t('allSpeaker')),
        h('div',{className:'mn-actions'},h('button',{type:'submit',disabled:!name.trim()},t('save')),meetingButton(t('cancel'),() => setEdit(null)))),
      h('p',{className:row.languageUncertain?'mn-hint':undefined},row.languageUncertain?t('unclearChinese'):row.text))))
}
function RecorderMinutes({api,view,t}) {
  const hasText = view.turns.some(row => row.text) || !!view.meeting?.notebook?.trim()
  const minutes = view.meeting?.summary
  return h(React.Fragment,null,
    !minutes && h(RecorderEmpty,{title:t('emptySummary'),subtitle:t('summaryHint')}),
    minutes && h('div',{className:'mn-minutes'},...minutes.split('\n').map((line,i) => {
      const text = line.trim().replace(/\*\*(.*?)\*\*/g,'$1')
      if (!text) return null
      if (/^#{1,6}\s/.test(text)) return h('h4',{key:i},text.replace(/^#+\s*/,''))
      return h('p',{key:i},text.replace(/^[-*]\s/,'• '))
    })),
    view.turns.some(row => !row.done) && h('p',{className:'mn-hint'},t('summaryPending')),
    meetingButton(t(view.summarizing?'summarizing':minutes?'regenerate':'generate'),() => {void api.summarize().catch(api.fail)},{disabled:!hasText || view.selecting || view.summarizing}),
    h('p',{className:'mn-hint'},t('summaryPrivacy')))
}
function RecorderModel({api,view,t}) {
  const model = view.status, ready = ['ready','standby'].includes(model?.phase)
  const externalPrep = ['checking','downloading','loading','waking','cancelling'].includes(model?.phase)
  React.useEffect(() => {
    if (!externalPrep || view.preparing) return
    const timer = setInterval(() => {void api.refresh().catch(api.fail)},1500)
    return () => clearInterval(timer)
  },[api,externalPrep,view.preparing])
  if (ready && !view.speechError) return null
  const progress = model?.totalBytes ? Math.min(100,Math.floor(100 * model.completedBytes / model.totalBytes)) : null
  return h('div',{className:'mn-model'},
    h('strong',null,t(view.preparing || externalPrep?'preparing':model?'localModel':'modelUnknown')),
    model && !ready && h('p',null,t(model.phase === 'unavailable'?'modelAbsent':'modelNeeded')),
    !ready && !view.preparing && model && model.phase !== 'unavailable' && h('small',null,t('modelSize')),
    (view.preparing || externalPrep) && h('div',{className:'mn-progress'},h('progress',{max:100,value:progress ?? undefined,'aria-label':t('preparing')}),progress !== null && h('small',null,progress+'%')),
    (view.speechError || model?.message) && h('p',{className:'mn-error',role:'status'},view.speechError || model.message),
    !view.preparing && !externalPrep && meetingButton(t(ready?'retry':model && model.phase !== 'unavailable'?'prepare':'retryStatus'),() => {void (ready || !model || model.phase === 'unavailable' ? api.refresh() : api.prepare()).catch(api.fail)}))
}
function RecorderPlayback({api,meeting,t}) {
  const [file,setFile] = React.useState(null),[busy,setBusy] = React.useState(false)
  const alive = React.useRef(true)
  React.useEffect(() => {alive.current = true; return () => {alive.current = false}},[])
  React.useEffect(() => () => {if(file) URL.revokeObjectURL(file.url)},[file])
  const open = async () => {
    if(file) {setFile(null);return}
    setBusy(true)
    try { const blob = await api.audio(meeting.id); if (!alive.current) return; if (!blob) throw new Error(t('noAudio')); setFile({url:URL.createObjectURL(blob),ext:/mp4/.test(blob.type)?'m4a':/ogg/.test(blob.type)?'ogg':'webm'}) }
    catch(error) {api.fail(error)} finally {if(alive.current)setBusy(false)}
  }
  return h('div',{className:'mn-play'},meetingButton(t(busy?'audioLoading':file?'hidePlayer':'play'),open,{className:'mn-link',icon:'play',disabled:busy}),
    file && h(React.Fragment,null,h('audio',{controls:true,src:file.url,'aria-label':t('play')}),h('a',{href:file.url,download:'meeting-'+new Date(meeting.started).toISOString().replace(/[:.]/g,'-')+'.'+file.ext},t('download'))))
}
function recorderTitle(row,date,t) {
  return row.title || `${t('untitled')} · ${date(row.started)}`
}
function RecorderHistoryRow({row,api,view,date,t,operation,setOperation,onSelect,onDeleted}) {
  const title = recorderTitle(row,date,t)
  const current = row.id === view.meeting?.id
  const active = row.id === view.activeId
  const busy = !!view.historyBusy || view.selecting || view.summarizing
  const action = operation?.id === row.id ? operation.action : null
  const [draft,setDraft] = React.useState('')
  const origin = React.useRef(null), editing = React.useRef(null)
  const confirmation = React.useId()
  React.useLayoutEffect(() => {
    if (action === 'rename') editing.current?.select()
  },[action])
  const begin = (name,button) => {
    origin.current = button
    setDraft(title)
    setOperation({id:row.id,action:name})
  }
  const cancel = () => {
    setOperation(null)
    requestAnimationFrame(() => origin.current?.focus())
  }
  const submit = async event => {
    event.preventDefault()
    if (active || busy) return
    try {
      if (action === 'rename') {
        await api.renameMeeting(row.id,draft.trim())
        cancel()
      } else {
        await api.deleteMeeting(row.id)
        setOperation(null)
        onDeleted()
      }
    } catch (error) { api.fail(error) }
  }
  const tool = (key,icon,fn) => meetingButton(null,fn,{icon,title:t(key),'aria-label':`${t(key)} · ${title}`,className:'mn-icon-button',disabled:busy || active})
  return h('li',{className:'mn-history-row','data-current':current},
    h('div',{className:'mn-history-line'},
      h('button',{type:'button',className:'mn-select-meeting',onClick:() => onSelect(row.id),
        'aria-current':current ? 'true' : undefined,disabled:busy || view.phase !== 'idle'},
        h('span',{className:'mn-row-title'},title),
        h('small',null,[row.title && date(row.started),t(row.mode),meetingClock(row.duration)].filter(Boolean).join(' · '))),
      h('div',{className:'mn-history-tools'},
        current && h('span',{className:'mn-badge'},t('selected')),
        active && h('span',{className:'mn-badge mn-live'},t('recording')),
        tool('renameMeeting','edit',event => begin('rename',event.currentTarget)),
        tool('openFolder','folder',() => { void api.openFolder(row.id).catch(api.fail) }),
        tool('deleteMeeting','trash',event => begin('delete',event.currentTarget)))),
    action && h('form',{className:'mn-row-editor','aria-label':t(action === 'rename' ? 'renameMeeting' : 'deleteMeeting'),onSubmit:submit,
      onKeyDown:event => {if (event.key === 'Escape' && !event.nativeEvent.isComposing && !busy) {event.preventDefault(); event.stopPropagation(); cancel()}}},
      action === 'rename'
        ? h('label',{className:'mn-label'},t('meetingName'),h('input',{autoFocus:true,ref:editing,value:draft,onChange:event => setDraft(event.target.value),maxLength:120,required:true,disabled:busy}))
        : h('p',{id:confirmation},h('strong',null,title),h('span',null,t('deleteHint'))),
      h('div',{className:'mn-actions'},meetingButton(t('cancel'),cancel,{autoFocus:action === 'delete',disabled:busy}),
        h('button',{type:'submit',className:action === 'delete' ? 'mn-danger' : '',disabled:busy || active || (action === 'rename' && !draft.trim()),
          'aria-describedby':action === 'delete' ? confirmation : undefined},t(action === 'rename' ? 'save' : 'confirmDelete')))),
    row.id === view.historyBusy && h('small',{role:'status'},t('updatingHistory')))
}
function RecorderHistory({api,view,date,t,onExit}) {
  const [operation,setOperation] = React.useState(null)
  const list = React.useRef(null), heading = React.useRef(null)
  const headingId = React.useId()
  const select = async id => {
    try { await api.select(id); if (api.snapshot().meeting?.id === id) onExit() } catch (error) { api.fail(error) }
  }
  const focusAfterRemoval = index => requestAnimationFrame(() => {
    const buttons = list.current?.querySelectorAll('.mn-select-meeting')
    const target = buttons?.[Math.min(index,buttons.length-1)]
    if (target && !target.disabled) target.focus()
    else heading.current?.focus()
  })
  return h('section',{className:'mn-history-panel','aria-labelledby':headingId},
    h('h3',{id:headingId,ref:heading,tabIndex:-1},t('history')),
    view.phase !== 'idle' && h('p',{className:'mn-hint'},t('historyLocked')),
    view.history.length ? h('ul',{ref:list},...view.history.map((row,index) => h(RecorderHistoryRow,{
      key:row.id,row,api,view,date,t,operation,setOperation,onSelect:select,onDeleted:() => focusAfterRemoval(index),
    }))) : h(RecorderEmpty,{title:t(view.initialized ? 'emptyHistory' : 'loading')}))
}
function RecorderPanel({api,t,locale}) {
  const view = React.useSyncExternalStore(api.subscribe,api.snapshot)
  const [mode,setMode] = React.useState('mic'),[language,setLanguage] = React.useState('zh'),[history,setHistory] = React.useState(false)
  const historyButton = React.useRef(null)
  const meeting = view.meeting, live = view.phase !== 'idle', busy = view.summarizing || view.selecting || !!view.historyBusy
  const count = view.turns.filter(row => !row.done).length
  const formatter = React.useMemo(() => new Intl.DateTimeFormat(locale,{year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'}),[locale])
  const date = value => formatter.format(value)
  const closeHistory = () => { setHistory(false); historyButton.current?.focus() }
  const toggleHistory = () => {
    if (history) closeHistory()
    else { setHistory(true); void api.refreshHistory().catch(api.fail) }
  }
  const run = fn => () => {void fn().catch(api.fail)}
  const recordingElsewhere = !live && !!view.activeId
  const selectedRecording = !!meeting && meeting.id === view.activeId
  const showTranscript = !!(selectedRecording || meeting?.hasAudio || view.turns.length)
  const storedState = meeting?.saveState === 'recording' && !selectedRecording ? 'interrupted' : meeting?.saveState
  const stateLabel = live ? view.phase : selectedRecording ? 'recording' : meeting ? (storedState || (meeting.hasAudio ? 'saved' : 'failed')) : 'ready'
  return h('section',{className:'mn-root','aria-label':t('title')},h('style',null,meetingCss),h('div',{className:'mn-layout'},
    h('header',{className:'mn-head'},h('h2',null,h(RecorderGlyph,{size:21}),t('title')),
      h('div',{className:'mn-actions'},!history && meeting && !live && meetingButton(t('draftNotebook'),run(api.showDraft),{icon:'note',disabled:busy}),
        meetingButton(t(history ? (meeting ? 'backToMeeting' : 'backToNotebook') : 'history'),toggleHistory,{icon:history ? 'back' : 'history',ref:historyButton,'aria-expanded':history}))),
    view.problem && h('div',{className:'mn-error mn-alert',role:'alert'},view.problem),
    history ? h(RecorderHistory,{api,view,date,t,onExit:closeHistory}) : h(React.Fragment,null,
      h('section',{className:'mn-console','aria-label':t('recordControls')},
        h('div',{className:'mn-line'},h('span',{className:'mn-state','data-live':stateLabel==='recording',role:'status'},h('i',{'aria-hidden':true}),t(stateLabel)),
          h(RecorderTime,{api,phase:view.phase,duration:meeting?.duration || 0,t})),
        meeting && h('strong',{className:'mn-current-title'},recorderTitle(meeting,date,t)),
        recordingElsewhere ? h('small',null,t('recordingElsewhere')) : h('div',{className:'mn-controls'},
          !live ? h('label',{className:'mn-source'},h('span',null,t('device')),h('select',{value:mode,onChange:e=>setMode(e.target.value)},...['mic','system','both'].map(value=>h('option',{value,key:value},t(value))))) : h('small',null,t(meeting?.mode || mode),' · ',t('lang_'+(meeting?.language || language))),
          !live && h('label',{className:'mn-source'},h('span',null,t(meeting ? 'nextMeetingLanguage' : 'meetingLanguage')),h('select',{value:language,onChange:e=>setLanguage(e.target.value)},...['zh','auto'].map(value=>h('option',{value,key:value},t('lang_'+value))))),
          meetingButton(t(live ? view.phase === 'starting'?'cancel':'stop' : meeting?'start':'startFirst'),run(live?api.stop:()=>api.start(mode,language)),{className:'mn-record',icon:live?'stop':'mic',disabled:!view.initialized || view.phase==='stopping' || (!live && busy)})),
        !live && !recordingElsewhere && mode !== 'mic' && h('p',{className:'mn-hint'},t(desktopMeetingAudioAvailable() ? 'desktopHint' : 'shareHint')),
        live && h('small',null,t('keeping')),
        !live && !selectedRecording && meeting?.hasAudio && h(RecorderPlayback,{api,meeting,t,key:meeting.id})),
      showTranscript && h(RecorderModel,{api,view,t}),
      !view.initialized && h('small',{role:'status'},t('loading')),
      showTranscript && view.backgroundWorking && h('small',{role:'status'},t('backgroundTranscription')),
      h('div',{className:'mn-workspace','data-columns':1 + Number(showTranscript) + Number(!!meeting)},
        showTranscript && h(RecorderSheet,{title:t('transcript'),icon:'wave'},h('div',{className:'mn-sheet-body'},
          count > 0 && h('small',{className:'mn-queue',role:'status'},`${t(view.working?'recognizing':'pendingCount')} · ${count}`),
          h(RecorderTranscript,{key:meeting?.id,api,view,t}))),
        h(RecorderSheet,{title:t('notes'),icon:'note'},h(RecorderNotes,{key:api.notebookKey(),api,view,t})),
        meeting && h(RecorderSheet,{title:t('summary'),icon:'summary'},h('div',{className:'mn-sheet-body'},h(RecorderMinutes,{api,view,t})))),
      h('footer',null, showTranscript && ['ready','standby'].includes(view.status?.phase) && h('span',null,t('engineReady')),h('small',null,t('localSave'))))))
}
function meetingPlugin() {
  const id = 'dsh-meeting-recorder', ns = 'localMeetingRecorder'
  return {inject:['slots','locale','sidebarRightTabs','connection'], apply(ctx) {
    ctx.effect(() => ctx.locale.register(ns,meetingCopy),'meeting recorder copy')
    const t = ctx.locale.bind(ns), runtime = meetingRuntime(ctx,t)
    ctx.effect(() => () => runtime.dispose(),'meeting capture lifetime')
    ctx.effect(() => ctx.sidebarRightTabs.register({id,kind:'local-meeting-recorder',title:()=>t('title'),guide:[{id:'record',order:25,title:()=>t('title'),description:()=>t('guide'),icon:RecorderGlyph}]}),'meeting recorder guide')
    ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab',() => ctx.slots.register({name:'sidebar.right.pane.tab',key:id,locale:ns}, props => h(RecorderPanel,{key:props.sessionId,api:runtime.session(props.sessionId),t:props.t || t,locale:ctx.locale.getLocale().active}))), 'meeting recorder tab body')
  }}
}
