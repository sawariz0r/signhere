import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Editor } from '@tiptap/react';
import { Check, CloudAlert, LoaderCircle, Monitor, PanelLeft, Plus, Redo2, Send, Settings2, Smartphone, Undo2, X } from 'lucide-react';
import { EditorContext, useEditorApi, type EditorApi } from './context';
import { BlockFrame, BlockView } from './blocks';
import { BLOCK_ICONS, BlockPalette, DesignPanel, DRAG_TYPE, FieldsPanel, HeaderSettings, SettingsPanel } from './sidebar';
import { SendDrawer, type SendRequest } from './send';
import { BLOCK_LABELS, createBlock, createDraft, loadDraft, saveDraft, SINGLE_BLOCKS, TEMPLATES, templateBlocks, validate, type Block, type BlockType, type Draft, type HeaderBlock } from './model';
import type { User } from '../types';
import './editor.css';

const MOVE_TYPE = 'application/x-signhere-move';
const HISTORY_LIMIT = 100;
type Tab = 'blocks' | 'design' | 'fields' | 'settings';

function insertIndex(blocks: Block[], type: BlockType, after: string | null) {
  if (type === 'signature') return blocks.length;
  const selected = after ? blocks.findIndex(block => block.id === after) : -1;
  const tail = blocks.findIndex(block => block.type === 'signature' || (type !== 'terms' && block.type === 'terms'));
  if (selected >= 0 && (tail < 0 || selected < tail)) return selected + 1;
  return tail < 0 ? blocks.length : tail;
}

function InsertPoint({ index }: { index: number }) {
  const { draft, addBlock } = useEditorApi();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  const types = (Object.keys(BLOCK_LABELS) as BlockType[]).filter(type => !(SINGLE_BLOCKS.has(type) && draft.blocks.some(block => block.type === type)));
  return <div ref={ref} className={`ed-insert${open ? ' open' : ''}`}>
    <button type="button" className="ed-insert-button" aria-label="Infoga block här" aria-expanded={open} onClick={() => setOpen(value => !value)}><Plus size={14} /></button>
    {open && <div className="ed-popover ed-insert-menu" role="menu">{types.map(type => { const Icon = BLOCK_ICONS[type]; return <button key={type} type="button" role="menuitem" onClick={() => { addBlock(type, index); setOpen(false); }}><Icon size={15} />{BLOCK_LABELS[type]}</button>; })}</div>}
  </div>;
}

