import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
process.env.ORKESTRA_ELEVENLABS_TEST = '1';
const root = await mkdtemp(join(tmpdir(), 'orkestra-elevenlabs-'));
process.env.ORKESTRA_ELEVENLABS_DIRECTORY = root;
const { withConnectionLock, forwardAudioTool } = await import('./mcp-bridge.mjs');
test('concurrent callers do not refresh the shared account simultaneously', async () => {
  let active=0, peak=0;
  await Promise.all(Array.from({length:3}, () => withConnectionLock(async () => {
    active++;peak=Math.max(peak,active);
    await new Promise(resolve=>setTimeout(resolve,20));
    active--;
  })));
  assert.equal(peak,1);
});
test('failed requests release the account lock', async () => {
  await assert.rejects(withConnectionLock(async()=>{throw new Error('test');}));
  assert.equal(await withConnectionLock(async()=>42),42);
  await assert.rejects(access(join(root,'connection.lock')));
});
test('a crashed bridge does not permanently block the next request', async () => {
  const lock=join(root,'connection.lock');await mkdir(lock);
  await writeFile(join(lock,'owner'),'2147483647');
  assert.equal(await withConnectionLock(async()=>42),42);
});
test.after(async()=>{await rm(root,{recursive:true,force:true});});

test('video and image generation cannot be called directly or through generic flow tools', async () => {
  let calls=0;
  const client={callTool:async()=>{calls++;}};
  for (const name of ['creative_generate_video','creative_generate_image','creative_generate_in_flow','creative_add_flow_node','creative_run_flow_nodes','creative_update_node']) {
    await assert.rejects(forwardAudioTool(client,{name,arguments:{}},{}), /yalnızca ses/);
  }
  assert.equal(calls,0);
});
test('speech generation preserves the actual request and result', async () => {
  const params={name:'creative_generate_speech',arguments:{prompt:'Merhaba'}};
  const result={content:[{type:'text',text:'ses sonucu'}]};
  const client={callTool:async(received)=>{assert.equal(received,params);return result;}};
  assert.equal(await forwardAudioTool(client,params,{}),result);
});
