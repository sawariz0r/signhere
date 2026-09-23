import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, PDFNull, PDFString, PDFHexString, PDFNumber, PDFPage, rgb, grayscale, cmyk, pushGraphicsState, popGraphicsState, concatTransformationMatrix, drawObject } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { PdfSigner, AuditCheckpoint, PdfPreparation } from './pdf.js';
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

async function inspectPdfBytes(bytes: Buffer, options: { allowForms?: boolean; flat?: boolean } = {}) {
  const raw = bytes.toString('latin1');
  if ((raw.match(/%%EOF\b/g) ?? []).length !== 1 || [...raw.matchAll(/\btrailer\s*<<([\s\S]*?)>>/g)].some(match => /\/Prev\b/.test(match[1]))) throw new Error('PDF-filer med flera revisioner eller linjärisering stöds inte. Exportera en ny, platt PDF.');
  let pdf: PDFDocument;
  try { pdf = await PDFDocument.load(bytes, { ignoreEncryption: false, throwOnInvalidObject: true, updateMetadata: false }); }
  catch { throw new Error('PDF-filen är ogiltig eller krypterad. Exportera en okrypterad PDF.'); }
  const pages = pdf.getPages();
  if (pdf.isEncrypted || pages.length < 1 || pages.length > 100) throw new Error('PDF-filen måste ha 1–100 sidor och får inte vara krypterad.');
  if (pages.some(page => !Number.isFinite(page.getWidth()) || !Number.isFinite(page.getHeight()) || page.getWidth() < 1 || page.getHeight() < 1 || page.getWidth() > 14400 || page.getHeight() > 14400)) throw new Error('PDF-filen har en ogiltig sidstorlek.');
  const entries = pdf.context.enumerateIndirectObjects();
  if (entries.length > 50000) throw new Error('PDF-filen är för komplex. Exportera en enklare PDF.');
  const unsafe = () => new Error('PDF-filer med skript, bilagor, formulär eller andra aktiva funktioner stöds inte. Exportera en platt PDF.');
  const invalidAnnotation = () => new Error('PDF-filen innehåller en ogiltig anteckning eller länk. Exportera PDF-filen på nytt.');
  const forbidden = new Set(['JavaScript', 'JS', 'OpenAction', 'AA', 'EmbeddedFiles', 'EmbeddedFile', 'Launch', 'RichMedia', 'XFA', 'AcroForm', 'EF', 'ByteRange', 'Sig', 'Perms', 'DocMDP', 'Encrypt', 'GoToR', 'GoToE', 'SubmitForm', 'ResetForm', 'ImportData', 'Rendition', 'SetOCGState', 'Hide', 'Movie', 'Sound']);
  if (options.allowForms) forbidden.delete('AcroForm');
  const passiveSubtypes = new Set(['Text', 'Popup', 'FreeText', 'Line', 'Square', 'Circle', 'Polygon', 'PolyLine', 'Highlight', 'Underline', 'Squiggly', 'StrikeOut', 'Stamp', 'Caret', 'Ink']);
  const dereference = (value: unknown): unknown => {
    const refs = new Set<string>();
    while (value instanceof PDFRef) {
      const key = value.toString();
      if (refs.has(key) || refs.size >= 100) throw invalidAnnotation();
      refs.add(key); value = pdf.context.lookup(value);
      if (value === undefined) throw invalidAnnotation();
    }
    return value;
  };
  const field = (dict: PDFDict, key: string) => dereference(dict.get(PDFName.of(key)));
  const name = (value: unknown) => value instanceof PDFName ? value.decodeText() : undefined;
  const present = (value: unknown) => value !== undefined && value !== PDFNull;
  const checkDestination = (value: unknown) => {
    if (!(value instanceof PDFArray || value instanceof PDFName || value instanceof PDFString || value instanceof PDFHexString)) throw invalidAnnotation();
  };
  const checkAction = (value: unknown) => {
    const action = dereference(value);
    if (!(action instanceof PDFDict)) throw invalidAnnotation();
    // Next is an action chain here. Outline/bookmark Next links remain valid.
    if (action.has(PDFName.of('Next')) || action.has(PDFName.of('AA'))) throw unsafe();
    const kind = name(field(action, 'S'));
    if (kind === 'GoTo') { checkDestination(field(action, 'D')); return; }
    if (kind !== 'URI') throw unsafe();
    const uri = field(action, 'URI');
    if (!(uri instanceof PDFString || uri instanceof PDFHexString)) throw invalidAnnotation();
    const text = uri.decodeText();
    // No relative URI base, filesystem path, executable protocol or control bytes.
    if (/[\u0000-\u0020\u007f]/.test(text) || !/^(https?:\/\/|mailto:|tel:)/i.test(text)) throw unsafe();
    try {
      const url = new URL(text);
      if (!['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) throw unsafe();
      if (['http:', 'https:'].includes(url.protocol) && (!url.hostname || url.username || url.password)) throw unsafe();
    } catch { throw unsafe(); }
  };
  const checkAnnotation = (value: unknown) => {
    const annotation = dereference(value);
    if (!(annotation instanceof PDFDict)) throw invalidAnnotation();
    const subtype = name(field(annotation, 'Subtype'));
    if (annotation.has(PDFName.of('AA'))) throw unsafe();
    if (options.flat || (subtype !== 'Link' && !(options.allowForms && subtype === 'Widget') && !passiveSubtypes.has(subtype ?? ''))) throw unsafe();
    const action = field(annotation, 'A');
    if (present(action)) {
      if (subtype !== 'Link') throw unsafe();
      checkAction(action);
    }
    const destination = field(annotation, 'Dest');
    if (present(destination)) {
      if (subtype !== 'Link' || present(action)) throw invalidAnnotation();
      checkDestination(destination);
    }
  };
  const seen = new Set<unknown>();
  const inspect = (input: unknown, depth = 0) => {
    if (depth > 100) throw new Error('PDF-filens objektstruktur är för djupt nästlad.');
    const object = dereference(input);
    if (!object || seen.has(object)) return;
    seen.add(object);
    if (object instanceof PDFName && forbidden.has(object.decodeText())) throw unsafe();
    if (object instanceof PDFRawStream) {
      if (object.dict.has(PDFName.of('F'))) throw new Error('Externa PDF-strömmar stöds inte.');
      inspect(object.dict, depth + 1);
    } else if (object instanceof PDFDict) {
      const type = name(field(object, 'Type'));
      if (type === 'XRef' && object.has(PDFName.of('Prev'))) throw new Error('PDF-filer med tidigare revisioner stöds inte.');
      if (type === 'Annot') checkAnnotation(object);
      if (type === 'Action') checkAction(object);
      for (const [key, value] of object.entries()) {
        if (key.decodeText() === 'Annots') {
          const annotations = dereference(value);
          if (annotations !== PDFNull) {
            if (!(annotations instanceof PDFArray) || annotations.size() > 5000) throw invalidAnnotation();
            for (const annotation of annotations.asArray()) checkAnnotation(annotation);
          }
        }
        if (key.decodeText() === 'A') {
          const action = dereference(value);
          if (action instanceof PDFDict && action.has(PDFName.of('S'))) checkAction(action);
        }
        if (forbidden.has(key.decodeText())) throw unsafe();
        inspect(value, depth + 1);
      }
    } else if (object instanceof PDFArray) for (const value of object.asArray()) inspect(value, depth + 1);
  };
  for (const [, object] of entries) inspect(object);
  return { pdf, pages: pages.length, hash: hash(bytes) };
}

export async function validatePdfBytes(bytes: Buffer) {
  const { pages, hash } = await inspectPdfBytes(bytes);
  return { pages, hash };
}

interface SourceNote { page: number; author: string; text: string; }
const preparationError = () => new Error('PDF-filens interaktiva innehåll kunde inte göras platt utan att ändra utseendet. Exportera en platt PDF och försök igen.');
const stringValue = (value: unknown) => value instanceof PDFString || value instanceof PDFHexString ? value.decodeText() : '';
const numericArray = (dict: PDFDict, key: string, length?: number) => {
  const value = dict.lookup(PDFName.of(key));
  if (!(value instanceof PDFArray) || (length !== undefined && value.size() !== length)) throw preparationError();
  return value.asArray().map(item => {
    const number = dict.context.lookup(item);
    if (!(number instanceof PDFNumber) || !Number.isFinite(number.asNumber()) || Math.abs(number.asNumber()) > 1e9) throw preparationError();
    return number.asNumber();
  });
};

// MuPDF deliberately preserves links. Burn their visible appearance into the
// page before removing the link annotation. Text and vectors remain selectable.
function flattenLink(pdf: PDFDocument, page: PDFPage, annotation: PDFDict) {
  const flagValue = annotation.lookup(PDFName.of('F'));
  const flags = flagValue instanceof PDFNumber ? flagValue.asNumber() : 0;
  if (flags & 3) return; // Invisible or Hidden has no visible appearance.
  const rect = numericArray(annotation, 'Rect', 4);
  const [x0, y0, x1, y1] = [Math.min(rect[0], rect[2]), Math.min(rect[1], rect[3]), Math.max(rect[0], rect[2]), Math.max(rect[1], rect[3])];
  if (x1 === x0 || y1 === y0) return;
  const appearances = annotation.lookup(PDFName.of('AP'));
  let appearance = appearances instanceof PDFDict ? appearances.lookup(PDFName.of('N')) : undefined;
  if (appearance instanceof PDFDict) {
    const state = annotation.lookup(PDFName.of('AS'));
    appearance = state instanceof PDFName ? appearance.lookup(state) : undefined;
  }
  if (appearance instanceof PDFRawStream) {
    const box = numericArray(appearance.dict, 'BBox', 4);
    const matrix = appearance.dict.has(PDFName.of('Matrix')) ? numericArray(appearance.dict, 'Matrix', 6) : [1, 0, 0, 1, 0, 0];
    const corners = [[box[0], box[1]], [box[0], box[3]], [box[2], box[1]], [box[2], box[3]]].map(([x, y]) => [matrix[0] * x + matrix[2] * y + matrix[4], matrix[1] * x + matrix[3] * y + matrix[5]]);
    const left = Math.min(...corners.map(p => p[0])), bottom = Math.min(...corners.map(p => p[1]));
    const width = Math.max(...corners.map(p => p[0])) - left, height = Math.max(...corners.map(p => p[1])) - bottom;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) throw preparationError();
    const sx = (x1 - x0) / width, sy = (y1 - y0) / height;
    appearance.dict.set(PDFName.of('Type'), PDFName.of('XObject'));
    appearance.dict.set(PDFName.of('Subtype'), PDFName.of('Form'));
    const key = page.node.newXObject('FlatLink', pdf.context.register(appearance));
    page.pushOperators(pushGraphicsState(), concatTransformationMatrix(sx, 0, 0, sy, x0 - left * sx, y0 - bottom * sy), drawObject(key), popGraphicsState());
    return;
  }
  if (appearances && appearances !== PDFNull) throw preparationError();
  const borderStyle = annotation.lookup(PDFName.of('BS'));
  const border = annotation.lookup(PDFName.of('Border'));
  let width = 1, dash: number[] = [], underline = false;
  if (borderStyle instanceof PDFDict) {
    const w = borderStyle.lookup(PDFName.of('W'));
    if (w !== undefined && !(w instanceof PDFNumber)) throw preparationError();
    width = w instanceof PDFNumber ? w.asNumber() : 1;
    const style = borderStyle.lookup(PDFName.of('S'));
    const kind = style instanceof PDFName ? style.decodeText() : 'S';
    if (!['S', 'D', 'U'].includes(kind)) throw preparationError();
    underline = kind === 'U';
    if (kind === 'D') dash = borderStyle.has(PDFName.of('D')) ? numericArray(borderStyle, 'D') : [3];
  } else if (border instanceof PDFArray) {
    if (border.size() < 3 || border.size() > 4) throw preparationError();
    const numbers = border.asArray().slice(0, 3).map(value => pdf.context.lookup(value));
    if (!numbers.every(value => value instanceof PDFNumber)) throw preparationError();
    const [rx, ry, w] = (numbers as PDFNumber[]).map(value => value.asNumber());
    width = w;
    if (width > 0 && (rx !== 0 || ry !== 0)) throw preparationError();
    if (border.size() === 4) {
      const pattern = pdf.context.lookup(border.get(3));
      if (!(pattern instanceof PDFArray)) throw preparationError();
      dash = pattern.asArray().map(value => {
        const n = pdf.context.lookup(value); if (!(n instanceof PDFNumber)) throw preparationError(); return n.asNumber();
      });
    }
  } else if (border !== undefined && border !== PDFNull) throw preparationError();
  if (!Number.isFinite(width) || width < 0 || width > 100 || dash.some(value => !Number.isFinite(value) || value < 0) || (dash.length > 0 && dash.every(value => value === 0))) throw preparationError();
  if (width === 0) return;
  const components = annotation.has(PDFName.of('C')) ? numericArray(annotation, 'C') : [0];
  if (components.length === 0) return;
  if (![1, 3, 4].includes(components.length) || components.some(value => value < 0 || value > 1)) throw preparationError();
  const color = components.length === 1 ? grayscale(components[0]) : components.length === 3 ? rgb(components[0], components[1], components[2]) : cmyk(components[0], components[1], components[2], components[3]);
  if (underline) page.drawLine({ start: { x: x0, y: y0 }, end: { x: x1, y: y0 }, thickness: width, color, dashArray: dash });
  else page.drawRectangle({ x: x0, y: y0, width: x1 - x0, height: y1 - y0, borderWidth: width, borderColor: color, borderDashArray: dash });
}

async function appendStaticNotes(pdf: PDFDocument, notes: SourceNote[]) {
  if (!notes.length) return;
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(readFileSync(new URL('./assets/NotoSans-Regular.ttf', import.meta.url)), { subset: true });
  const supported = new Set(font.getCharacterSet());
  if (notes.some(note => [...note.text + note.author].some(character => character.codePointAt(0)! > 31 && !supported.has(character.codePointAt(0)!)))) throw preparationError();
  let page = pdf.addPage([595.28, 841.89]), y = 790;
  const nextPage = () => { page = pdf.addPage([595.28, 841.89]); y = 790; };
  const line = (text: string, size = 10) => {
    if (y < 55) nextPage();
    page.drawText(text, { x: 44, y, size, font, color: rgb(0.055, 0.067, 0.086) }); y -= size + 6;
  };
  const wrap = (text: string, size = 10) => {
    for (const paragraph of text.replace(/\r\n?/g, '\n').split('\n')) {
      let current = '';
      for (const character of paragraph.replace(/[\u0000-\u001f\u007f]/g, ' ')) {
        if ((current.length >= 512 || font.widthOfTextAtSize(current + character, size) > 505) && current) { line(current, size); current = ''; }
        current += character;
      }
      line(current || ' ', size);
    }
  };
  line('signhere / anteckningar från originalfilen', 17); y -= 10;
  wrap('Anteckningarnas text har lagts till som fasta sidor när PDF-filen förbereddes för signering. Hänvisningarna gäller sidnumren i den uppladdade filen.', 9); y -= 14;
  for (const note of notes) {
    if (y < 115) nextPage();
    wrap(`Originalsida ${note.page}${note.author ? ` · ${note.author}` : ''}`, 11);
    wrap(note.text); y -= 14;
  }
}

// Tagged PDFs can reference annotations through structure OBJR children after
// removal from /Annots. Remove those references while retaining text tags/MCIDs.
function detachAnnotationStructure(pdf: PDFDocument, removed: Set<PDFDict>) {
  let changed = false;
  const seen = new Set<unknown>();
  const prune = (value: any): any => {
    const object = pdf.context.lookup(value);
    if (object instanceof PDFDict && object.lookup(PDFName.of('Type')) === PDFName.of('OBJR')) {
      const target = object.lookup(PDFName.of('Obj'));
      if (target instanceof PDFDict && removed.has(target)) { changed = true; return undefined; }
    }
    if (seen.has(object)) return value;
    seen.add(object);
    if (object instanceof PDFArray) {
      for (let index = object.size() - 1; index >= 0; index--) if (prune(object.get(index)) === undefined) object.remove(index);
    } else if (object instanceof PDFDict && object.has(PDFName.of('K'))) {
      if (prune(object.get(PDFName.of('K'))) === undefined) object.delete(PDFName.of('K'));
    }
    return value;
  };
  for (const [ref, object] of pdf.context.enumerateIndirectObjects()) {
    if (object instanceof PDFDict) {
      const type = object.lookup(PDFName.of('Type'));
      if (type === PDFName.of('StructElem') || type === PDFName.of('StructTreeRoot')) prune(ref);
    }
  }
  const root = pdf.catalog.get(PDFName.of('StructTreeRoot'));
  if (root) prune(root);
  return changed;
}
export async function preparePdfBytes(bytes: Buffer) {
  const checked = await inspectPdfBytes(bytes, { allowForms: true });
  const pdf = checked.pdf;
  const notes: SourceNote[] = [];
  const flattenedAnnotations = new Set<PDFDict>();
  let annotationCount = 0, formFieldCount = 0, hasLinks = false;
  const seenFields = new Set<PDFDict>();
  const form = pdf.catalog.lookup(PDFName.of('AcroForm'));
  if (form !== undefined && form !== PDFNull) {
    if (!(form instanceof PDFDict)) throw preparationError();
    const fields = form.lookup(PDFName.of('Fields'));
    if (!(fields instanceof PDFArray)) throw preparationError();
    // Traverse the actual field tree, including inherited type. Refuse malformed
    // widgets and unsupported field types before handing the document to MuPDF.
    const visit = (value: unknown, inheritedType?: string, depth = 0) => {
      const field = value instanceof PDFRef ? pdf.context.lookup(value) : value;
      if (!(field instanceof PDFDict) || seenFields.has(field) || depth > 50) throw preparationError();
      seenFields.add(field);
      const ownType = field.lookup(PDFName.of('FT'));
      const type = ownType instanceof PDFName ? ownType.decodeText() : inheritedType;
      if (type !== undefined && !['Tx', 'Btn', 'Ch'].includes(type)) throw preparationError();
      const kids = field.lookup(PDFName.of('Kids'));
      if (kids !== undefined && kids !== PDFNull) {
        if (!(kids instanceof PDFArray)) throw preparationError();
        const widgetOnly = kids.asArray().every(child => {
          const object = pdf.context.lookup(child);
          return object instanceof PDFDict && object.lookup(PDFName.of('Subtype')) === PDFName.of('Widget') && !object.has(PDFName.of('T'));
        });
        if (widgetOnly) {
          if (!type) throw preparationError();
          formFieldCount++;
          for (const kid of kids.asArray()) visitWidget(kid);
        } else for (const kid of kids.asArray()) visit(kid, type, depth + 1);
      } else {
        if (!type) throw preparationError();
        formFieldCount++;
      }
    };
    const visitWidget = (value: unknown) => {
      const widget = value instanceof PDFRef ? pdf.context.lookup(value) : value;
      if (!(widget instanceof PDFDict) || seenFields.has(widget)) throw preparationError();
      seenFields.add(widget);
      if (widget.has(PDFName.of('Kids')) || widget.has(PDFName.of('FT'))) throw preparationError();
    };
    for (const value of fields.asArray()) visit(value);
    if (formFieldCount > 5000) throw preparationError();
  }
  for (const [index, page] of pdf.getPages().entries()) {
    const annotations = page.node.lookup(PDFName.of('Annots'));
    if (!(annotations instanceof PDFArray)) continue;
    const references = annotations.asArray();
    const objects = references.map(value => pdf.context.lookup(value));
    let pageHasLinks = false;
    const pageNotes = new Set<string>();
    for (const annotation of objects) {
      if (!(annotation instanceof PDFDict)) throw preparationError();
      flattenedAnnotations.add(annotation);
      const subtype = annotation.lookup(PDFName.of('Subtype'));
      const kind = subtype instanceof PDFName ? subtype.decodeText() : '';
      const flagValue = annotation.lookup(PDFName.of('F'));
      if (flagValue !== undefined && !(flagValue instanceof PDFNumber)) throw preparationError();
      const flags = flagValue instanceof PDFNumber ? flagValue.asNumber() : 0;
      // These appearance modes depend on the viewer or optional layers. Baking
      // cannot safely infer which view the sender intended to freeze.
      if (!Number.isSafeInteger(flags) || flags < 0 || flags & (32 | 256) || ((flags & 16) !== 0 && page.getRotation().angle % 360 !== 0) || annotation.has(PDFName.of('OC'))) throw preparationError();
      if (kind === 'Widget') {
        if (!(form instanceof PDFDict) || !seenFields.has(annotation)) throw preparationError();
      } else annotationCount++;
      if (kind === 'Link') { flattenLink(pdf, page, annotation); hasLinks = true; pageHasLinks = true; continue; }
      const text = stringValue(annotation.lookup(PDFName.of('Contents'))).trim();
      if (!text || kind === 'Widget') continue;
      const author = stringValue(annotation.lookup(PDFName.of('T'))).trim();
      const parent = annotation.lookup(PDFName.of('Parent'));
      if (kind === 'Popup' && parent instanceof PDFDict && objects.includes(parent) && stringValue(parent.lookup(PDFName.of('Contents'))).trim()) continue;
      const key = `${author}\u0000${text}`;
      if (kind === 'Popup' && pageNotes.has(key)) continue;
      notes.push({ page: index + 1, author, text }); pageNotes.add(key);
      if (notes.length > 1000 || notes.reduce((sum, note) => sum + note.text.length + note.author.length, 0) > 100_000) throw preparationError();
    }
    // Delete only links here: MuPDF bakes all remaining supported appearances.
    if (pageHasLinks) page.node.set(PDFName.of('Annots'), pdf.context.obj(references.filter((_, i) => !(objects[i] instanceof PDFDict) || (objects[i] as PDFDict).lookup(PDFName.of('Subtype')) !== PDFName.of('Link'))));
  }
  if (annotationCount === 0 && !(form instanceof PDFDict)) {
    // The no-op path must meet the same flat postcondition; detached interactive
    // objects must not bypass validation just because no page references them.
    await inspectPdfBytes(bytes, { flat: true });
    return { bytes, pages: checked.pages, hash: checked.hash, preparation: null };
  }
  const detachedStructure = detachAnnotationStructure(pdf, flattenedAnnotations);
  const mupdf = await import('mupdf');
  const engineVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.resolve('mupdf')), 'utf8')).version as string;
  const source = hasLinks || detachedStructure ? await pdf.save({ useObjectStreams: true, updateFieldAppearances: false }) : bytes;
  const document = new mupdf.PDFDocument(source);
  let flattened: Buffer;
  try {
    document.disableJS();
    if (document.needsPassword() || document.wasRepaired()) throw preparationError();
    document.bake(true, true);
    const output = document.saveToBuffer('garbage=4,compress=yes,regenerate-id=no,reproducible=yes');
    try { flattened = Buffer.from(output.asUint8Array()); } finally { output.destroy(); }
  } finally { document.destroy(); }
  // Baking can preserve interactive objects it could not handle. Never discard
  // those silently, nor freeze a hash for a partially prepared document.
  const baked = await inspectPdfBytes(flattened, { flat: true });
  if (notes.length) {
    await appendStaticNotes(baked.pdf, notes);
    flattened = Buffer.from(await baked.pdf.save({ useObjectStreams: true, updateFieldAppearances: false }));
  }
  if (flattened.length > 10 * 1024 * 1024) throw new Error('Den förberedda PDF-filen överskrider 10 MB. Exportera en mindre PDF.');
  const result = await inspectPdfBytes(flattened, { flat: true });
  const preparation: PdfPreparation = { kind: 'flatten', engine: 'mupdf', engineVersion, sourceHash: checked.hash, sourceSize: bytes.length, annotationCount, formFieldCount, noteCount: notes.length };
  return { bytes: flattened, pages: result.pages, hash: result.hash, preparation };
}
export async function createCompletedPdf(original: Uint8Array, title: string, documentId: string, originalHash: string, consent: { text: string; version: string }, signers: PdfSigner[], checkpoint?: AuditCheckpoint) {
  if (hash(original) !== originalHash) throw new Error('Originalfilens fingeravtryck stämmer inte.');
  const pdf = await PDFDocument.load(original, { updateMetadata: false });
  pdf.registerFontkit(fontkit);
  const font = await pdf.embedFont(readFileSync(new URL('./assets/NotoSans-Regular.ttf', import.meta.url)), { subset: true });
  const color = rgb(0.055, 0.067, 0.086);
  for (const [index, signer] of signers.entries()) {
    let page = pdf.addPage([595.28, 841.89]);
    let y = 789;
    const line = (text: string, size = 10) => {
      if (y < 70) { page = pdf.addPage([595.28, 841.89]); y = 789; }
      page.drawText(text.replace(/[\r\n\t]/g, ' '), { x: 44, y, size, font, color }); y -= size + 9;
    };
    const wrap = (text: string, size = 10) => {
      // Wrap character by character too: names, hashes and titles can lack spaces.
      let current = '';
      for (const character of text.replace(/[\r\n\t]/g, ' ')) {
        if ((current.length >= 512 || font.widthOfTextAtSize(current + character, size) > 505) && current) { line(current, size); current = ''; }
        current += character;
      }
      if (current) line(current, size);
    };
    line('signhere / signeringsbevis', 22); y -= 12;
    wrap(title, 14); y -= 8;
    line(`Dokument: ${documentId}`, 9);
    line(`Undertecknare ${index + 1} av ${signers.length}`, 12);
    wrap(`Uppgivet namn: ${signer.signedName ?? signer.name}`);
    wrap(`Tilldelad mottagare: ${signer.name}`);
    wrap(`Mottagaradress: ${signer.email}`);
    line(`Signeringstid (server, UTC): ${signer.signedAt}`);
    line(`Metod: ${signer.methodId} ${signer.methodVersion}`);
    y -= 10;
    const boxY = y - 100;
    page.drawRectangle({ x: 44, y: boxY, width: 505, height: 100, borderWidth: 0.7, borderColor: rgb(0.8, 0.82, 0.84) });
    for (const stroke of signer.strokes) for (let i = 1; i < stroke.length; i++) {
      page.drawLine({ start: { x: 54 + stroke[i - 1][0] * 485, y: boxY + 10 + (1 - stroke[i - 1][1]) * 80 }, end: { x: 54 + stroke[i][0] * 485, y: boxY + 10 + (1 - stroke[i][1]) * 80 }, thickness: 1.5, color });
    }
    y = boxY - 25;
    line(`Samtycke: ${consent.version}`, 10);
    wrap(consent.text, 9); y -= 10;
    line('Originalets SHA-256:', 9); line(originalHash, 8);
    if (checkpoint) {
      line(`Kontrollpunkt i händelsekedjan: ${checkpoint.sequence}`, 9);
      line(checkpoint.hash, 8);
    }
    y -= 8;
    wrap('Ritad elektronisk underskrift med innehav av personlig länk. Identiteten är inte verifierad med e-legitimation. Detta är inte en kvalificerad underskrift, betrodd tidsstämpel eller kryptografisk PDF-försegling.', 8);
    wrap('Spara originalfilen, den färdiga PDF-filen och JSON-verifikatet tillsammans. Deras fingeravtryck och händelsekedja kan kontrolleras oberoende av den här installationen.', 8);
  }
  const output = Buffer.from(await pdf.save({ useObjectStreams: true }));
  if (output.length > 25 * 1024 * 1024) throw new Error('Den färdiga PDF-filen överskrider storleksgränsen.');
  return output;
}