export function DocumentEditor({ draftId, user, onClose, onSend }: { draftId: string; user: User; onClose: () => void; onSend?: (request: SendRequest) => Promise<void> }) {
  const [draft, setDraft] = useState<Draft>(() => loadDraft(draftId) ?? createDraft(draftId, user));
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [settingsId, setSettingsId] = useState<string | null>(null);
  const [preview, setPreview] = useState(false);
  const [device, setDevice] = useState<'desktop' | 'mobile'>('desktop');
  const [sidebar, setSidebar] = useState(() => window.innerWidth > 900);
  const [tab, setTab] = useState<Tab>('blocks');
  const [sending, setSending] = useState(false);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const past = useRef<Draft[]>([]);
  const future = useRef<Draft[]>([]);
  const lastSnapshot = useRef(0);
  const firstRender = useRef(true);
  const scrollTo = useRef<string | null>(null);
  const activeEditor = useRef<Editor | null>(null);
  const canvas = useRef<HTMLDivElement>(null);
  const [, forceHistory] = useState(0);
  const latest = useRef(draft);
  latest.current = draft;

  const update = useCallback((change: (draft: Draft) => Draft, options: { structural?: boolean } = {}) => {
    setDraft(current => {
      const next = change(current);
      if (next === current) return current;
      const now = Date.now();
      if (options.structural || now - lastSnapshot.current > 700) {
        past.current = [...past.current.slice(-HISTORY_LIMIT + 1), current];
        future.current = [];
        forceHistory(value => value + 1);
      }
      lastSnapshot.current = options.structural ? 0 : now;
      return next;
    });
  }, []);
  const travel = useCallback((direction: 'undo' | 'redo') => {
    const from = direction === 'undo' ? past : future;
    const to = direction === 'undo' ? future : past;
    const target = from.current[from.current.length - 1];
    if (!target) return;
    from.current = from.current.slice(0, -1);
    to.current = [...to.current, latest.current];
    setDraft(target);
    lastSnapshot.current = 0;
    setRevision(value => value + 1);
    forceHistory(value => value + 1);
  }, []);

  const addBlock = useCallback((type: BlockType, index?: number) => {
    const block = createBlock(type);
    update(current => {
      if (SINGLE_BLOCKS.has(type) && current.blocks.some(item => item.type === type)) return current;
      const blocks = [...current.blocks];
      blocks.splice(index ?? insertIndex(blocks, type, selectedId), 0, block);
      return { ...current, blocks };
    }, { structural: true });
    setSelectedId(block.id);
    scrollTo.current = block.id;
  }, [selectedId, update]);

  const api = useMemo<EditorApi>(() => ({
    draft, preview, selectedId, select: setSelectedId, update, addBlock, activeEditor,
    updateBlock: (id, patch) => update(current => ({ ...current, blocks: current.blocks.map(block => block.id === id ? { ...block, ...patch } as Block : block) })),
    setField: (key, value) => update(current => ({ ...current, fields: { ...current.fields, [key]: value } })),
    openSettings: id => { setSettingsId(id); setSelectedId(id); },
  }), [draft, preview, selectedId, update, addBlock]);

  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    setSaveState('saving');
    const timer = window.setTimeout(() => {
      try { saveDraft({ ...draft, updatedAt: new Date().toISOString() }); setSaveState('saved'); } catch { setSaveState('error'); }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [draft]);

  useEffect(() => {
    const id = scrollTo.current;
    if (!id) return;
    scrollTo.current = null;
    requestAnimationFrame(() => canvas.current?.querySelector(`[data-block-id="${id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  }, [draft.blocks]);

  useEffect(() => { document.title = `${draft.title || 'Namnlöst dokument'} · Redigera · signhere`; }, [draft.title]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 's') { event.preventDefault(); try { saveDraft({ ...draft, updatedAt: new Date().toISOString() }); setSaveState('saved'); } catch { setSaveState('error'); } return; }
      if (mod && !typing && event.key.toLowerCase() === 'z') { event.preventDefault(); travel(event.shiftKey ? 'redo' : 'undo'); return; }
      if (mod && !typing && event.key.toLowerCase() === 'y') { event.preventDefault(); travel('redo'); return; }
      if (event.key === 'Escape' && !typing) { if (sending) setSending(false); else if (settingsId) setSettingsId(null); else setSelectedId(null); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [draft, travel, sending, settingsId]);

  const dropAt = (event: React.DragEvent) => {
    const items = [...(canvas.current?.querySelectorAll<HTMLElement>('.ed-page > .ed-flow > .ed-block') ?? [])];
    const index = items.findIndex(item => { const rect = item.getBoundingClientRect(); return event.clientY < rect.top + rect.height / 2; });
    return index < 0 ? items.length : index;
  };
  const accepts = (event: React.DragEvent) => event.dataTransfer.types.includes(DRAG_TYPE) || event.dataTransfer.types.includes(MOVE_TYPE);
  const onDrop = (event: React.DragEvent) => {
    if (!accepts(event)) return;
    event.preventDefault();
    const index = dropAt(event);
    setDropIndex(null);
    const type = event.dataTransfer.getData(DRAG_TYPE) as BlockType;
    const moving = event.dataTransfer.getData(MOVE_TYPE);
    if (type) addBlock(type, index);
    else if (moving) update(current => {
      const from = current.blocks.findIndex(block => block.id === moving);
      if (from < 0) return current;
      const blocks = [...current.blocks];
      const [item] = blocks.splice(from, 1);
      blocks.splice(from < index ? index - 1 : index, 0, item);
      return blocks.every((block, i) => block === current.blocks[i]) ? current : { ...current, blocks };
    }, { structural: true });
  };

  const issues = validate(draft);
  const errors = issues.filter(issue => issue.level === 'error').length;
  const settingsBlock = draft.blocks.find(block => block.id === settingsId && block.type === 'header') as HeaderBlock | undefined;
  const pageStyle = { '--doc-accent': draft.theme.accent, '--doc-page': draft.theme.pageColor, '--doc-font': `var(--ed-font-${draft.theme.font})`, '--doc-scale': draft.theme.scale === 'compact' ? 0.9 : draft.theme.scale === 'large' ? 1.1 : 1 } as CSSProperties;

  return <EditorContext.Provider value={api}><div className={`ed${preview ? ' is-preview' : ''}${sidebar && !preview ? ' has-sidebar' : ''}`}>
    <header className="ed-topbar">
      <div className="ed-topbar-side">
        <button type="button" className="ed-icon-ghost" aria-label="Stäng editorn" title="Stäng" onClick={onClose}><X size={18} /></button>
        {!preview && <button type="button" className={`ed-icon-ghost${sidebar ? ' active' : ''}`} aria-label="Visa eller dölj sidopanel" aria-pressed={sidebar} title="Sidopanel" onClick={() => setSidebar(value => !value)}><PanelLeft size={18} /></button>}
        <input className="ed-title-input" aria-label="Dokumentnamn" value={draft.title} placeholder="Namnlöst dokument" onChange={event => update(current => ({ ...current, title: event.target.value }))} />
      </div>
      <div className="ed-mode-switch" role="tablist" aria-label="Läge">
        <button type="button" role="tab" aria-selected={!preview} className={!preview ? 'active' : ''} onClick={() => setPreview(false)}>Redigera</button>
        <button type="button" role="tab" aria-selected={preview} className={preview ? 'active' : ''} onClick={() => { setPreview(true); setSelectedId(null); setSettingsId(null); }}>Förhandsgranska</button>
      </div>
      <div className="ed-topbar-side end">
        {preview ? <div className="ed-segment icons" aria-label="Enhet">{([['desktop', Monitor, 'Dator'], ['mobile', Smartphone, 'Mobil']] as const).map(([key, Icon, label]) => <button key={key} type="button" aria-label={label} title={label} aria-pressed={device === key} className={device === key ? 'active' : ''} onClick={() => setDevice(key)}><Icon size={15} /></button>)}</div>
          : <><button type="button" className="ed-icon-ghost" aria-label="Ångra" title="Ångra (Ctrl+Z)" disabled={!past.current.length} onClick={() => travel('undo')}><Undo2 size={17} /></button><button type="button" className="ed-icon-ghost" aria-label="Gör om" title="Gör om (Ctrl+Shift+Z)" disabled={!future.current.length} onClick={() => travel('redo')}><Redo2 size={17} /></button></>}
        <span className={`ed-save ${saveState}`} role="status">{saveState === 'saving' ? <><LoaderCircle size={14} className="spin" />Sparar</> : saveState === 'error' ? <><CloudAlert size={14} />Kunde inte spara</> : <><Check size={14} />Sparat</>}</span>
        <button type="button" className="button small ed-review" onClick={() => setSending(true)}><Send size={14} />Granska & skicka{errors > 0 && <span className="ed-badge" aria-label={`${errors} saker att åtgärda`}>{errors}</span>}</button>
      </div>
    </header>

    {!preview && sidebar && <aside className="ed-sidebar" aria-label="Verktyg">
      <div className="ed-tabs" role="tablist">{([['blocks', 'Block'], ['design', 'Design'], ['fields', 'Fält']] as const).map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>{label}</button>)}
        <button type="button" role="tab" aria-selected={tab === 'settings'} aria-label="Inställningar" title="Inställningar" className={`ed-tab-icon${tab === 'settings' ? ' active' : ''}`} onClick={() => setTab('settings')}><Settings2 size={16} /></button></div>
      <div className="ed-sidebar-scroll">
        {tab === 'blocks' && <><p className="ed-panel-hint pad">Klicka för att lägga till, eller dra in blocket där du vill ha det.</p><BlockPalette onPick={() => { if (window.innerWidth <= 900) setSidebar(false); }} /></>}
        {tab === 'design' && <DesignPanel />}
        {tab === 'fields' && <FieldsPanel />}
        {tab === 'settings' && <SettingsPanel />}
      </div>
    </aside>}

    <main ref={canvas} className="ed-canvas" onMouseDown={event => { if (event.target === event.currentTarget) setSelectedId(null); }}
      onDragOver={event => { if (!accepts(event)) return; event.preventDefault(); event.dataTransfer.dropEffect = event.dataTransfer.types.includes(MOVE_TYPE) ? 'move' : 'copy'; setDropIndex(dropAt(event)); }}
      onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropIndex(null); }} onDrop={onDrop}>
      <div className={`ed-page${device === 'mobile' && preview ? ' mobile' : ''}${!draft.blocks.length ? ' empty' : ''}`} style={pageStyle}>
        {!draft.blocks.length ? <div className={`ed-empty${dropIndex !== null ? ' dragging' : ''}`}>
          <div className="ed-empty-art" aria-hidden="true"><span><i /><b /></span><span className="cursor" /></div>
          <h2>Börja bygga ditt dokument</h2>
          <p>Dra ett block från menyn till vänster, eller utgå från en mall.</p>
          <div className="ed-templates">{TEMPLATES.filter(template => template.key !== 'blank').map(template => <button key={template.key} type="button" onClick={() => update(current => ({ ...current, title: current.title === 'Namnlöst dokument' ? template.label : current.title, blocks: templateBlocks(template.key) }), { structural: true })}><strong>{template.label}</strong><span>{template.description}</span></button>)}</div>
        </div> : <div className="ed-flow" key={revision}>
          {draft.blocks.map((block, index) => <FragmentBlock key={block.id} block={block} index={index} count={draft.blocks.length} dropIndex={dropIndex} preview={preview} />)}
          {dropIndex === draft.blocks.length && <div className="ed-drop-line" />}
        </div>}
      </div>
      {!preview && draft.blocks.length > 0 && <button type="button" className="ed-add-end" onClick={() => { setSidebar(true); setTab('blocks'); }}><Plus size={15} />Lägg till block</button>}
    </main>

    {settingsBlock && !preview && <HeaderSettings block={settingsBlock} onClose={() => setSettingsId(null)} />}
    {sending && <SendDrawer user={user} onClose={() => setSending(false)} onSend={onSend} onFix={fix => { if (fix === 'add-signature') addBlock('signature'); setSending(false); }} />}
  </div></EditorContext.Provider>;
}

function FragmentBlock({ block, index, count, dropIndex, preview }: { block: Block; index: number; count: number; dropIndex: number | null; preview: boolean }) {
  return <>
    {dropIndex === index && <div className="ed-drop-line" />}
    {!preview && index > 0 && <InsertPoint index={index} />}
    <BlockFrame block={block} index={index} count={count} onDragStart={event => {
      event.dataTransfer.setData(MOVE_TYPE, block.id);
      event.dataTransfer.effectAllowed = 'move';
      const element = (event.currentTarget as HTMLElement).closest('.ed-block');
      if (element) event.dataTransfer.setDragImage(element, 24, 24);
    }}><BlockView block={block} /></BlockFrame>
  </>;
}

