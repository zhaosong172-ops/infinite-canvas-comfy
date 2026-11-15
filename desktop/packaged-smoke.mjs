import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const desktop = path.dirname(fileURLToPath(import.meta.url));
const testData = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-canvas-packaged-smoke-'));
const artifacts = path.join(testData, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const app = await electron.launch({ executablePath: process.argv[2] || path.join(desktop, 'dist/win-unpacked/InfiniteCanvas Personal.exe'), env: { ...process.env, CANVAS_DESKTOP_TEST_DATA: testData }, timeout: 120000 });
let origin, agentEndpoint;
try {
 const page = await app.firstWindow({ timeout: 120000 });
 const errors = []; page.on('pageerror', e => errors.push(e.message));
 await page.waitForURL('http://127.0.0.1:**', { timeout: 30000 });
 await page.getByText('我的画布', { exact: true }).first().waitFor({ timeout: 30000 });
 await page.waitForFunction(() => !document.body.innerText.includes('正在启动个人画布'));
 origin = new URL(page.url()).origin;
 const session = await (await fetch(origin + '/desktop/session')).json();
 assert.equal(session.code, 0);
 assert.equal(session.data.user.username, '__personal_desktop__');
 agentEndpoint = session.agent.endpoint;
 const tunnels = await fetch(agentEndpoint + '/comfy/tunnels', { headers: { 'x-canvas-agent-token': session.agent.token } });
 assert.equal(tunnels.status, 200);
 assert.equal(await page.getByRole('link', { name: '登录', exact: true }).count(), 0);
 await page.screenshot({ path: path.join(artifacts, 'packaged-home-smoke.png') });
 assert.deepEqual(errors, []);
 console.log(JSON.stringify({ packagedStartup: true, personalSession: true, agentOnline: true, rendererErrors: errors }));
} finally { await app.close(); }
for (const url of [origin, agentEndpoint]) {
 let closed = false;
 for (let i = 0; i < 30; i++) { try { await fetch(url, { signal: AbortSignal.timeout(1000) }); } catch { closed = true; break; } await new Promise(r => setTimeout(r, 100)); }
 assert.equal(closed, true, 'Service did not stop: ' + url);
}
fs.writeFileSync(path.join(artifacts, 'packaged-smoke-result.json'), JSON.stringify({ packagedStartup: true, personalSession: true, agentOnline: true, cleanShutdown: true }, null, 2));
console.log('Packaged services stopped successfully');
