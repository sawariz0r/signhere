import { startTransition, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { EditorContent, Node, NodeViewWrapper, ReactNodeViewRenderer, mergeAttributes, useEditor, useEditorState, type Editor, type JSONContent, type NodeViewProps } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import { Placeholder } from '@tiptap/extensions';
import TextAlign from '@tiptap/extension-text-align';
import { Color, TextStyle } from '@tiptap/extension-text-style';
import Highlight from '@tiptap/extension-highlight';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import { AlignCenter, AlignLeft, AlignRight, AtSign, Bold, Columns3, Heading1, Heading2, Heading3, ImagePlus, Italic, Link2, List, ListOrdered, Minus, Palette, Pilcrow, Quote, Rows3, Search, Table2, Trash2, Underline, X } from 'lucide-react';
import { useEditorApi } from './context';
import { allFields, fieldLabel, fieldValue, imageDataUrl, type FieldDef } from './model';

export function FieldToken({ fieldKey, selected = false }: { fieldKey: string; selected?: boolean }) {
  const { draft, preview } = useEditorApi();
  const value = fieldValue(draft, fieldKey);
  const label = fieldLabel(draft, fieldKey);
  if (preview && value) return <span>{value}</span>;
  return <span className={`ed-field ${value ? 'filled' : 'empty'}${selected ? ' selected' : ''}`} title={value ? label : `${label} saknar värde`} contentEditable={false}>{value || label}</span>;
}

/** Plain text with {{field}} tokens, as used by headings and cover titles. */
export function TokenText({ value }: { value: string }) {
  return <>{value.split(/\{\{([\w.-]+)\}\}/).map((part, index) => index % 2 ? <FieldToken key={index} fieldKey={part} /> : part)}</>;
}

function FieldView({ node, selected }: NodeViewProps) {
  return <NodeViewWrapper as="span" className="ed-chip-wrap"><FieldToken fieldKey={String(node.attrs.key)} selected={selected} /></NodeViewWrapper>;
}

const FieldNode = Node.create({
  name: 'field', group: 'inline', inline: true, atom: true, selectable: true, draggable: false,
  addAttributes() { return { key: { default: '' } }; },
  parseHTML() { return [{ tag: 'span[data-field]', getAttrs: element => ({ key: (element as HTMLElement).dataset.field }) }]; },
  renderHTML({ HTMLAttributes }) { return ['span', mergeAttributes({ 'data-field': HTMLAttributes.key }), `{{${HTMLAttributes.key}}}`]; },
  renderText({ node }) { return `{{${node.attrs.key}}}`; },
  addNodeView() { return ReactNodeViewRenderer(FieldView); },
});

export function FieldPicker({ at, onPick, onClose }: { at: { left: number; top: number }; onPick: (key: string) => void; onClose: () => void }) {
  const { draft } = useEditorApi();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  const fields = allFields(draft).filter(field => field.label.toLowerCase().includes(query.trim().toLowerCase()));
  const groups: [FieldDef['group'], string][] = [['customer', 'Kund'], ['sender', 'Avsändare'], ['document', 'Dokument'], ['custom', 'Egna fält']];
  useEffect(() => {
    const close = (event: MouseEvent) => { if (!ref.current?.contains(event.target as globalThis.Node)) onClose(); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [onClose]);
  useEffect(() => { setActive(0); }, [query]);
  const left = Math.min(at.left, window.innerWidth - 288);
  const top = at.top + 320 > window.innerHeight ? Math.max(12, at.top - 344) : at.top + 8;
  return createPortal(<div ref={ref} className="ed-popover ed-field-picker" style={{ left, top }} role="dialog" aria-label="Infoga fält">
    <label className="ed-search"><Search size={14} aria-hidden="true" /><input autoFocus value={query} placeholder="Referera till info från…" onChange={event => setQuery(event.target.value)} onKeyDown={event => {
      if (event.key === 'ArrowDown') { event.preventDefault(); setActive(index => Math.min(index + 1, fields.length - 1)); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(index => Math.max(index - 1, 0)); }
      else if (event.key === 'Enter' && fields[active]) { event.preventDefault(); onPick(fields[active].key); }
      else if (event.key === 'Escape') { event.preventDefault(); onClose(); }
    }} /></label>
    <div className="ed-field-list" role="listbox">{groups.map(([group, title]) => {
      const items = fields.filter(field => field.group === group);
      return items.length ? <div key={group}><div className="ed-field-group">{title}</div>{items.map(field => {
        const index = fields.indexOf(field);
        const value = fieldValue(draft, field.key);
        return <button key={field.key} type="button" role="option" aria-selected={index === active} className={index === active ? 'active' : ''} onMouseEnter={() => setActive(index)} onMouseDown={event => { event.preventDefault(); onPick(field.key); }}><span>{field.label}</span><span className={value ? 'ed-field-preview' : 'ed-field-preview empty'}>{value || 'tomt'}</span></button>;
      })}</div> : null;
    })}{!fields.length && <div className="ed-empty-note">Inga fält matchar.</div>}</div>
  </div>, document.body);
}

export function insertField(editor: Editor, key: string) {
  editor.chain().focus().insertContent([{ type: 'field', attrs: { key } }, { type: 'text', text: ' ' }]).setMeta('external', true).run();
}

function ToolButton({ label, active = false, onClick, children, disabled = false }: { label: string; active?: boolean; onClick: () => void; children: ReactNode; disabled?: boolean }) {
  return <button type="button" className={`ed-tool${active ? ' active' : ''}`} aria-label={label} title={label} aria-pressed={active} disabled={disabled} onMouseDown={event => event.preventDefault()} onClick={onClick}>{children}</button>;
}

const TEXT_COLORS = [['Standard', ''], ['Grå', '#5b626d'], ['Grön', 'oklch(0.5 0.13 155)'], ['Blå', 'oklch(0.5 0.15 250)'], ['Lila', 'oklch(0.5 0.17 290)'], ['Röd', 'oklch(0.55 0.18 25)']];
const HIGHLIGHTS = [['Ingen', ''], ['Gul', '#fdf1b8'], ['Grön', '#d6f2e0'], ['Blå', '#dbeafe'], ['Rosa', '#fbe0e6']];

function SelectionMenu({ editor }: { editor: Editor }) {
  const [mode, setMode] = useState<'main' | 'link' | 'color'>('main');
  const [href, setHref] = useState('');
  const state = useEditorState({ editor, selector: ({ editor }) => ({
    bold: editor.isActive('bold'), italic: editor.isActive('italic'), underline: editor.isActive('underline'), link: editor.isActive('link'),
    left: editor.isActive({ textAlign: 'left' }), center: editor.isActive({ textAlign: 'center' }), right: editor.isActive({ textAlign: 'right' }),
  }) });
  const applyLink = () => {
    const value = href.trim();
    if (!value) editor.chain().focus().extendMarkRange('link').unsetLink().setMeta('external', true).run();
    else editor.chain().focus().extendMarkRange('link').setLink({ href: /^(https?:|mailto:)/i.test(value) ? value : `https://${value}` }).setMeta('external', true).run();
    setMode('main');
  };
  return <BubbleMenu editor={editor} options={{ placement: 'top', offset: 10 }} shouldShow={({ editor, from, to }) => editor.isEditable && from !== to && !editor.isActive('field') && !editor.isActive('image')} className="ed-bubble">
    {mode === 'link' ? <form className="ed-link-form" onSubmit={event => { event.preventDefault(); applyLink(); }}><Link2 size={14} aria-hidden="true" /><input autoFocus value={href} placeholder="Klistra in länk" onChange={event => setHref(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setMode('main'); }} /><button type="submit" className="ed-tool text">Spara</button></form>
      : mode === 'color' ? <div className="ed-swatch-menu">
        <span>Text</span>{TEXT_COLORS.map(([name, color]) => <button key={name} type="button" className="ed-swatch" title={name} aria-label={`Textfärg ${name}`} style={{ color: color || 'inherit' }} onMouseDown={event => event.preventDefault()} onClick={() => { if (color) editor.chain().focus().setColor(color).run(); else editor.chain().focus().unsetColor().run(); setMode('main'); }}>A</button>)}
        <span>Markering</span>{HIGHLIGHTS.map(([name, color]) => <button key={name} type="button" className="ed-swatch" title={name} aria-label={`Markering ${name}`} style={{ background: color || 'transparent' }} onMouseDown={event => event.preventDefault()} onClick={() => { if (color) editor.chain().focus().setHighlight({ color }).run(); else editor.chain().focus().unsetHighlight().run(); setMode('main'); }}>{color ? '' : <X size={12} />}</button>)}
      </div>
      : <>
        <ToolButton label="Fetstil" active={state.bold} onClick={() => editor.chain().focus().toggleBold().run()}><Bold size={15} /></ToolButton>
        <ToolButton label="Kursiv" active={state.italic} onClick={() => editor.chain().focus().toggleItalic().run()}><Italic size={15} /></ToolButton>
        <ToolButton label="Understruken" active={state.underline} onClick={() => editor.chain().focus().toggleUnderline().run()}><Underline size={15} /></ToolButton>
        <ToolButton label="Länk" active={state.link} onClick={() => { setHref(String(editor.getAttributes('link').href ?? '')); setMode('link'); }}><Link2 size={15} /></ToolButton>
        <i className="ed-tool-sep" />
        <ToolButton label="Färg och markering" onClick={() => setMode('color')}><Palette size={15} /></ToolButton>
        <i className="ed-tool-sep" />
        <ToolButton label="Vänsterjustera" active={state.left} onClick={() => editor.chain().focus().setTextAlign('left').run()}><AlignLeft size={15} /></ToolButton>
        <ToolButton label="Centrera" active={state.center} onClick={() => editor.chain().focus().setTextAlign('center').run()}><AlignCenter size={15} /></ToolButton>
        <ToolButton label="Högerjustera" active={state.right} onClick={() => editor.chain().focus().setTextAlign('right').run()}><AlignRight size={15} /></ToolButton>
      </>}
  </BubbleMenu>;
}

function BlockToolbar({ editor, onField }: { editor: Editor; onField: () => void }) {
  const image = useRef<HTMLInputElement>(null);
  const state = useEditorState({ editor, selector: ({ editor }) => ({
    paragraph: editor.isActive('paragraph'), h1: editor.isActive('heading', { level: 1 }), h2: editor.isActive('heading', { level: 2 }), h3: editor.isActive('heading', { level: 3 }),
    quote: editor.isActive('blockquote'), bullet: editor.isActive('bulletList'), ordered: editor.isActive('orderedList'), table: editor.isActive('table'),
  }) });
  return <div className="ed-block-toolbar" role="toolbar" aria-label="Textformat" onMouseDown={event => event.preventDefault()}>
    <ToolButton label="Brödtext" active={state.paragraph && !state.quote} onClick={() => editor.chain().focus().setParagraph().run()}><Pilcrow size={15} /></ToolButton>
    <ToolButton label="Rubrik 1" active={state.h1} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}><Heading1 size={16} /></ToolButton>
    <ToolButton label="Rubrik 2" active={state.h2} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}><Heading2 size={16} /></ToolButton>
    <ToolButton label="Rubrik 3" active={state.h3} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}><Heading3 size={16} /></ToolButton>
    <ToolButton label="Citat" active={state.quote} onClick={() => editor.chain().focus().toggleBlockquote().run()}><Quote size={15} /></ToolButton>
    <i className="ed-tool-sep" />
    <ToolButton label="Punktlista" active={state.bullet} onClick={() => editor.chain().focus().toggleBulletList().run()}><List size={16} /></ToolButton>
    <ToolButton label="Numrerad lista" active={state.ordered} onClick={() => editor.chain().focus().toggleOrderedList().run()}><ListOrdered size={16} /></ToolButton>
    <i className="ed-tool-sep" />
    <ToolButton label="Infoga bild" onClick={() => image.current?.click()}><ImagePlus size={15} /></ToolButton>
    <ToolButton label="Infoga tabell" active={state.table} onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()}><Table2 size={15} /></ToolButton>
    <ToolButton label="Avdelare" onClick={() => editor.chain().focus().setHorizontalRule().run()}><Minus size={16} /></ToolButton>
    {state.table && <><i className="ed-tool-sep" />
      <ToolButton label="Lägg till rad" onClick={() => editor.chain().focus().addRowAfter().run()}><Rows3 size={15} /></ToolButton>
      <ToolButton label="Lägg till kolumn" onClick={() => editor.chain().focus().addColumnAfter().run()}><Columns3 size={15} /></ToolButton>
      <ToolButton label="Ta bort tabell" onClick={() => editor.chain().focus().deleteTable().run()}><Trash2 size={15} /></ToolButton>
    </>}
    <i className="ed-tool-sep" />
    <ToolButton label="Infoga fält (@)" onClick={onField}><AtSign size={15} /></ToolButton>
    <input ref={image} type="file" accept="image/*" hidden onChange={async event => {
      const file = event.target.files?.[0]; event.target.value = '';
      if (file) editor.chain().focus().setImage({ src: await imageDataUrl(file, 1400), alt: file.name }).setMeta('external', true).run();
    }} />
  </div>;
}

