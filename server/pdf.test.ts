import test from 'node:test';
import assert from 'node:assert/strict';
import { PDFDocument, PDFName, PDFString, PDFHexString, PDFArray, PDFDict } from 'pdf-lib';
import { validatePdf, preparePdf, finalizePdf, sha256 } from './pdf.js';
const fixture = async () => { const pdf = await PDFDocument.create(); pdf.addPage().drawText('Ordinary contract text'); return Buffer.from(await pdf.save()); };
test('PDF worker preserves original hash and produces an appendix with a separate digest', async () => {
  const original = await fixture();
  const metadata = await validatePdf(original);
  assert.equal(metadata.pages, 1); assert.equal(metadata.hash, sha256(original));
  const final = await finalizePdf(original, 'Överenskommelse – Åsa & Björn', 'SH-test', metadata.hash, { version: 'v1', text: 'Jag godkänner dokumentet.' }, [{ name: 'Åsa Öberg', signedName: 'Åsa Öberg', email: 'asa@example.test', signedAt: '2026-09-23T10:00:00.000Z', strokes: [[[0.1,0.1],[0.5,0.8],[0.9,0.2]]], methodId: 'draw', methodVersion: '1.0.0' }], { sequence: 3, hash: 'a'.repeat(64) });
  assert.notEqual(sha256(final), metadata.hash);
  assert.equal((await PDFDocument.load(final)).getPageCount(), 2);
  assert.equal(sha256(original), metadata.hash);
});
test('PDF worker rejects active actions, signatures and incremental revisions', async () => {
  for (const key of ['OpenAction', 'ByteRange', 'AcroForm', 'Perms']) {
    const pdf = await PDFDocument.create(); pdf.addPage(); pdf.catalog.set(PDFName.of(key), PDFString.of('untrusted'));
    await assert.rejects(validatePdf(Buffer.from(await pdf.save())), /stöds inte/);
  }
  const bytes = await fixture();
  await assert.rejects(validatePdf(Buffer.concat([bytes,Buffer.from('\n%%EOF\n')])), /revisioner/);
  await assert.rejects(validatePdf(Buffer.from('not a PDF')), /PDF/);
});
test('PDF finalization refuses a mismatched original digest', async () => {
  await assert.rejects(finalizePdf(await fixture(), 'Test', 'SH-test', '0'.repeat(64), {text:'Consent',version:'v1'}, []), /fingeravtryck/);
});

test('PDF bookmark Prev keys are not mistaken for incremental revision history', async () => {
  const pdf = await PDFDocument.create(); pdf.addPage();
  const bookmark = pdf.context.obj({ Title: PDFString.of('Bookmark'), Prev: PDFString.of('previous bookmark') });
  pdf.context.register(bookmark);
  assert.equal((await validatePdf(Buffer.from(await pdf.save()))).pages, 1);
});

test('ordinary links, markup and comments are accepted without changing original bytes', async () => {
  const pdf = await PDFDocument.create(); const page = pdf.addPage(); page.drawText('Contract with ordinary annotations');
  const link = (action: any) => pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [20, 20, 120, 40], A: action }));
  const https = pdf.context.register(pdf.context.obj({ S: pdf.context.register(PDFName.of('URI')), URI: pdf.context.register(PDFHexString.fromText('https://example.com/terms')) }));
  const mail = pdf.context.obj({ S: 'URI', URI: PDFString.of('mailto:person@example.com') });
  const local = pdf.context.obj({ S: 'GoTo', D: [page.ref, 'Fit'] });
  const telephone = pdf.context.obj({ S: 'URI', URI: PDFString.of('tel:+46123456789') });
  const comment = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Text', Rect: [20, 60, 40, 80], Contents: PDFString.of('Please read this note'), T: PDFString.of('Reviewer') }));
  const popup = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [50, 60, 200, 120], Parent: comment }));
  const highlight = pdf.context.register(pdf.context.obj({ Type: 'Annot', Subtype: 'Highlight', Rect: [20, 20, 120, 40], QuadPoints: [20, 40, 120, 40, 20, 20, 120, 20] }));
  const annotations = pdf.context.obj([link(https), link(mail), link(local), link(telephone), comment, popup, highlight]);
  page.node.set(PDFName.of('Annots'), pdf.context.register(annotations));
  const bytes = Buffer.from(await pdf.save()); const before = sha256(bytes);
  assert.deepEqual(await validatePdf(bytes), { pages: 1, hash: before });
  const final = await finalizePdf(bytes, 'Avtal med länkar', 'SH-annotated', before, {text:'Jag godkänner.',version:'v1'}, [{ name:'Åsa', email:'asa@example.test', signedAt:'2026-09-23T10:00:00Z', strokes:[[[0,0],[1,1]]], methodId:'draw',methodVersion:'1.0.0' }]);
  const completed = await PDFDocument.load(final);
  assert.equal(completed.getPages()[0].node.lookup(PDFName.of('Annots'), PDFArray).size(), 7);
  assert.equal(sha256(bytes), before);
});

