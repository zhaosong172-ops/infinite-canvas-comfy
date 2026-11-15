import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const desktop = path.dirname(fileURLToPath(import.meta.url));
const executable = process.argv[2] || path.join(desktop, 'dist/InfiniteCanvas-Personal-0.1.2-Windows-x64.exe');
const testData = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-canvas-portable-smoke-'));
const artifacts = path.join(testData, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
process.env.CANVAS_DESKTOP_TEST_DATA = testData;
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const debugPort = await new Promise(resolve => { const server = net.createServer(); server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); }); });
function launch(args = []) {
 const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
 child.stdout.resume(); child.stderr.resume();
 child.done = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', code => resolve(code)); });
 return child;
}
async function waitFor(fn, label, attempts = 180) {
 for (let i = 0; i < attempts; i++) { try { const value = await fn(); if (value) return value; } catch {} await delay(500); }
 throw new Error(label + ' timed out');
}
const first = launch(['--remote-debugging-port=' + debugPort]);
const version = await waitFor(async () => { const response = await fetch('http://127.0.0.1:' + debugPort + '/json/version', { signal: AbortSignal.timeout(1000) }); return response.ok ? response.json() : null; }, 'Portable debugging');
const browser = await chromium.connectOverCDP(version.webSocketDebuggerUrl);
const context = browser.contexts()[0];
const page = await waitFor(() => context.pages().find(page => page.url().startsWith('http://127.0.0.1:')), 'Main window');
await page.getByText('我的画布', { exact: true }).first().waitFor({ timeout: 30000 });
const origin = new URL(page.url()).origin;
const getSession = async () => { const response = await fetch(origin + '/desktop/session', { signal: AbortSignal.timeout(3000) }); const session = await response.json(); assert.equal(session.code, 0); assert.equal(session.data.user.username, '__personal_desktop__'); return session; };
const session = await getSession();
const staticAsset = await page.locator('script[src*="/_next/static/"]').first().getAttribute('src');
assert.ok(staticAsset);
for (let repetition = 0; repetition < 2; repetition++) {
 const repeated = launch();
 const exit = await Promise.race([repeated.done, delay(90000).then(() => { throw new Error('Repeated launch did not exit'); })]);
 assert.equal(exit, 0);
 await getSession();
 const asset = await fetch(new URL(staticAsset, origin), { cache: 'no-store', signal: AbortSignal.timeout(3000) });
 assert.equal(asset.status, 200, 'Running application resources were removed');
 assert.ok((await asset.text()).length > 0);
 const agent = await fetch(session.agent.endpoint + '/comfy/tunnels', { headers: { 'x-canvas-agent-token': session.agent.token }, signal: AbortSignal.timeout(3000) });
 assert.equal(agent.status, 200);
 console.log('Repeated launch ' + (repetition + 1) + ': existing window and runtime files remain available');
}
await page.screenshot({ path: path.join(artifacts, 'portable-smoke.png') });
// Closing the browser through the development protocol triggers Electron's regular window shutdown.
const connection = await browser.newBrowserCDPSession();
await connection.send('Browser.close').catch(() => {});
await waitFor(async () => { try { await fetch(origin, { signal: AbortSignal.timeout(1000) }); return false; } catch { return true; } }, 'Gateway shutdown', 40);
await waitFor(async () => { try { await fetch(session.agent.endpoint, { signal: AbortSignal.timeout(1000) }); return false; } catch { return true; } }, 'Agent shutdown', 40);
const exit = await Promise.race([first.done, delay(60000).then(() => { throw new Error('Portable process did not stop'); })]);
assert.equal(exit, 0);
const versionMatch = path.basename(executable).match(/-(\d+\.\d+\.\d+)-Windows-x64\.exe$/);
const result = { version: versionMatch?.[1] || 'unknown', personalSession: true, repeatedLaunches: 2, runtimeFilesPreserved: true, agentOnline: true, cleanShutdown: true };
fs.writeFileSync(path.join(artifacts, 'portable-smoke-result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
process.exit(0);