export function RichText({ content, onChange, placeholder = 'Skriv här, eller tryck @ för att infoga ett fält…', toolbar = true, className = '', editorRef }: { content: JSONContent; onChange: (content: JSONContent) => void; placeholder?: string; toolbar?: boolean; className?: string; editorRef?: RefObject<Editor | null> }) {
  const api = useEditorApi();
  const [focused, setFocused] = useState(false);
  const [picker, setPicker] = useState<{ left: number; top: number } | null>(null);
  const change = useRef(onChange);
  change.current = onChange;
  const openPicker = useRef<() => void>(() => undefined);
  const extensions = useMemo(() => [
    StarterKit.configure({ heading: { levels: [1, 2, 3] }, code: false, codeBlock: false, link: { openOnClick: false, autolink: true, defaultProtocol: 'https' } }),
    Placeholder.configure({ placeholder: ({ node }) => node.type.name === 'heading' ? 'Rubrik' : placeholder }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }), TextStyle, Color, Highlight.configure({ multicolor: true }),
    TableKit.configure({ table: { resizable: false } }), Image.configure({ allowBase64: true }), FieldNode,
  ], [placeholder]);
  // The editor owns its content after mount (undo remounts blocks), so `content` is only the starting value.
  // Stable options matter: useEditor re-applies changed options after every render, which re-renders the
  // ProseMirror view, and its DOM observer can then dispatch again while React is still committing.
  const [initialContent] = useState(content);
  const editorProps = useMemo(() => ({
    attributes: { class: `ed-prose ${className}` },
    handleKeyDown: (view: Editor['view'], event: KeyboardEvent) => {
      if (event.key !== '@') return false;
      const { $from } = view.state.selection;
      const before = $from.parent.textBetween(Math.max(0, $from.parentOffset - 1), $from.parentOffset, undefined, '￼');
      if (before && !/\s/.test(before)) return false;
      event.preventDefault(); openPicker.current(); return true;
    },
  }), [className]);
  const editor = useEditor({
    extensions, content: initialContent, editable: !api.preview, immediatelyRender: true, shouldRerenderOnTransaction: false,
    editorProps,
    onUpdate: ({ editor, transaction }) => {
      // Skip normalisation transactions (e.g. trailing nodes) that run on mount, so they don't count as edits.
      if (!editor.isFocused && !transaction.getMeta('uiEvent') && !transaction.getMeta('external')) return;
      // ProseMirror already shows the edit; the draft follows as a transition, never as a synchronous
      // update nested inside ProseMirror's DOM observer (which React stops after 50 levels, error #185).
      const json = editor.getJSON();
      startTransition(() => change.current(json));
    },
    onFocus: ({ editor }) => { setFocused(true); api.activeEditor.current = editor; },
    onBlur: () => setFocused(false),
  });
  openPicker.current = () => {
    if (!editor) return;
    const coords = editor.view.coordsAtPos(editor.state.selection.from);
    setPicker({ left: coords.left, top: coords.bottom });
  };
  useEffect(() => { editor?.setEditable(!api.preview); }, [editor, api.preview]);
  useEffect(() => {
    if (!editorRef) return;
    editorRef.current = editor;
    return () => { editorRef.current = null; };
  }, [editor, editorRef]);
  if (!editor) return null;
  return <div className="ed-rich">
    <EditorContent editor={editor} />
    {!api.preview && <SelectionMenu editor={editor} />}
    {toolbar && !api.preview && (focused || picker) && <BlockToolbar editor={editor} onField={() => openPicker.current()} />}
    {picker && <FieldPicker at={picker} onClose={() => { setPicker(null); editor.commands.focus(); }} onPick={key => { setPicker(null); insertField(editor, key); }} />}
  </div>;
}