test('annotation support still rejects unsafe protocols, indirect actions and action chains', async () => {
  for (const variant of ['javascript-uri', 'file-uri', 'relative-uri', 'indirect-launch', 'chained-action', 'additional-action', 'widget', 'attachment', 'unknown-subtype', 'malformed-annots']) {
    const pdf = await PDFDocument.create(); const page = pdf.addPage(); page.drawText('Contract');
    const annotation = pdf.context.obj({ Type: 'Annot', Subtype: 'Link', Rect: [20,20,120,40] });
    const action = pdf.context.obj({ S: 'URI', URI: PDFString.of('https://example.com') });
    annotation.set(PDFName.of('A'), pdf.context.register(action));
    if (variant === 'javascript-uri') action.set(PDFName.of('URI'), PDFHexString.fromText('javascript:alert(1)'));
    if (variant === 'file-uri') action.set(PDFName.of('URI'), PDFString.of('file:///C:/private.txt'));
    if (variant === 'relative-uri') action.set(PDFName.of('URI'), PDFString.of('../private.txt'));
    if (variant === 'indirect-launch') action.set(PDFName.of('S'), pdf.context.register(PDFName.of('Launch')));
    if (variant === 'chained-action') action.set(PDFName.of('Next'), pdf.context.obj([{ S: 'JavaScript', JS: PDFString.of('alert(1)') }]));
    if (variant === 'additional-action') annotation.set(PDFName.of('AA'), pdf.context.obj({ E: { S:'JavaScript', JS:PDFString.of('alert(1)') } }));
    if (variant === 'widget') annotation.set(PDFName.of('Subtype'), PDFName.of('Widget'));
    if (variant === 'attachment') annotation.set(PDFName.of('Subtype'), PDFName.of('FileAttachment'));
    if (variant === 'unknown-subtype') annotation.set(PDFName.of('Subtype'), PDFName.of('FutureExecutableThing'));
    page.node.set(PDFName.of('Annots'), variant === 'malformed-annots' ? PDFString.of('not an array') : pdf.context.obj([pdf.context.register(annotation)]));
    await assert.rejects(validatePdf(Buffer.from(await pdf.save())), /stöds inte|ogiltig/, variant);
  }
});

test('preparation keeps a safe plain PDF byte-for-byte unchanged', async () => {
  const original = await fixture();
  const result = await preparePdf(original);
  assert.deepEqual(result.bytes, original);
  assert.equal(result.hash, sha256(original)); assert.equal(result.preparation, null);
});

test('preparation flattens links, visual markup and popup text deterministically', async () => {
  const pdf = await PDFDocument.create(); const page = pdf.addPage([400, 500]);
  page.drawText('Selectable source text', { x: 30, y: 450, size: 12 });
  const link = pdf.context.register(pdf.context.obj({ Type:'Annot', Subtype:'Link', Rect:[30,400,160,420], Border:[0,0,0], A:{ S:'URI', URI:PDFString.of('tel:+46123456789') } }));
  const comment = pdf.context.obj({ Type:'Annot', Subtype:'Text', Rect:[20,350,40,370], F:28, Contents:PDFHexString.fromText('Åsa: kontrollera bilaga <script>text</script>'), T:PDFHexString.fromText('Björn') });
  const commentRef = pdf.context.register(comment);
  const popup = pdf.context.register(pdf.context.obj({ Type:'Annot', Subtype:'Popup', Rect:[40,300,240,370], Parent:commentRef, Contents:PDFHexString.fromText('Åsa: kontrollera bilaga <script>text</script>') }));
  comment.set(PDFName.of('Popup'), popup);
  const highlight = pdf.context.register(pdf.context.obj({ Type:'Annot', Subtype:'Highlight', Rect:[30,440,170,465], QuadPoints:[30,465,170,465,30,440,170,440], C:[1,1,0] }));
  page.node.set(PDFName.of('Annots'), pdf.context.obj([link,commentRef,popup,highlight]));
  const original = Buffer.from(await pdf.save());
  const prepared = await preparePdf(original); const again = await preparePdf(original);
  assert.deepEqual(prepared.bytes, again.bytes);
  assert.equal(prepared.hash, sha256(prepared.bytes)); assert.notEqual(prepared.hash, sha256(original));
  assert.equal(prepared.pages, 2);
  assert.equal(prepared.preparation?.sourceHash, sha256(original));
  assert.equal(prepared.preparation?.sourceSize, original.length);
  assert.equal(prepared.preparation?.annotationCount, 4);
  assert.equal(prepared.preparation?.noteCount, 1);
  const flat = await PDFDocument.load(prepared.bytes);
  for (const flatPage of flat.getPages()) {
    const annotations = flatPage.node.lookup(PDFName.of('Annots'));
    assert.ok(annotations === undefined || annotations instanceof PDFArray && annotations.size() === 0);
  }
  const mupdf = await import('mupdf'); const rendered = new mupdf.PDFDocument(prepared.bytes);
  try {
    const sourcePage = rendered.loadPage(0); const notePage = rendered.loadPage(1);
    const sourceText = sourcePage.toStructuredText(''); const noteText = notePage.toStructuredText('');
    try {
      assert.match(sourceText.asText(), /Selectable source text/);
      assert.match(noteText.asText(), /Åsa: kontrollera bilaga <script>text<\/script>/);
      assert.match(noteText.asText(), /Originalsida 1.*Björn/);
    } finally { sourceText.destroy(); noteText.destroy(); sourcePage.destroy(); notePage.destroy(); }
  } finally { rendered.destroy(); }
});

