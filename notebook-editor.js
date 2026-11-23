function RecorderMarkdownEditor({ value = '', onChange, disabled = false, t, format, getTimestamp, placeholder }) {
  const kit = notebookKit, { schema, documentSource, plainDocument } = notebookModel
  const mount = React.useRef(null), current = React.useRef(null)
  const keyboardTool = React.useRef(false)
  const props = React.useRef(null)
  props.current = { onChange, disabled, label: t('notes'), placeholder: placeholder ?? t('notePlaceholder') }
  const [tools, setTools] = React.useState({ bold: false, color: '', heading: false, list: '' })
  const colors = [['editorRed', '#d14c46'], ['editorAmber', '#a46b08'], ['editorGreen', '#23825d'], ['editorBlue', '#347ac8'], ['editorPurple', '#9359bd']]
  const CLIPBOARD = 'application/x-dsh-meeting-notes+json'

  function syncDOMSelection(view) {
    if (!view || view.composing) return
    // Chromium batches selectionchange. A quick shortcut or toolbar action can arrive first.
    const native = view.dom.ownerDocument.getSelection()
    if (!native?.rangeCount || !view.dom.contains(native.anchorNode) || !view.dom.contains(native.focusNode)) return
    const anchor = view.posAtDOM(native.anchorNode, native.anchorOffset), head = view.posAtDOM(native.focusNode, native.focusOffset)
    const { state } = view
    if ((anchor === state.selection.anchor && head === state.selection.head) ||
        !state.doc.resolve(anchor).parent.inlineContent || !state.doc.resolve(head).parent.inlineContent) return
    view.dispatch(state.tr.setSelection(kit.Selection.fromJSON(state.doc, { type: 'text', anchor, head })))
  }
  function markCoverage(state, type) {
    let found = false, full = true
    state.doc.nodesBetween(state.selection.from, state.selection.to, node => {
      if (!node.isText) return
      found = true
      if (!type.isInSet(node.marks)) full = false
    })
    return found ? full ? 'all' : 'some' : false
  }
  // Word keeps the other character styles when a mark is applied to a mixed
  // selection: Bold makes every selected run bold instead of stripping it.
  function applyBold(state, dispatch) {
    const type = schema.marks.strong, { empty, from, to, ranges } = state.selection
    if (empty) return kit.toggleMark(type)(state, dispatch)
    if (markCoverage(state, type) === 'all') {
      dispatch(state.tr.removeMark(from, to, type))
      return true
    }
    let tr = state.tr
    for (const range of ranges) tr = tr.addMark(range.$from.pos, range.$to.pos, type.create())
    dispatch(tr)
    return true
  }
  function listAt($pos) {
    for (let depth = $pos.depth; depth > 0; depth--) {
      const node = $pos.node(depth)
      if (node.type === schema.nodes.bullet_list) return 'bullet'
      if (node.type === schema.nodes.ordered_list) return 'ordered'
    }
    // A whole-list selection can start and end between the list and its siblings.
    for (const node of [$pos.nodeAfter, $pos.nodeBefore]) {
      if (node?.type === schema.nodes.bullet_list) return 'bullet'
      if (node?.type === schema.nodes.ordered_list) return 'ordered'
    }
    return ''
  }
  function syncTools(state) {
    const { $from, $to, from, to, empty } = state.selection
    const marks = state.storedMarks || $from.marks()
    const bold = empty ? !!schema.marks.strong.isInSet(marks) : markCoverage(state, schema.marks.strong)
    const startList = listAt($from), endList = listAt($to)
    const list = startList === endList ? startList : 'mixed'
    let color = schema.marks.color.isInSet(marks)?.attrs.value || ''
    if (!empty) {
      const selected = new Set()
      state.doc.nodesBetween(from, to, node => {
        if (node.isText) selected.add(schema.marks.color.isInSet(node.marks)?.attrs.value || '')
      })
      color = selected.size > 1 ? 'mixed' : selected.values().next().value || ''
    }
    const next = { bold, list, heading: $from.parent.type === schema.nodes.heading, color }
    setTools(prev => prev.bold === bold && prev.list === list && prev.heading === next.heading && prev.color === color ? prev : next)
  }
  function publish(model, text) {
    const changed = model.plain || text !== model.raw
    model.plain = false
    model.raw = text
    if (changed) props.current.onChange(text)
  }
  function replaceDocument(model, text, plain) {
    model.source = documentSource(text, plain)
    model.view.updateState(kit.EditorState.create({ doc: model.source.doc, plugins: model.plugins }))
    syncTools(model.view.state)
  }
  function writeClipboard(editor, event, cut) {
    // Chromium can deliver copy before ProseMirror observes selectionchange.
    syncDOMSelection(editor)
    const { state } = editor
    if (state.selection.empty) return false
    const slice = state.selection.content(), clipboard = event.clipboardData
    if (!clipboard) return false
    clipboard.setData('text/plain', slice.content.textBetween(0, slice.content.size, '\n'))
    try { clipboard.setData(CLIPBOARD, JSON.stringify(slice.toJSON())) } catch { /* Optional private flavor. */ }
    try {
      // Styled HTML is written for other applications; this editor never parses incoming HTML.
      const native = editor.dom.ownerDocument.getSelection()
      if (native?.rangeCount && editor.dom.contains(native.anchorNode) && editor.dom.contains(native.focusNode)) {
        const container = editor.dom.ownerDocument.createElement('div')
        container.appendChild(native.getRangeAt(0).cloneContents())
        clipboard.setData('text/html', container.innerHTML)
      }
    } catch { /* The plain and private flavors still carry the text. */ }
    event.preventDefault()
    if (cut) editor.dispatch(editor.state.tr.deleteSelection().scrollIntoView())
    return true
  }
  React.useLayoutEffect(() => {
    const plain = format === 'plain'
    const source = documentSource(value, plain)
    const plugins = [kit.history(), kit.keymap({
      'Mod-b': applyBold, 'Mod-z': kit.undo, 'Mod-Shift-z': kit.redo, 'Mod-y': kit.redo,
      Enter: kit.splitListItem(schema.nodes.list_item),
      'Shift-Enter': (state, dispatch) => {
        if (!state.selection.$from.parent.type.allowsMarkType(schema.marks.strong)) return false
        dispatch(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView())
        return true
      },
    }), kit.keymap(kit.baseKeymap)]
    const model = { raw: value, plain, source, plugins, visualCurrent: true, view: null }
    const view = new kit.EditorView(mount.current, {
      state: kit.EditorState.create({ doc: source.doc, plugins }),
      editable: () => !props.current.disabled,
      attributes: state => ({ role: 'textbox', 'aria-label': props.current.label, 'aria-multiline': 'true',
        'aria-readonly': String(props.current.disabled), 'aria-placeholder': props.current.placeholder,
        'data-placeholder': state.doc.childCount === 1 && state.doc.firstChild.type === schema.nodes.paragraph && !state.doc.firstChild.content.size ? props.current.placeholder : '',
        class: 'mn-md-content', spellcheck: 'true' }),
      handleKeyDown(editor, event) {
        if (!event.isComposing && (event.ctrlKey || event.metaKey)) syncDOMSelection(editor)
        return false
      },
      // Word applies the first selected character's style to replacement text.
      handleTextInput(editor, from, to, text) {
        if (editor.composing || from === to || props.current.disabled) return false
        const $from = editor.state.doc.resolve(from), node = $from.nodeAfter
        if (!$from.parent.inlineContent || !node?.isText) return false
        editor.dispatch(editor.state.tr.insertText(text, from, to, node.marks).scrollIntoView())
        return true
      },
      handleDOMEvents: {
        copy: (editor, event) => writeClipboard(editor, event, false),
        cut: (editor, event) => writeClipboard(editor, event, true),
        paste(editor, event) {
          event.preventDefault()
          const clipboard = event.clipboardData
          if (!clipboard || props.current.disabled) return true
          // A slice copied here keeps bold and color. Foreign HTML is never parsed.
          const encoded = clipboard.getData(CLIPBOARD)
          if (encoded) {
            try {
              const slice = kit.Slice.fromJSON(schema, JSON.parse(encoded))
              editor.dispatch(kit.closeHistory(editor.state.tr.replaceSelection(slice).scrollIntoView()))
              return true
            } catch { /* Fall back to the plain flavor. */ }
          }
          const text = clipboard.getData('text/plain')
          if (!text) return true
          const { state } = editor
          const tr = !/[\r\n]/.test(text) || state.selection.$from.parent.type.spec.code
            ? state.tr.insertText(text.replace(/\r\n?/g, '\n'))
            : state.tr.replaceSelection(kit.Slice.maxOpen(plainDocument(text).content))
          editor.dispatch(kit.closeHistory(tr).scrollIntoView())
          return true
        },
        drop(_editor, event) { event.preventDefault(); return true },
      },
      transformPastedHTML: () => '',
      dispatchTransaction(tr) {
        const state = this.state.apply(tr)
        this.updateState(state)
        syncTools(state)
        if (tr.docChanged) publish(model, model.source.serialize(state.doc))
      },
    })
    model.view = view
    current.current = model
    syncTools(view.state)
    return () => { view.destroy(); current.current = null }
  }, [])

  React.useLayoutEffect(() => {
    const model = current.current, plain = format === 'plain'
    if (model.raw === value && model.plain === plain) return
    // An optimistic parent may echo our first Markdown change before persisting its format tag.
    if (model.raw === value && !model.plain && plain) return
    model.raw = value
    model.plain = plain
    replaceDocument(model, value, plain)
  }, [value, format])
  React.useLayoutEffect(() => { current.current.view.setProps({}) }, [disabled, props.current.label, props.current.placeholder])

  function run(command) {
    const view = current.current.view
    if (disabled || view.composing) return
    syncDOMSelection(view)
    command(view.state, tr => view.dispatch(kit.closeHistory(tr).scrollIntoView()), view)
    if (!keyboardTool.current) view.focus()
  }
  function changeColor(color) {
    run((state, dispatch) => {
      const type = schema.marks.color, { empty, from, to } = state.selection
      let tr = state.tr
      if (empty) tr = color ? tr.addStoredMark(type.create({ value: color })) : tr.removeStoredMark(type)
      else tr = color ? tr.addMark(from, to, type.create({ value: color })) : tr.removeMark(from, to, type)
      dispatch(tr)
    })
  }
  function selectedBlocks(state, from, to) {
    const blocks = []
    state.doc.forEach((node, offset) => {
      if (offset + node.nodeSize > from && offset < to) blocks.push({ node, start: offset, end: offset + node.nodeSize })
    })
    return blocks
  }
  function rebuildSelectionAsList(state, blocks, type, attrs) {
    const items = []
    for (const { node } of blocks) {
      if (node.type === schema.nodes.bullet_list || node.type === schema.nodes.ordered_list) {
        node.forEach(item => items.push(item.type === schema.nodes.list_item ? item : schema.nodes.list_item.create(null, item)))
      } else {
        items.push(schema.nodes.list_item.create(null, node))
      }
    }
    if (!items.length) return null
    return state.tr.replaceWith(blocks[0].start, blocks.at(-1).end, type.create(attrs, items))
  }
  function unwrapBlocks(state, blocks) {
    const tr = state.tr
    for (const { node, start } of [...blocks].reverse()) {
      if (node.type !== schema.nodes.bullet_list && node.type !== schema.nodes.ordered_list) continue
      const content = []
      node.forEach(item => {
        if (item.type === schema.nodes.list_item) item.forEach(child => content.push(child))
        else content.push(item)
      })
      if (!content.length) content.push(schema.nodes.paragraph.create())
      tr.replaceWith(start, start + node.nodeSize, content)
    }
    return tr
  }
  // Bullets and numbers apply to every selected block. A second click removes
  // the list only when the whole selection already has that list type.
  function toggleList(name) {
    const view = current.current.view
    if (disabled || view.composing) return
    syncDOMSelection(view)
    const { state } = view, { empty, from, to } = state.selection
    const bullet = schema.nodes.bullet_list, ordered = schema.nodes.ordered_list
    const type = name === 'ordered' ? ordered : bullet
    const attrs = name === 'ordered' ? { order: 1, tight: true } : { tight: true }
    if (empty) {
      let currentList = null, listPos = -1
      const $from = state.selection.$from
      for (let depth = $from.depth; depth > 0; depth--) {
        const node = $from.node(depth)
        if (node.type === bullet || node.type === ordered) { currentList = node.type; listPos = $from.before(depth); break }
      }
      if (!currentList) kit.wrapInList(type, attrs)(state, tr => view.dispatch(kit.closeHistory(tr).scrollIntoView()))
      else if (currentList === type) kit.liftListItem(schema.nodes.list_item)(state, tr => view.dispatch(kit.closeHistory(tr).scrollIntoView()))
      else view.dispatch(kit.closeHistory(state.tr.setNodeMarkup(listPos, type, attrs).scrollIntoView()))
    } else {
      const blocks = selectedBlocks(state, from, to)
      const lists = blocks.filter(block => block.node.type === bullet || block.node.type === ordered)
      if (blocks.length && blocks.every(block => block.node.type === type)) {
        const coversAll = blocks.every(block => from <= block.start && to >= block.end)
        const lifted = !coversAll && kit.liftListItem(schema.nodes.list_item)(state, tr => view.dispatch(kit.closeHistory(tr).scrollIntoView()))
        if (!lifted) {
          const tr = unwrapBlocks(state, blocks)
          if (tr.docChanged) view.dispatch(kit.closeHistory(tr.scrollIntoView()))
        }
      } else if (lists.length) {
        const tr = rebuildSelectionAsList(state, blocks, type, attrs)
        if (tr) view.dispatch(kit.closeHistory(tr.scrollIntoView()))
      } else {
        kit.wrapInList(type, attrs)(state, tr => view.dispatch(kit.closeHistory(tr.scrollIntoView())))
      }
    }
    if (!keyboardTool.current) view.focus()
  }
  function stamp() {
    const tag = getTimestamp?.()
    if (disabled || !tag) return
    run((state, dispatch) => dispatch(state.tr.insertText(tag)))
  }
  function button(label, content, action, active, className) {
    return h('button', { type: 'button', title: label, 'aria-label': label, disabled,
      className, 'aria-pressed': active, onMouseDown: event => event.preventDefault(), onClick: action }, content)
  }
  const colorKnown = !tools.color || colors.some(([, hex]) => hex === tools.color)
  return h('div', { className: 'mn-md-editor' },
    h('div', { className: 'mn-md-tools', role: 'group', 'aria-label': t('editorTools'),
      onPointerDownCapture: () => { keyboardTool.current = false; syncDOMSelection(current.current.view) },
      onKeyDownCapture: () => { keyboardTool.current = true } },
      button(t('editorBold'), h('b', { 'aria-hidden': true }, 'B'), () => run(applyBold), tools.bold === 'all' ? 'true' : tools.bold === 'some' ? 'mixed' : 'false'),
      h('label', { className: 'mn-md-color', title: tools.color === 'mixed' ? `${t('editorColor')} · ${t('editorMixedColors')}` : t('editorColor'), 'data-mixed': tools.color === 'mixed' ? 'true' : 'false' },
        h('span', { 'aria-hidden': true, style: { borderColor: tools.color && tools.color !== 'mixed' ? tools.color : undefined } }, 'A'),
        h('select', { 'aria-label': t('editorColor'), value: tools.color, disabled, onChange: event => changeColor(event.target.value) },
          h('option', { value: '' }, t('editorDefaultColor')),
          ...colors.map(([label, hex]) => h('option', { key: hex, value: hex }, t(label))),
          !colorKnown && h('option', { value: tools.color, disabled: tools.color === 'mixed' }, tools.color === 'mixed' ? t('editorMixedColors') : tools.color))),
      button(t('editorHeading'), 'H', () => run(kit.setBlockType(tools.heading ? schema.nodes.paragraph : schema.nodes.heading, tools.heading ? null : { level: 2 })), tools.heading),
      h('span', { className: 'mn-md-list-group' },
        button(t('editorBulletList'), h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round', 'aria-hidden': true },
          h('path', { d: 'M2.5 3.5h.01M2.5 8h.01M2.5 12.5h.01M6 3.5h7.5M6 8h7.5M6 12.5h7.5' })),
          () => toggleList('bullet'), tools.list === 'bullet' ? 'true' : tools.list === 'mixed' ? 'mixed' : 'false'),
        button(t('editorOrderedList'), h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true },
          h('path', { d: 'M2 3.2h1v2.1M2 5.3h2M2 8.4h1.5a.55.55 0 0 1 0 1.1H2M2 9.5h2M6 3.5h7.5M6 8h7.5M6 12.5h7.5' })),
          () => toggleList('ordered'), tools.list === 'ordered' ? 'true' : tools.list === 'mixed' ? 'mixed' : 'false')),
      getTimestamp && button(t('insertTimestamp'), h('svg', { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', stroke: 'currentColor', strokeWidth: 1.4, 'aria-hidden': true }, h('circle', { cx: 8, cy: 8, r: 6 }), h('path', { d: 'M8 4v4l2.5 1.5' })), stamp)),
    h('div', { className: 'mn-md-visual', ref: mount }))
}
