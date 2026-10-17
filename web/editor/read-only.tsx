import { useMemo, useRef } from 'react';
import '@fontsource-variable/source-serif-4';
import { MessageSquare, Plus } from 'lucide-react';
import { EditorContext, type EditorApi } from './context';
import { BlockView } from './blocks';
import { BLOCK_LABELS, FONTS, resolveTokens, type Draft } from './model';
import type { ReviewThread } from '../document/types';

export function sectionLabel(draft: Draft, id: string | null) {
  const index = draft.blocks.findIndex(block => block.id === id), block = draft.blocks[index];
  return !id ? 'Hela dokumentet' : block ? `${index + 1}. ${'title' in block && resolveTokens(draft, block.title) || BLOCK_LABELS[block.type]}` : 'Avsnitt i tidigare version';
}
export function ReadOnlyDraft({ draft, threads, selected, onSelect, onComment }: { draft: Draft; threads: ReviewThread[]; selected: string | null; onSelect: (id: string | null) => void; onComment: (id: string) => void }) {
  const activeEditor = useRef(null);
  const api = useMemo<EditorApi>(() => ({ draft, user: { id: '', teamId: '', name: draft.fields['sender.name'] ?? '', email: draft.fields['sender.email'] ?? '', teamName: draft.fields['sender.company'] ?? '' }, preview: true, selectedId: null, fresh: null, paperWidth: 800, activeEditor, select() {}, jump() {}, focusRecipients() {}, update() {}, updateBlock() {}, addBlock() {}, moveBlock() {}, copyBlock() {}, removeBlock() {} }), [draft]);
  return <EditorContext.Provider value={api}><article className="ed-paper rd-review-paper" style={{ fontFamily: FONTS.find(([key]) => key === draft.theme.font)?.[2], '--doc-accent': draft.theme.accent } as React.CSSProperties}>
    {draft.blocks.map(block => { const comments = threads.filter(thread => thread.blockId === block.id); return <section data-review-block={block.id} className={`ed-block rd-section${selected === block.id ? ' selected' : ''}`} key={block.id} onClick={() => onSelect(block.id)}>
      {selected === block.id && block.type !== 'break' && <div className="ed-toolbar"><span className="ed-toolbar-label">{BLOCK_LABELS[block.type]}</span><button type="button" className="text" onClick={event => { event.stopPropagation(); onComment(block.id); }}><Plus size={12} aria-hidden="true" />Kommentera</button></div>}
      {block.type !== 'break' && <button type="button" className={`rd-marker${comments.some(thread => !thread.resolved) ? ' open' : ''}${!comments.length ? ' add' : ''}`} aria-label={`Kommentera avsnitt ${draft.blocks.indexOf(block) + 1}: ${sectionLabel(draft, block.id)}, ${comments.length} trådar`} onClick={event => { event.stopPropagation(); onSelect(block.id); onComment(block.id); }}><MessageSquare size={12} aria-hidden="true" />{comments.length || '+'}</button>}
      <BlockView block={block} />
    </section>; })}
  </article></EditorContext.Provider>;
}
