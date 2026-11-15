const { app, BrowserWindow, dialog, shell } = require('electron');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');

if (process.env.CANVAS_DESKTOP_TEST_DATA) app.setPath('userData', path.resolve(process.env.CANVAS_DESKTOP_TEST_DATA));
else app.setPath('userData', path.join(app.getPath('appData'), 'InfiniteCanvasPersonal'));

const children = new Set();
let gateway, bridge, window, quitting = false;
let ports, origin, runtime, dataDir, log, agentToken;
const secret = randomBytes(32).toString('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

function start(file, args, env, cwd, quiet = false) {
    const child = spawn(file, args, { cwd, env: { ...process.env, ...env }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    child.stdout.on('data', chunk => { if (!quiet) log.write(chunk); });
    child.stderr.on('data', chunk => log.write(chunk.toString().replaceAll(secret, '[redacted]').replaceAll(agentToken || secret, '[redacted]')));
    child.on('error', error => log.write(error.message + '\n'));
    child.on('exit', code => { children.delete(child); if (bridge === child) bridge = null; log.write(path.basename(file) + ' exited: ' + code + '\n'); });
    return child;
}
async function freePort(preferred = 0) {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', error => preferred && error.code === 'EADDRINUSE' ? freePort().then(resolve, reject) : reject(error));
        server.listen(preferred, '127.0.0.1', () => { const port = server.address().port; server.close(() => resolve(port)); });
    });
}
async function waitFor(url, child, headers = {}) {
    for (let i = 0; i < 120; i++) {
        if (child.exitCode !== null) throw new Error('本机服务启动失败（' + path.basename(child.spawnargs[1] || child.spawnfile) + '），请查看日志');
        try { const response = await fetch(url, { headers, signal: AbortSignal.timeout(1500) }); if (response.ok) return; } catch {}
        await delay(500);
    }
    throw new Error('本机服务启动超时，请查看日志');
}
function json(res, code, value) { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(value)); }
async function body(req) {
    const chunks = []; let size = 0;
    for await (const chunk of req) { size += chunk.length; if (size > 1024 * 1024) throw new Error('配置过大'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
}
function proxy(req, res, target, external = false) {
    const headers = { ...req.headers, host: target.host };
    delete headers['x-personal-secret'];
    if (external) {
        for (const name of Object.keys(headers)) if (['cookie', 'origin', 'referer', 'connection'].includes(name) || name.startsWith('sec-')) delete headers[name];
    }
    const upstream = (target.protocol === 'https:' ? https : http).request(target, { method: req.method, headers }, response => {
        const resultHeaders = { ...response.headers };
        if (external) {
            delete resultHeaders['set-cookie'];
            if (resultHeaders.location) {
                const redirect = new URL(resultHeaders.location, target);
                if (!['http:', 'https:'].includes(redirect.protocol) || redirect.username || redirect.password) { upstream.destroy(); return json(res, 502, { error: '接口重定向地址无效' }); }
                if (redirect.origin !== target.origin && headers.authorization) { upstream.destroy(); return json(res, 502, { error: '为保护密钥，已阻止跨站重定向，请填写最终 API 地址' }); }
                resultHeaders.location = '/desktop/request?url=' + encodeURIComponent(redirect.href);
            }
        }
        res.writeHead(response.statusCode, resultHeaders);
        response.pipe(res);
    });
    upstream.on('error', () => { if (!res.headersSent) json(res, 502, { error: '无法连接服务，请检查接口地址与网络' }); else res.destroy(); });
    res.on('close', () => { if (!res.writableEnded) upstream.destroy(); });
    req.pipe(upstream);
}
async function stopBridge() {
    if (!bridge) return;
    const child = bridge; bridge = null;
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill();
    await Promise.race([exited, delay(3000)]);
}
async function route(req, res) {
    try {
        if (req.headers.host !== new URL(origin).host || req.headers.origin && req.headers.origin !== origin || req.headers['sec-fetch-site'] === 'cross-site') return json(res, 403, { error: '仅允许本机画布访问' });
        const url = new URL(req.url, origin);
        if (url.pathname === '/desktop/session' && req.method === 'GET') {
            const response = await fetch('http://127.0.0.1:' + ports.api + '/api/auth/personal', { method: 'POST', headers: { 'X-Personal-Secret': secret } });
            const session = await response.json();
            return json(res, response.status, { ...session, agent: { endpoint: 'http://127.0.0.1:' + ports.agent, token: agentToken } });
        }
        if (url.pathname === '/desktop/bridge' && req.method === 'POST') {
            const options = await body(req);
            const comfy = new URL(options.comfyUrl);
            if (!['http:', 'https:'].includes(comfy.protocol) || comfy.username || comfy.password || comfy.search || comfy.hash || typeof options.token !== 'string' || options.token.length < 20) throw new Error('ComfyUI 连接参数无效');
            await stopBridge();
            const workflowDir = path.resolve(options.workflowDir || path.join(dataDir, 'workflows'));
            fs.mkdirSync(workflowDir, { recursive: true });
            const outputPort = await freePort(8189);
            bridge = start(path.join(runtime, 'InfiniteCanvas-ComfyBridge.exe'), ['--server', origin, '--token', options.token, '--comfy', comfy.href.replace(/\/$/, ''), '--workflow-dir', workflowDir, '--output-port', String(outputPort)], { COMFY_API_KEY: String(options.apiKey || ''), COMFY_BRIDGE_CONFIG_DIR: path.join(dataDir, 'bridge-state') }, dataDir);
            // The bridge also serves output media. Wait for its startup, not just spawn().
            await delay(1400);
            if (!bridge || bridge.exitCode !== null) throw new Error('Bridge 启动失败，请检查本机结果端口与云端连接配置');
            return json(res, 200, { started: true });
        }
        if (url.pathname === '/desktop/bridge' && req.method === 'DELETE') { await stopBridge(); return json(res, 200, { stopped: true }); }
        if (url.pathname.startsWith('/desktop/agent/')) {
            const agentPath = url.pathname.slice('/desktop/agent'.length);
            const allowed = agentPath === '/comfy/status' && req.method === 'POST'
                || agentPath === '/comfy/tunnels' && ['GET', 'POST'].includes(req.method)
                || /^\/comfy\/tunnels\/[A-Za-z0-9_-]+$/.test(agentPath) && req.method === 'DELETE';
            if (!allowed) return json(res, 404, { error: '功能不存在' });
            return proxy(req, res, new URL(agentPath + url.search, 'http://127.0.0.1:' + ports.agent));
        }
        if (url.pathname === '/desktop/request') {
            const target = new URL(url.searchParams.get('url'));
            if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password || target.hash || ['127.0.0.1', 'localhost', '[::1]'].includes(target.hostname) && [String(ports.ui), String(ports.api), String(ports.web)].includes(target.port)) throw new Error('接口地址无效');
            return proxy(req, res, target, true);
        }
        if (url.pathname.startsWith('/desktop/')) return json(res, 404, { error: '功能不存在' });
        if (url.pathname.startsWith('/api/auth/') && !url.pathname.endsWith('/me')) return json(res, 403, { code: 1, msg: '个人版无需登录' });
        return proxy(req, res, new URL(req.url, 'http://127.0.0.1:' + (url.pathname.startsWith('/api/') ? ports.api : ports.web)));
    } catch (error) { if (!res.headersSent) json(res, 400, { error: error.message }); }
}
async function boot() {
    dataDir = app.getPath('userData');
    fs.mkdirSync(dataDir, { recursive: true });
    log = fs.createWriteStream(path.join(dataDir, 'desktop.log'), { flags: 'a' });
    log.write('\nStarting personal canvas ' + new Date().toISOString() + '\n');
    runtime = app.isPackaged ? path.join(process.resourcesPath, 'app-runtime') : path.join(__dirname, 'payload');
    ports = { ui: await freePort(17860), api: await freePort(), web: await freePort(), agent: await freePort() };
    origin = 'http://127.0.0.1:' + ports.ui;
    // A fixed browser origin keeps IndexedDB and API settings across restarts.
    const preferred = path.join(dataDir, 'ui-port.json');
    if (fs.existsSync(preferred)) {
        const previous = JSON.parse(fs.readFileSync(preferred, 'utf8')).port;
        if (previous !== ports.ui) {
            const chosen = await freePort(previous);
            if (chosen !== previous) throw new Error('画布保存数据使用的端口被占用，请关闭旧版画布后重试');
            ports.ui = chosen; origin = 'http://127.0.0.1:' + chosen;
        }
    }
    fs.writeFileSync(preferred, JSON.stringify({ port: ports.ui }));
    gateway = http.createServer((req, res) => void route(req, res));
    await new Promise((resolve, reject) => { gateway.once('error', reject); gateway.listen(ports.ui, '127.0.0.1', resolve); });
    const backend = start(path.join(runtime, 'canvas-server.exe'), [], { PORT: String(ports.api), LISTEN_HOST: '127.0.0.1', PERSONAL_SECRET: secret, JWT_SECRET: secret, ADMIN_USERNAME: '', ADMIN_PASSWORD: '', STORAGE_DRIVER: 'sqlite', DATABASE_DSN: path.join(dataDir, 'data', 'canvas.db'), AI_LOG_DIR: path.join(dataDir, 'data', 'logs'), GIN_MODE: 'release' }, dataDir);
    const web = start(process.execPath, [path.join(runtime, 'web', 'server.js')], { ELECTRON_RUN_AS_NODE: '1', PORT: String(ports.web), HOSTNAME: '127.0.0.1', API_BASE_URL: 'http://127.0.0.1:' + ports.api, NODE_ENV: 'production' }, path.join(runtime, 'web'));
    agentToken = randomBytes(32).toString('hex');
    const agent = start(process.execPath, [path.join(runtime, 'agent', 'index.mjs')], { ELECTRON_RUN_AS_NODE: '1', CANVAS_AGENT_PORT: String(ports.agent), CANVAS_AGENT_TOKEN: agentToken, CANVAS_AGENT_ORIGINS: origin, CANVAS_AGENT_CONFIG: path.join(dataDir, 'agent.json') }, dataDir, true);
    await Promise.all([waitFor('http://127.0.0.1:' + ports.api + '/api/health', backend), waitFor('http://127.0.0.1:' + ports.web, web), waitFor('http://127.0.0.1:' + ports.agent + '/comfy/tunnels', agent, { 'x-canvas-agent-token': agentToken })]);
    window = new BrowserWindow({ width: 1440, height: 960, minWidth: 1000, minHeight: 700, title: '个人无限画布', autoHideMenuBar: true, webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true } });
    window.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) void shell.openExternal(url); return { action: 'deny' }; });
    window.webContents.on('will-navigate', (event, url) => { if (new URL(url).origin !== origin) { event.preventDefault(); if (/^https?:/.test(url)) void shell.openExternal(url); } });
    await window.loadURL(origin);
}
async function shutdown() {
    await stopBridge();
    if (ports) {
        try { await fetch('http://127.0.0.1:' + ports.agent + '/shutdown', { method: 'POST', headers: { 'x-canvas-agent-token': agentToken }, signal: AbortSignal.timeout(2000) }); } catch {}
    }
    for (const child of children) child.kill();
    gateway?.close();
    log?.end();
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
    app.on('second-instance', () => { if (window) { if (window.isMinimized()) window.restore(); window.focus(); } });
    app.whenReady().then(boot).catch(async error => { log?.write('Startup failed: ' + error.message + '\n'); await shutdown(); dialog.showErrorBox('个人画布启动失败', error.message + '\n日志位置：' + path.join(app.getPath('userData'), 'desktop.log')); app.exit(1); });
    app.on('window-all-closed', () => app.quit());
    app.on('before-quit', event => { if (quitting) return; event.preventDefault(); quitting = true; void shutdown().finally(() => app.exit()); });
}
