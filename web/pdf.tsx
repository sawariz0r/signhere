import { useCallback, useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy, type PDFPageProxy } from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { message } from './api';
import { ErrorBox, Loading } from './ui';

GlobalWorkerOptions.workerSrc = pdfWorker;

type PageNote = { key: number; id: string; parentId: string; popupRef: string; subtype: string; title: string; contents: string };

function annotationText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && 'str' in value && typeof value.str === 'string') return value.str;
  return '';
}

function pageNotes(annotations: unknown[]): PageNote[] {
  const notes = annotations.flatMap((value, key) => {
    if (!value || typeof value !== 'object') return [];
    const annotation = value as Record<string, unknown>;
    const contents = annotationText(annotation.contentsObj) || annotationText(annotation.contents) || annotationText(annotation.richText);
    if (!contents.trim()) return [];
    return [{
      key,
      id: annotationText(annotation.id),
      parentId: annotationText(annotation.parentId),
      popupRef: annotationText(annotation.popupRef),
      subtype: annotationText(annotation.subtype),
      title: annotationText(annotation.titleObj) || annotationText(annotation.title),
      contents,
    }];
  });
  return notes.filter(note => {
    if (note.subtype !== 'Popup') return true;
    const parent = notes.find(other => other.subtype !== 'Popup' && (
      (note.parentId && other.id === note.parentId) || (note.id && other.popupRef === note.id)
    ));
    if (parent) return parent.contents !== note.contents;
    // PDF.js can omit the relationship; an inherited popup is still the same note.
    return !notes.some(other => other.subtype !== 'Popup' && other.contents === note.contents && other.title === note.title);
  });
}

function Page({ pdf, number, thumbnail, zoomable, onReady, onError }: { pdf: PDFDocumentProxy; number: number; thumbnail: boolean; zoomable?: boolean; onReady: () => void; onError: (error: string) => void }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const parent = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [error, setError] = useState('');
  const [notes, setNotes] = useState<PageNote[]>([]);
  const zoom = useRef<HTMLDialogElement>(null);
  const [zoomSource, setZoomSource] = useState('');
  const enlarge = () => { if (zoomable && canvas.current) { setZoomSource(canvas.current.toDataURL('image/png')); zoom.current?.showModal(); } };
  useEffect(() => {
    const element = parent.current;
    if (!element) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { rootMargin: '500px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    let task: ReturnType<PDFPageProxy['render']> | undefined;
    setNotes([]);
    void pdf.getPage(number).then(page => {
      if (cancelled || !canvas.current) return;
      const context = canvas.current.getContext('2d');
      if (!context) throw new Error('PDF-filen kunde inte visas i den här webbläsaren.');
      const initial = page.getViewport({ scale: 1 });
      const width = thumbnail ? 260 : 1380;
      const viewport = page.getViewport({ scale: Math.min(width / initial.width, 3) });
      canvas.current.width = viewport.width; canvas.current.height = viewport.height;
      task = page.render({ canvas: canvas.current, canvasContext: context, viewport });
      return Promise.all([task.promise, thumbnail ? Promise.resolve([]) : page.getAnnotations({ intent: 'display' })]).then(([, annotations]) => {
        if (cancelled) return;
        setNotes(pageNotes(annotations));
        if (number === 1) onReady();
      });
    }).catch(error => { if (!cancelled) { const text = message(error); setError(text); onError(text); } });
    return () => { cancelled = true; task?.cancel(); };
  }, [pdf, number, thumbnail, visible, onReady, onError]);
  return <div className="pdf-page-wrap" ref={parent}>
    <div className="pdf-page" role={zoomable ? 'button' : undefined} tabIndex={zoomable ? 0 : undefined} aria-label={zoomable ? `Förstora sida ${number}` : undefined} onClick={enlarge} onKeyDown={event => { if (zoomable && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); enlarge(); } }}><canvas ref={canvas} aria-label={`Dokument, sida ${number}`} /><ErrorBox error={error} /></div>
    {zoomable && <><span className="rd-zoom-hint">Tryck på sidan för att förstora</span><dialog ref={zoom} className="rd-pdf-zoom" aria-label={`Förstorad sida ${number}`}><header><strong>Sida {number}</strong><button type="button" className="button secondary small" onClick={() => zoom.current?.close()}>Stäng</button></header><div className="rd-pdf-zoom-body">{zoomSource && <img src={zoomSource} alt={`Dokument, sida ${number}`} />}</div></dialog></>}
    <span className="page-number">{number}</span>
    {!thumbnail && notes.length > 0 && <details className="pdf-annotations" open>
      <summary>Anteckningar på sidan {number} ({notes.length})</summary>
      <ol>{notes.map(note => <li key={note.key}>{note.title && <strong dir="auto">{note.title}</strong>}<p dir="auto">{note.contents}</p></li>)}</ol>
    </details>}
  </div>;
}

export function PdfPreview({ source, thumbnail = false, zoomable = false, onReady, onError }: { source: Blob; thumbnail?: boolean; zoomable?: boolean; onReady?: () => void; onError?: (error: string) => void }) {
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState('');
  const callbacks = useRef({ onReady, onError });
  callbacks.current = { onReady, onError };
  const ready = useCallback(() => callbacks.current.onReady?.(), []);
  const failed = useCallback((text: string) => callbacks.current.onError?.(text), []);
  useEffect(() => {
    let active = true;
    let task: ReturnType<typeof getDocument> | undefined;
    setPdf(null); setError('');
    void source.arrayBuffer().then(bytes => {
      if (!active) return;
      task = getDocument({ data: new Uint8Array(bytes), enableXfa: false, useWasm: false, stopAtErrors: true });
      return task.promise;
    }).then(value => { if (active && value) setPdf(value); }).catch(error => { if (active) { const text = message(error); setError(text); failed(text); } });
    return () => { active = false; if (task) void task.destroy(); };
  }, [source, failed]);
  if (error) return <ErrorBox error={error} />;
  if (!pdf) return <Loading>Öppnar PDF…</Loading>;
  const count = thumbnail ? Math.min(pdf.numPages, 12) : pdf.numPages;
  return <><div className={thumbnail ? 'pdf-thumbnails' : 'pdf-pages'}>{Array.from({ length: count }, (_, i) => <Page key={i} pdf={pdf} number={i + 1} thumbnail={thumbnail} zoomable={zoomable} onReady={ready} onError={failed} />)}</div>{thumbnail && pdf.numPages > count && <p className="muted text-small">Visar {count} av {pdf.numPages} sidor. Öppna originalet för att läsa hela dokumentet.</p>}</>;
}