test('preparation burns ordinary form values into selectable page content', async () => {
  const pdf = await PDFDocument.create(); const page = pdf.addPage([400, 500]);
  page.drawText('Form agreement', { x:30, y:450, size:12 });
  const form = pdf.getForm(); const name = form.createTextField('name');
  name.setText('Alice Example'); name.addToPage(page, { x:30, y:350, width:200, height:30 });
  const box = form.createCheckBox('accepted'); box.addToPage(page, { x:30, y:300, width:20, height:20 }); box.check();
  page.node.lookup(PDFName.of('Annots'), PDFArray).push(pdf.context.register(pdf.context.obj({ Type:'Annot', Subtype:'Link', Rect:[30,280,100,295], Border:[0,0,0], A:{S:'URI',URI:PDFString.of('https://example.com')} })));
  const original = Buffer.from(await pdf.save());
  await assert.rejects(validatePdf(original), /stöds inte/);
  const result = await preparePdf(original);
  assert.equal(result.preparation?.formFieldCount, 2);
  assert.equal(result.preparation?.annotationCount, 1);
  const flat = await PDFDocument.load(result.bytes); assert.equal(flat.catalog.has(PDFName.of('AcroForm')), false);
  assert.deepEqual((await preparePdf(original)).bytes, result.bytes);
  const mupdf = await import('mupdf'); const rendered = new mupdf.PDFDocument(result.bytes); const renderedPage = rendered.loadPage(0); const text = renderedPage.toStructuredText('');
  try { assert.match(text.asText(), /Alice Example/); }
  finally { text.destroy(); renderedPage.destroy(); rendered.destroy(); }
});

