import { _electron as electron } from 'playwright';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
const desktop = path.dirname(fileURLToPath(import.meta.url));
process.chdir(desktop);
const testData = fs.mkdtempSync(path.join(os.tmpdir(), 'personal-canvas-smoke-'));
const artifacts = path.join(testData, 'artifacts');
fs.mkdirSync(artifacts, { recursive: true });
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j5N8AAAAASUVORK5CYII=', 'base64');
const mp4 = Buffer.from('mock-mp4-result');
const submittedPrompts = {};
let apiAuthCount = 0;
const comfy = http.createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer test-comfy-key') { res.writeHead(401); res.end(); return; }
    apiAuthCount++;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/system_stats') return res.end(JSON.stringify({ system: { device_name: 'Mock GPU' }, devices: [{ name: 'Mock GPU' }] }));
    if (req.url === '/queue') return res.end(JSON.stringify({ queue_running: [], queue_pending: [] }));
    if (req.url === '/prompt') {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const prompt = JSON.parse(Buffer.concat(chunks).toString()).prompt;
        const video = Object.values(prompt).some(node => node.class_type === 'SaveVideo');
        const promptId = video ? 'smoke-video' : 'smoke-prompt';
        submittedPrompts[promptId] = prompt;
        return res.end(JSON.stringify({ prompt_id: promptId }));
    }
    if (req.url === '/history/smoke-prompt') return res.end(JSON.stringify({ 'smoke-prompt': { status: { completed: true, status_str: 'success' }, outputs: { '2': { images: [{ filename: 'result.png', subfolder: '', type: 'output' }] } } } }));
    if (req.url === '/history/smoke-video') return res.end(JSON.stringify({ 'smoke-video': { status: { completed: true, status_str: 'success' }, outputs: { '2': { videos: [{ filename: 'result.mp4', subfolder: '', type: 'output' }] } } } }));
    if (req.url.startsWith('/view')) { const video = req.url.includes('result.mp4'); res.setHeader('content-type', video ? 'video/mp4' : 'image/png'); return res.end(video ? mp4 : png); }
    res.writeHead(404); res.end('{}');
});
await new Promise(resolve => comfy.listen(0, '127.0.0.1', resolve));
const app = await electron.launch({ executablePath: path.resolve('node_modules/electron/dist/electron.exe'), args: ['.'], env: { ...process.env, CANVAS_DESKTOP_TEST_DATA: testData }, timeout: 120000 });
try {
    const page = await app.firstWindow({ timeout: 120000 });
    const errors = [];
    page.on('requestfailed', request => console.log('Browser network failure: ' + request.failure()?.errorText + ' URL=' + request.url()));
    page.on('pageerror', error => errors.push(error.message));
    await page.waitForFunction(() => !document.body.innerText.includes('正在启动个人画布'), { timeout: 30000 });
    await page.waitForTimeout(2000);
    const origin = new URL(page.url()).origin;
    const sessionResponse = await fetch(origin + '/desktop/session');
    const session = await sessionResponse.json();
    assert.equal(session.code, 0);
    assert.equal(session.data.user.username, '__personal_desktop__');
    assert.ok(session.agent.token);
    assert.equal((await fetch(origin + '/desktop/session', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
    assert.equal((await fetch(origin + '/api/auth/personal', { method: 'POST' })).status, 403);
    const api = async (route, body) => {
        const response = await fetch(origin + route, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer ' + session.data.token, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
        const result = await response.json();
        assert.equal(result.code, 0, route + ': ' + result.msg);
        return result.data;
    };
    const comfyUrl = 'http://127.0.0.1:' + comfy.address().port;
    const statusResponse = await fetch(origin + '/desktop/agent/comfy/status', { method: 'POST', headers: { 'x-canvas-agent-token': session.agent.token, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: comfyUrl, apiKey: 'test-comfy-key' }) });
    const status = await statusResponse.json();
    assert.equal(status.online, true);
    await page.evaluate(async ({ comfyUrl }) => {
        const session = await (await fetch('/desktop/session')).json();
        const result = await (await fetch('/desktop/agent/comfy/status', { method: 'POST', headers: { 'x-canvas-agent-token': session.agent.token, 'content-type': 'application/json' }, body: JSON.stringify({ url: comfyUrl, apiKey: 'test-comfy-key' }) })).json();
        if (!result.online) throw new Error('Agent ComfyUI request failed: ' + JSON.stringify(result));
    }, { comfyUrl });
    assert.equal(status.running, 0);
    const agentCorsProbe = await page.evaluate(async (comfyUrl) => {
        const session = await (await fetch('/desktop/session')).json();
        const call = async (path, init) => { try { const response = await fetch('/desktop/agent' + path, { ...init, headers: { 'x-canvas-agent-token': session.agent.token, 'content-type': 'application/json' } }); return { status: response.status, body: await response.json() }; } catch (error) { return { error: error.message }; } };
        return { get: await call('/comfy/tunnels'), post: await call('/comfy/status', { method: 'POST', body: JSON.stringify({ url: comfyUrl, apiKey: 'test-comfy-key' }) }) };
    }, comfyUrl);
    console.log('Agent browser CORS probe: ' + JSON.stringify(agentCorsProbe));
    assert.equal(agentCorsProbe.get.status, 200);
    const created = await api('/api/v1/comfy-bridges', { name: 'Smoke Bridge' });
    const bridgeResponse = await fetch(origin + '/desktop/bridge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ comfyUrl, apiKey: 'test-comfy-key', token: created.token }) });
    assert.equal(bridgeResponse.status, 200, await bridgeResponse.text());
    for (let i = 0; i < 20; i++) { if ((await api('/api/v1/comfy-bridges')).some(item => item.id === created.bridge.id && item.online)) break; await new Promise(resolve => setTimeout(resolve, 500)); }
    const workflowJson = { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'initial' } }, '2': { class_type: 'SaveImage', inputs: { images: ['1', 0], filename_prefix: 'canvas' } } };
    const inspected = await api('/api/v1/comfy-bridges/inspect', { bridgeId: created.bridge.id, workflowId: 'smoke', workflowJson, capability: 'image' });
    const entry = { provider: 'comfyui', kind: 'workflow', workflowId: 'smoke', title: 'Smoke', capability: 'image', enabled: true, fields: inspected.fields, workflowJson: inspected.workflowJson };
    const videoJson = { '1': { class_type: 'CLIPTextEncode', inputs: { text: 'initial' } }, '2': { class_type: 'SaveVideo', inputs: { video: ['1', 0], filename_prefix: 'canvas' } } };
    const videoInspected = await api('/api/v1/comfy-bridges/inspect', { bridgeId: created.bridge.id, workflowId: 'smoke-video', workflowJson: videoJson, capability: 'video' });
    const videoEntry = { provider: 'comfyui', kind: 'workflow', workflowId: 'smoke-video', title: 'Smoke video', capability: 'video', enabled: true, fields: videoInspected.fields, workflowJson: videoInspected.workflowJson };
    await api('/api/v1/user-config/model', { config: { localChannels: [{ id: 'smoke-comfy', name: 'Comfy smoke', protocol: 'comfyui', bridgeId: created.bridge.id }], workflowChannels: [{ channelId: 'smoke-comfy', protocol: 'comfyui', workflows: [entry, videoEntry] }] } });
    let task = await api('/api/v1/workflow-tasks', { ref: { scope: 'personal', channelId: 'smoke-comfy', kind: 'workflow', workflowId: 'smoke' }, expectedCapability: 'image', prompt: 'smoke generated prompt', count: 1 });
    for (let i = 0; i < 40 && ['queued', 'running'].includes(task.status); i++) { await new Promise(resolve => setTimeout(resolve, 500)); task = await api('/api/v1/workflow-tasks/' + task.id); }
    assert.equal(task.status, 'succeeded', JSON.stringify(task));
    assert.equal(submittedPrompts['smoke-prompt']['1'].inputs.text, 'smoke generated prompt');
    assert.ok(task.urls?.length);
    const output = await fetch(task.urls[0]);
    assert.equal(output.status, 200);
    assert.equal(Buffer.from(await output.arrayBuffer()).compare(png), 0);
    let videoTask = await api('/api/v1/workflow-tasks', { ref: { scope: 'personal', channelId: 'smoke-comfy', kind: 'workflow', workflowId: 'smoke-video' }, expectedCapability: 'video', prompt: 'smoke generated video' });
    for (let i = 0; i < 40 && ['queued', 'running'].includes(videoTask.status); i++) { await new Promise(resolve => setTimeout(resolve, 500)); videoTask = await api('/api/v1/workflow-tasks/' + videoTask.id); }
    assert.equal(videoTask.status, 'succeeded', JSON.stringify(videoTask));
    assert.equal(submittedPrompts['smoke-video']['1'].inputs.text, 'smoke generated video');
    assert.ok(videoTask.urls?.length);
    const videoOutput = await fetch(videoTask.urls[0]);
    assert.equal(videoOutput.status, 200);
    assert.equal(Buffer.from(await videoOutput.arrayBuffer()).compare(mp4), 0);
    assert.ok(apiAuthCount > 0);
    assert.equal(await page.getByRole('link', { name: '登录', exact: true }).count(), 0);
    await page.screenshot({ path: path.join(artifacts, 'home-smoke.png') });
    await page.reload();
    await page.waitForTimeout(1500);
    const openDialog = page.locator('.ant-modal:visible button[aria-label="关闭"]');
    if (await openDialog.count()) await openDialog.last().click();
    await page.getByRole('button', { name: '配置', exact: true }).click();
    await page.waitForTimeout(600);
    await page.screenshot({ path: path.join(artifacts, 'settings-smoke.png') });
    await page.getByRole('button', { name: /选\s*择/ }).first().click();
    await page.getByText('ComfyUI 连接', { exact: true }).waitFor();
    await page.getByRole('button', { name: '启用云端生产', exact: true }).waitFor();
    await page.getByText('云端 SSH 连接（仙宫云等支持 SSH 的平台）', { exact: true }).click();
    await page.getByPlaceholder('云控制台提供的 SSH 密码；密钥登录时留空').waitFor();
    await page.screenshot({ path: path.join(artifacts, 'comfy-settings-smoke.png') });
    const result = { personalMode: true, comfyConnection: true, imageWorkflow: task.status, videoWorkflow: videoTask.status, resultDownloads: true, credentialForwarding: true, crossOriginBlocked: true, errors };
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(artifacts, 'smoke-result.json'), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
} finally { await app.close(); comfy.closeAllConnections(); comfy.close(); }
