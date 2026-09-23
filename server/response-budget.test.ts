import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Response } from 'express';
import { createResponseBudget } from './response-budget.js';
function response() {
  const value = Object.assign(new EventEmitter(), { destroyed: false, idle: 0, setTimeout(ms: number) { this.idle = ms; return this; }, destroy() { this.destroyed = true; this.emit('close'); return this; } });
  return value as unknown as Response;
}
test('slow downloads and archives do not block two viewers; excess viewing waits until a response drains', async () => {
  const run = createResponseBudget(); const copy=response(), archive=response(), first=response(), second=response(), third=response();
  await run(copy, 'download', 'copy', async () => {}); await run(archive, 'export', 'owner', async () => {});
  await run(first, 'view', 'recipient-1', async () => {}); await run(second, 'view', 'recipient-2', async () => {});
  let ran=false; const pending=run(third, 'view', 'recipient-3', async () => {ran=true;});
  await Promise.resolve(); assert.equal(ran,false);
  first.emit('finish'); await pending; assert.equal(ran,true);
  for(const item of [copy,archive,second,third]) item.emit('finish');
});
test('one capability cannot occupy multiple viewing slots; expired queues and interrupted work release their reservations', async () => {
  const run=createResponseBudget({waitMs:15}); const first=response(),second=response();
  await run(first,'view','a',async()=>{}); await assert.rejects(run(response(),'view','a',async()=>{}), {status:429});
  await run(second,'view','b',async()=>{});
  // Keep the test loop alive while the unref queue deadline expires.
  const keepAlive=setTimeout(()=>{},1000);
  try {await assert.rejects(run(response(),'view','c',async()=>{}), {status:429});} finally {clearTimeout(keepAlive);}
  first.emit('close'); second.emit('finish');
  const recovered=response(); await run(recovered,'view','c',async()=>{}); recovered.emit('finish');
  await assert.rejects(run(response(),'export','owner',async()=>{throw new Error('build failed');}),/build failed/);
  const next=response(); await run(next,'export','owner',async()=>{}); next.emit('finish');
});
