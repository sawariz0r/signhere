import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Editor } from '@tiptap/react';
import { ArrowRight, Check, X } from 'lucide-react';
import '@fontsource-variable/source-serif-4';
import { EditorContext, useEditorApi, type EditorApi } from './context';
import { BlockFrame, BlockView, SignatureSection, UnitList } from './blocks';
import { SidePanel } from './sidebar';
import {
  BLOCK_LABELS, createBlock, createDraft, duplicateBlock, FONTS, loadDraft, saveDraft, SIGNATURE_ID, SINGLE_BLOCKS, TEMPLATES, templateBlocks, TRAY_ORDER, validate,
  type Block, type BlockType, type Draft, type Issue, type TemplateKey,
} from './model';
import type { User } from '../types';
import './editor.css';

const HISTORY_LIMIT = 100;
type Toast = { message: string; restore?: { block: Block; index: number } };

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const scrollToElement = (selector: string, offset: number) => requestAnimationFrame(() => {
  const element = document.querySelector(selector);
  if (element) window.scrollTo({ top: Math.max(0, element.getBoundingClientRect().top + window.scrollY - offset), behavior: reducedMotion() ? 'auto' : 'smooth' });
});

function Tray({ label, index, onClose }: { label: string; index: number; onClose?: () => void }) {
  const { draft, addBlock } = useEditorApi();
  const present = new Set(draft.blocks.map(block => block.type));
  return <div className={`ed-tray${onClose ? '' : ' end'}`} role="group" aria-label={label}>
    <span>{label}</span>
    {TRAY_ORDER.filter(type => !(SINGLE_BLOCKS.has(type) && present.has(type))).map(type => <button key={type} type="button" onClick={() => addBlock(type, index)}>{BLOCK_LABELS[type]}</button>)}
    {onClose && <button type="button" className="ed-tray-close" aria-label="Stäng" title="Stäng" onClick={onClose}><X size={16} /></button>}
  </div>;
}

/**
 * The draft is rendered to a PDF and handed to `onUse`, which continues in the upload flow.
 * With `attachment`, the draft becomes a bilaga signed by parties chosen in the next step.
 */