test('preparation refuses active content, signed forms and hidden-view ambiguity', async () => {
  for (const variant of ['js', 'xfa', 'signature', 'attachment', 'additional-action', 'no-view']) {
    const pdf = await PDFDocument.create(); const page = pdf.addPage(); page.drawText('Contract');
    const annotation = pdf.context.obj({ Type:'Annot', Subtype:'Text', Rect:[20,20,40,40], Contents:PDFString.of('Note') });
    if (variant === 'js') pdf.catalog.set(PDFName.of('OpenAction'), pdf.context.obj({ S:'JavaScript', JS:PDFString.of('alert(1)') }));
    if (variant === 'xfa') pdf.catalog.set(PDFName.of('AcroForm'), pdf.context.obj({ Fields:[], XFA:PDFString.of('xml') }));
    if (variant === 'signature') pdf.catalog.set(PDFName.of('AcroForm'), pdf.context.obj({ Fields:[{ FT:'Sig', V:{ByteRange:[0,10,20,30]} }] }));
    if (variant === 'attachment') annotation.set(PDFName.of('Subtype'), PDFName.of('FileAttachment'));
    if (variant === 'additional-action') annotation.set(PDFName.of('AA'), pdf.context.obj({ E:{S:'JavaScript',JS:PDFString.of('alert(1)')} }));
    if (variant === 'no-view') annotation.set(PDFName.of('F'), pdf.context.obj(32));
    page.node.set(PDFName.of('Annots'), pdf.context.obj([pdf.context.register(annotation)]));
    await assert.rejects(preparePdf(Buffer.from(await pdf.save())), /stöds inte|kunde inte/, variant);
  }
});
test('flattened visual markup preserves rendered pixels within blend rounding', async () => {
  const pdf = await PDFDocument.create(); const page = pdf.addPage([200, 200]);
  page.drawText('Visible contract', { x:20, y:150, size:12 });
  const appearance = pdf.context.flateStream('q 0 0 1 rg 0 0 60 25 re f Q', {Type:'XObject',Subtype:'Form',BBox:[0,0,60,25],Resources:{}});
  const stamp = pdf.context.register(pdf.context.obj({ Type:'Annot',Subtype:'Stamp',Rect:[40,50,100,75],F:4,AP:{N:pdf.context.register(appearance)} }));
  const highlight = pdf.context.register(pdf.context.obj({ Type:'Annot',Subtype:'Highlight',Rect:[20,145,130,165],F:4,QuadPoints:[20,165,130,165,20,145,130,145],C:[1,1,0] }));
  page.node.set(PDFName.of('Annots'), pdf.context.obj([stamp,highlight]));
  const original = Buffer.from(await pdf.save()); const flattened = await preparePdf(original);
  const mupdf = await import('mupdf');
  const pixels = (bytes: Uint8Array) => {
    const document = new mupdf.PDFDocument(bytes); const p = document.loadPage(0);
    const pixmap = p.toPixmap(mupdf.Matrix.identity, mupdf.ColorSpace.DeviceRGB, false, true);
    try { return Buffer.from(pixmap.getPixels()); }
    finally { pixmap.destroy(); p.destroy(); document.destroy(); }
  };
  const actual = pixels(flattened.bytes), expected = pixels(original);
  assert.equal(actual.length, expected.length);
  let maximum = 0, total = 0;
  for (let i = 0; i < actual.length; i++) { const delta = Math.abs(actual[i] - expected[i]); maximum = Math.max(maximum, delta); total += delta; }
  // MuPDF rounds transparency blending slightly differently once it is page content.
  assert.ok(maximum <= 2, `Maximum channel difference ${maximum}`);
  assert.ok(total / actual.length < 0.05, `Mean channel difference ${total / actual.length}`);
});
test('flattening tagged links removes dead annotation references and keeps text tags', async () => {
  const pdf = await PDFDocument.create(); const page = pdf.addPage(); page.drawText('Tagged contract');
  const link = pdf.context.register(pdf.context.obj({Type:'Annot',Subtype:'Link',Rect:[20,20,100,40],Border:[0,0,0],StructParent:0,A:{S:'URI',URI:PDFString.of('tel:+46123456789')}}));
  const reference = pdf.context.register(pdf.context.obj({Type:'OBJR',Obj:link,Pg:page.ref}));
  const structure = pdf.context.obj({Type:'StructElem',S:'Link',K:[0,reference],Pg:page.ref});
  const structureRef = pdf.context.register(structure);
  const root = pdf.context.register(pdf.context.obj({Type:'StructTreeRoot',K:[structureRef],ParentTree:{Nums:[0,structureRef]}}));
  structure.set(PDFName.of('P'),root); pdf.catalog.set(PDFName.of('StructTreeRoot'),root);
  page.node.set(PDFName.of('Annots'),pdf.context.obj([link]));
  const result = await preparePdf(Buffer.from(await pdf.save()));
  assert.equal(result.preparation?.annotationCount, 1);
  const flat = await PDFDocument.load(result.bytes);
  assert.ok(flat.catalog.has(PDFName.of('StructTreeRoot')));
  for (const [, object] of flat.context.enumerateIndirectObjects()) if (object instanceof PDFDict) assert.notEqual(object.lookup(PDFName.of('Type')), PDFName.of('Annot'));
  const rootDict = flat.catalog.lookup(PDFName.of('StructTreeRoot'),PDFDict);
  const struct = rootDict.lookup(PDFName.of('K'),PDFArray).lookup(0,PDFDict);
  assert.equal(struct.lookup(PDFName.of('K'),PDFArray).size(),1);
});test('PDF signature page carries the team brand, and an undecodable logo falls back to the name', async () => {
  const original = await fixture();
  const signer = { name: 'Åsa Öberg', email: 'asa@example.test', signedAt: '2026-09-23T10:00:00.000Z', strokes: [[[0.1,0.1],[0.9,0.2]]], methodId: 'draw', methodVersion: '1.0.0' };
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  const images = async (bytes: Buffer) => { const page = (await PDFDocument.load(bytes)).getPage(1); const xObjects = page.node.Resources()?.lookup(PDFName.of('XObject'), PDFDict); return xObjects?.keys().length ?? 0; };
  const branded = await finalizePdf(original, 'Avtal', 'SH-brand', sha256(original), { version: 'v1', text: 'Jag godkänner.' }, [signer], undefined, false, undefined, { name: 'Lind & Co AB', showName: true, accent: '#1b589e', logoPngBase64: png });
  assert.equal(await images(branded), 1);
  const broken = await finalizePdf(original, 'Avtal', 'SH-brand', sha256(original), { version: 'v1', text: 'Jag godkänner.' }, [signer], undefined, false, undefined, { name: 'Lind & Co AB', showName: false, accent: 'not-a-colour', logoPngBase64: Buffer.from('not a png').toString('base64') });
  assert.equal(await images(broken), 0);
  assert.equal((await PDFDocument.load(broken)).getPageCount(), 2);
});