export function DocumentEditor({ draftId, user, onClose, onUse, attachment = false }: { draftId: string; user: User; onClose: () => void; onUse: (file: File, draft: Draft) => void; attachment?: boolean }) {
  const [draft, setDraft] = useState<Draft>(() => loadDraft(draftId) ?? createDraft(draftId, user));
  const [revision, setRevision] = useState(0);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [insertAt, setInsertAt] = useState<number | 'end' | null>(null);
  const [preview, setPreview] = useState(false);
  const [fresh, setFresh] = useState<string | null>(null);
  const [paperWidth, setPaperWidth] = useState(800);
  const [toast, setToast] = useState<Toast | null>(null);
  const [flash, setFlash] = useState(false);
  const [saveState, setSaveState] = useState<'saved' | 'saving' | 'error'>('saved');
  const [rendering, setRendering] = useState(false);
  const [renderError, setRenderError] = useState('');
  const past = useRef<Draft[]>([]);
  const future = useRef<Draft[]>([]);
  const lastSnapshot = useRef(0);
  const firstRender = useRef(true);
  const activeEditor = useRef<Editor | null>(null);
  const paper = useRef<HTMLElement>(null);
  const flip = useRef<Map<string, number> | null>(null);
  const timers = useRef<Record<string, number>>({});
  const latest = useRef(draft);
  latest.current = draft;

  const later = useCallback((name: string, ms: number, run: () => void) => { window.clearTimeout(timers.current[name]); timers.current[name] = window.setTimeout(run, ms); }, []);
  useEffect(() => () => Object.values(timers.current).forEach(window.clearTimeout), []);

  const update = useCallback((change: (draft: Draft) => Draft, options: { structural?: boolean } = {}) => {
    setDraft(current => {
      const next = change(current);
      if (next === current) return current;
      const now = Date.now();
      if (options.structural || now - lastSnapshot.current > 700) {
        past.current = [...past.current.slice(-HISTORY_LIMIT + 1), current];
        future.current = [];
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
    setToast(null);
  }, []);

  const markFresh = useCallback((id: string) => { setFresh(id); later('fresh', 450, () => setFresh(null)); }, [later]);
  const select = useCallback((id: string | null) => { setSelectedId(id); setInsertAt(null); }, []);

  const addBlock = useCallback((type: BlockType, index: number) => {
    const block = createBlock(type);
    update(current => {
      if (SINGLE_BLOCKS.has(type) && current.blocks.some(item => item.type === type)) return current;
      const blocks = [...current.blocks];
      blocks.splice(index, 0, block.type === 'header' && current.title !== 'Namnlöst dokument' ? { ...block, title: current.title } : block);
      return { ...current, blocks };
    }, { structural: true });
    select(block.id);
    markFresh(block.id);
  }, [update, select, markFresh]);

  const captureFlip = () => {
    const tops = new Map<string, number>();
    paper.current?.querySelectorAll<HTMLElement>('[data-block]').forEach(element => tops.set(element.dataset.block!, element.getBoundingClientRect().top));
    flip.current = tops;
  };
  const moveBlock = useCallback((id: string, offset: number) => {
    captureFlip();
    update(current => {
      const from = current.blocks.findIndex(block => block.id === id), to = from + offset;
      if (from < 0 || to < 0 || to >= current.blocks.length) return current;
      const blocks = [...current.blocks];
      [blocks[from], blocks[to]] = [blocks[to], blocks[from]];
      return { ...current, blocks };
    }, { structural: true });
  }, [update]);
  const copyBlock = useCallback((id: string) => {
    const index = latest.current.blocks.findIndex(block => block.id === id);
    const source = latest.current.blocks[index];
    if (!source || SINGLE_BLOCKS.has(source.type)) return;
    const copy = duplicateBlock(source);
    update(current => { const blocks = [...current.blocks]; blocks.splice(index + 1, 0, copy); return { ...current, blocks }; }, { structural: true });
    select(copy.id);
    markFresh(copy.id);
  }, [update, select, markFresh]);
  const removeBlock = useCallback((id: string) => {
    const index = latest.current.blocks.findIndex(block => block.id === id);
    const block = latest.current.blocks[index];
    if (!block) return;
    update(current => ({ ...current, blocks: current.blocks.filter(item => item.id !== id) }), { structural: true });
    select(null);
    setToast({ message: `${BLOCK_LABELS[block.type]} togs bort`, restore: { block, index } });
    later('toast', 5000, () => setToast(null));
  }, [update, select, later]);
  const restore = () => {
    const saved = toast?.restore;
    if (!saved) return;
    update(current => {
      if (current.blocks.some(block => block.id === saved.block.id)) return current;
      const blocks = [...current.blocks];
      blocks.splice(Math.min(saved.index, blocks.length), 0, saved.block);
      return { ...current, blocks };
    }, { structural: true });
    setToast(null);
    select(saved.block.id);
    markFresh(saved.block.id);
  };

  const jump = useCallback((id: string) => { setPreview(false); select(id); scrollToElement(`[data-block="${id}"]`, 110); }, [select]);
  const focusRecipients = useCallback(() => {
    setPreview(false);
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const card = document.querySelector('[data-rec-card]');
      if (!card) return;
      const inputs = [...card.querySelectorAll<HTMLInputElement>('input:not([type=checkbox])')];
      const target = inputs.find(input => !input.value.trim()) ?? inputs[0];
      if (target) target.focus({ preventScroll: true });
      scrollToElement('[data-rec-card]', 84);
    }));
  }, []);

  const api = useMemo<EditorApi>(() => ({
    draft, user, preview, selectedId, fresh, paperWidth, select, jump, focusRecipients, update, addBlock, moveBlock, copyBlock, removeBlock, activeEditor,
    updateBlock: (id, patch) => update(current => ({ ...current, blocks: current.blocks.map(block => block.id === id ? { ...block, ...(typeof patch === 'function' ? patch(block as never) : patch) } as Block : block) })),
  }), [draft, user, preview, selectedId, fresh, paperWidth, select, jump, focusRecipients, update, addBlock, moveBlock, copyBlock, removeBlock]);

  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    setSaveState('saving');
    const timer = window.setTimeout(() => {
      try { saveDraft({ ...draft, updatedAt: new Date().toISOString() }); setSaveState('saved'); } catch { setSaveState('error'); }
    }, 500);
    return () => window.clearTimeout(timer);
  }, [draft]);

  useLayoutEffect(() => {
    const tops = flip.current;
    flip.current = null;
    if (!tops || reducedMotion()) return;
    paper.current?.querySelectorAll<HTMLElement>('[data-block]').forEach(element => {
      const before = tops.get(element.dataset.block!);
      if (before === undefined) return;
      const delta = before - element.getBoundingClientRect().top;
      if (Math.abs(delta) < 1) return;
      element.style.transition = 'none';
      element.style.transform = `translateY(${delta}px)`;
      requestAnimationFrame(() => requestAnimationFrame(() => { element.style.transition = 'transform .22s cubic-bezier(.2,.7,.2,1)'; element.style.transform = ''; }));
      window.setTimeout(() => { element.style.transition = ''; }, 320);
    });
  }, [draft.blocks]);

  useEffect(() => {
    const element = paper.current;
    if (!element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setPaperWidth(width => Math.abs(width - element.clientWidth) > 4 ? element.clientWidth : width));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => { document.title = `${draft.title || 'Namnlöst dokument'} · Redigera · signhere`; }, [draft.title]);

  // A bilaga's signers come from the main document, so recipient checks do not apply.
  const issues = validate(draft).filter(issue => !attachment || issue.target?.kind !== 'recipients' || issue.message.startsWith('Tomt fält'));
  const openSend = () => {
    if (issues.length) {
      setPreview(false); setFlash(true);
      later('flash', 1400, () => setFlash(false));
      scrollToElement('[data-status]', 84);
      return;
    }
    select(null);
    void renderPdf();
  };
  const renderPdf = async () => {
    if (rendering) return;
    setRendering(true); setRenderError('');
    try {
      const { draftPdf } = await import('./pdf-export');
      const current = latest.current;
      const blob = await draftPdf(current);
      if (blob.size > 10 * 1024 * 1024) throw new Error(`${attachment ? 'Bilagan' : 'Dokumentet'} blir större än 10 MB. Använd mindre bilder.`);
      // Leaving the editor cancels the debounced save, so keep the latest edits before handing off.
      try { saveDraft({ ...latest.current, updatedAt: new Date().toISOString() }); setSaveState('saved'); } catch { setSaveState('error'); }
      const name = (current.title.trim() || (attachment ? 'Bilaga' : 'Dokument')).replace(/[\\/\u0000-\u001f\u007f]+/g, ' ').slice(0, 150);
      onUse(new File([blob], `${name}.pdf`, { type: 'application/pdf' }), current);
    } catch (error) { setRenderError(error instanceof Error ? error.message : 'PDF-filen kunde inte skapas.'); }
    finally { setRendering(false); }
  };
  const onIssue = (issue: Issue) => {
    if (issue.target?.kind === 'recipients') focusRecipients();
    else if (issue.target?.kind === 'block') jump(issue.target.id);
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const typing = target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName);
      const mod = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (mod && key === 's') { event.preventDefault(); try { saveDraft({ ...latest.current, updatedAt: new Date().toISOString() }); setSaveState('saved'); } catch { setSaveState('error'); } return; }
      if (event.key === 'Escape') {
        if (event.defaultPrevented) return;
        if (typing) target.blur();
        select(null);
        return;
      }
      if (typing || preview) return;
      if (mod && (key === 'z' || key === 'y')) { event.preventDefault(); travel(key === 'y' || event.shiftKey ? 'redo' : 'undo'); return; }
      if (!selectedId || selectedId === SIGNATURE_ID) return;
      if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); removeBlock(selectedId); }
      else if (mod && key === 'd') { event.preventDefault(); copyBlock(selectedId); }
      else if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) { event.preventDefault(); moveBlock(selectedId, event.key === 'ArrowUp' ? -1 : 1); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [preview, selectedId, select, travel, removeBlock, copyBlock, moveBlock]);

  const applyTemplate = (key: TemplateKey) => {
    if (key === 'blank') { addBlock('text', 0); return; }
    const label = TEMPLATES.find(template => template.key === key)!.label;
    update(current => ({ ...current, title: current.title === 'Namnlöst dokument' ? label : current.title, blocks: templateBlocks(key) }), { structural: true });
  };
  const deselect = (event: React.MouseEvent) => { if (event.target === event.currentTarget) select(null); };
  const font = FONTS.find(([key]) => key === draft.theme.font)?.[2] ?? FONTS[0][2];
  const paperStyle = { fontFamily: font, '--doc-accent': draft.theme.accent } as CSSProperties;

  return <EditorContext.Provider value={api}><div className={`ed${preview ? ' is-preview' : ''}`}>
    <header className="ed-topbar">
      <div className="ed-topbar-inner">
        <button type="button" className="ed-logo" aria-label="Tillbaka till dokument" title="Tillbaka till dokument" onClick={onClose}><span><i /></span></button>
        <span className="ed-slash" aria-hidden="true">/</span>
        <input className="ed-title" aria-label="Dokumentnamn" value={draft.title} placeholder="Namnlöst dokument" onChange={event => update(current => ({ ...current, title: event.target.value }))} />
        <span className={`ed-save ${saveState}`} role="status">{saveState === 'saving' ? <><span className="ed-pulse" aria-hidden="true" />Sparar…</> : saveState === 'error' ? 'Kunde inte spara' : <><Check size={13} strokeWidth={3} aria-hidden="true" />Sparat</>}</span>
        <div className="ed-topbar-actions">
          <button type="button" className="ed-btn large" onClick={() => { setPreview(value => !value); select(null); }}>{preview ? 'Redigera' : 'Förhandsgranska'}</button>
          <button type="button" className="ed-btn primary large" disabled={rendering} onClick={openSend}>{rendering ? 'Skapar PDF…' : attachment ? 'Använd som bilaga' : 'Skicka'}{issues.length > 0 && <span className="ed-count" aria-label={`${issues.length} saker kvar`}>{issues.length}</span>}</button>
        </div>
      </div>
    </header>

    <div className="ed-main">
      <div className="ed-canvas" onMouseDown={deselect}>
        {preview && <p className="ed-preview-note"><span aria-hidden="true" />Förhandsgranskning – så här ser mottagaren dokumentet.</p>}
        <article ref={paper} className="ed-paper" style={paperStyle} onMouseDown={deselect}>
          {!draft.blocks.length ? <div className="ed-start">
            <div className="ed-mono">Börja med</div>
            <h2>Vad vill du skicka?</h2>
            <div className="ed-start-list">{TEMPLATES.map(template => <button key={template.key} type="button" onClick={() => applyTemplate(template.key)}>
              <span><strong>{template.label}</strong><span>{template.description}</span></span><ArrowRight size={18} aria-hidden="true" />
            </button>)}</div>
          </div> : <div className="ed-flow" key={revision}>
            {draft.blocks.map((block, index) => <Fragment key={block.id}>
              {!preview && index > 0 && (insertAt === index ? <Tray label="Infoga" index={index} onClose={() => setInsertAt(null)} />
                : <button type="button" className="ed-slot" aria-label="Infoga block här" title="Infoga block här" onClick={() => { setSelectedId(null); setInsertAt(index); }}><span /><i>+</i><span /></button>)}
              <BlockFrame block={block} index={index} count={draft.blocks.length}><BlockView block={block} /></BlockFrame>
            </Fragment>)}
          </div>}
          {!preview && draft.blocks.length > 0 && (insertAt === 'end' ? <Tray label="Lägg till" index={draft.blocks.length} />
            : <button type="button" className="ed-add-end" onClick={() => { setSelectedId(null); setInsertAt('end'); }}>+ Lägg till block</button>)}
          {draft.blocks.length > 0 && (attachment ? <p className="ed-attachment-note">Bilagan signeras av parterna du väljer i nästa steg. En signatursida läggs till automatiskt.</p> : <SignatureSection />)}
        </article>
      </div>
      {!preview && <SidePanel issues={issues} flash={flash} onIssue={onIssue} attachment={attachment} />}
    </div>
    <UnitList />

    {renderError && <div className="ed-toast-wrap"><div className="ed-toast" role="alert"><span>{renderError}</span><button type="button" onClick={() => setRenderError('')}>Stäng</button></div></div>}
    {toast && <div className="ed-toast-wrap"><div className="ed-toast" role="status"><span>{toast.message}</span>{toast.restore && <button type="button" onClick={restore}>Ångra</button>}</div></div>}
  </div></EditorContext.Provider>;
}
