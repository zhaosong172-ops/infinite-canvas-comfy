#!/usr/bin/env node
import express from "express";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { openComfyTunnel } from "./comfy-ssh.mjs";
import { dirname, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes, randomUUID } from "node:crypto";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { CodexClient } from "./codex.mjs";

const entry = fileURLToPath(import.meta.url);
const configPath = process.env.CANVAS_AGENT_CONFIG || resolve(homedir(), ".infinite-canvas", "codex-agent.json");
const readConfig = () => existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : null;
const savedConfig = readConfig();
const serviceId = savedConfig?.serviceId || randomUUID();
const mode = process.argv[2];
if (!savedConfig && ["config", "open"].includes(mode)) throw new Error("请先启动本地 Canvas Agent 服务");
const token = process.env.CANVAS_AGENT_TOKEN || savedConfig?.token || (mode === "mcp" ? "" : randomBytes(32).toString("hex"));
if (mode !== "mcp" && (typeof token !== "string" || token.length < 32)) throw new Error("本地连接 Token 至少需要 32 位字符");
const port = Number(process.env.CANVAS_AGENT_PORT || savedConfig?.port || 3210);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("本地服务端口无效");
const endpoint = "http://127.0.0.1:" + port;
const workspace = dirname(entry);
const origins = new Set(process.env.CANVAS_AGENT_ORIGINS?.split(",").map((value) => value.trim()).filter(Boolean) || savedConfig?.origins || []);
const sessions = new Map();
const comfyTunnels = new Map();
const methods = new Set(["model/list", "thread/start", "thread/resume", "thread/archive", "turn/start", "turn/interrupt", "bridge/stop"]);

async function openCanvas() {
    const target = URL.canParse(process.argv[3] || "") ? new URL(process.argv[3]) : null;
    if (!target || !["http:", "https:"].includes(target.protocol) || target.username || target.password || !/^\/canvas\/[^/]+\/?$/.test(target.pathname)) throw new Error("请提供实际画布的 HTTP(S) 地址");
    const browser = process.argv[4];
    if (!["chrome", "edge", "firefox", "brave", "default"].includes(browser)) throw new Error("请指定原画布浏览器：chrome、edge、firefox、brave 或 default");
    const params = new URLSearchParams(target.hash.slice(1));
    params.set("agentUrl", endpoint);
    params.set("agentToken", token);
    target.hash = params.toString();
    const { default: open, apps } = await import("open");
    try {
        await open(target.href, { app: { name: browser === "default" ? apps.browser : apps[browser], arguments: process.argv.slice(5) } });
    } catch (error) {
        throw new Error("打开浏览器失败，请检查原浏览器、配置和启动权限" + (error.code ? "：" + error.code : ""));
    }
    console.log("已请求浏览器打开原画布，等待 MCP 确认连接");
}

function saveConfig() {
    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify({ url: endpoint, port, token, serviceId, origins: [...origins] }, null, 2) + "\n", { mode: 0o600 });
}

function findSession(clientId) {
    if (!clientId) {
        const connected = [...sessions.values()].filter((session) => session.events && session.canvasId);
        if (connected.length !== 1) throw new Error("请只连接一个画布，或为 MCP 设置 CANVAS_AGENT_CLIENT_ID");
        return connected[0];
    }
    const session = sessions.get(clientId);
    if (!session) throw new Error("画布尚未连接");
    return session;
}

function emit(session, event, data) {
    session.events?.write("event: " + event + "\ndata: " + JSON.stringify(data) + "\n\n");
}

function closeSession(session) {
    if (sessions.get(session.clientId) === session) sessions.delete(session.clientId);
    for (const pending of session.toolsPending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("画布已断开，工具未完成"));
    }
    session.toolsPending.clear();
    const events = session.events;
    session.events = undefined;
    session.codex?.close();
    events?.end();
}

function callTool(session, name, args, source, generation, res) {
    if (!session.events || !session.tools.some((tool) => tool.name === name)) throw new Error("画布未连接或工具不存在");
    if (source === "codex" && (generation !== session.codexGeneration || !session.codex || session.codex.stopped)) throw new Error("Codex 请求已停止");
    if (res.destroyed) throw new Error("画布工具请求已取消");
    const requestId = randomUUID();
    const cancel = (message) => {
        const pending = session.toolsPending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        session.toolsPending.delete(requestId);
        emit(session, "tool-cancel", { requestId });
        pending.reject(new Error(message));
    };
    const onClose = () => { if (!res.writableEnded) cancel("画布工具请求已取消"); };
    res.once("close", onClose);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => cancel("画布工具执行超时"), 90000);
        session.toolsPending.set(requestId, { resolve, reject, timer, source, cancel });
        emit(session, "tool", { requestId, name, arguments: args, source, generation });
    }).finally(() => res.off("close", onClose));
}

async function runRpc(session, method, params = {}, generation) {
    if (!methods.has(method)) throw new Error("不支持的 Codex 方法");
    if (!session.events || !session.canvasId) throw new Error("请先连接画布并注册工具");
    if (!Number.isSafeInteger(generation) || generation < session.codexGeneration) throw new Error("Codex 请求已停止");
    if (generation > session.codexGeneration) {
        session.codexGeneration = generation;
        session.codex?.close();
    }
    if (method === "bridge/stop") return { ok: true };
    if (!session.codex || session.codex.stopped) session.codex = new CodexClient((event, data) => {
        if (data.method === "bridge/disconnected") {
            if (generation === session.codexGeneration) session.codexGeneration += 1;
            for (const pending of session.toolsPending.values()) if (pending.source === "codex") pending.cancel("Codex 请求已停止");
        }
        emit(session, event, { ...data, generation });
    });
    const codex = session.codex;
    await codex.ready;
    if (method === "thread/start" || method === "thread/resume") {
        params = {
            ...params,
            cwd: workspace,
            approvalPolicy: "on-request",
            sandbox: "workspace-write",
            config: { mcp_servers: { "infinite-canvas": {
                command: process.execPath,
                args: [entry, "mcp"],
                default_tools_approval_mode: "approve",
                env: { CANVAS_AGENT_TOKEN: token, CANVAS_AGENT_PORT: String(port), CANVAS_AGENT_CLIENT_ID: session.clientId, CANVAS_AGENT_SOURCE: "codex", CANVAS_AGENT_CODEX_GENERATION: String(generation) },
                startup_timeout_sec: 20,
                tool_timeout_sec: 90,
            } } },
        };
    }
    if (method === "turn/start") {
        params = { ...params, approvalPolicy: "on-request", sandboxPolicy: { type: "workspaceWrite", networkAccess: false } };
    }
    return codex.request(method, params);
}

async function startMcp() {
    const clientId = process.env.CANVAS_AGENT_CLIENT_ID || "";
    const source = process.env.CANVAS_AGENT_SOURCE === "codex" ? "codex" : "external";
    const generation = Number(process.env.CANVAS_AGENT_CODEX_GENERATION || 0);
    async function request(path, body, signal) {
        const config = readConfig();
        const requestToken = process.env.CANVAS_AGENT_TOKEN || config?.token;
        if (!requestToken) throw new Error("请先启动本地 Canvas Agent 服务");
        const url = "http://127.0.0.1:" + (process.env.CANVAS_AGENT_PORT || config?.port || 3210);
        const response = await fetch(url + path, {
            method: body ? "POST" : "GET",
            headers: { "Content-Type": "application/json", "x-canvas-agent-token": requestToken },
            body: body ? JSON.stringify({ ...body, clientId, source, generation }) : undefined,
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(95000)]) : AbortSignal.timeout(95000),
        });
        const value = await response.json();
        if (!response.ok) throw new Error(value.error || "画布连接失败");
        return value;
    }
    const server = new Server({ name: "infinite-canvas", version: "0.1.0" }, { capabilities: { tools: { listChanged: true } } });
    const toolsPath = "/tools?clientId=" + encodeURIComponent(clientId);
    server.setRequestHandler(ListToolsRequestSchema, async () => {
        try {
            const tools = await request(toolsPath);
            return { tools: source === "codex" ? tools : tools.filter(({ name }) => name !== "set_agent_state" && name !== "read_skill_file") };
        } catch { return { tools: [] }; }
    });
    server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
        try {
            const result = await request("/tools/call", { name: params.name, arguments: params.arguments || {} }, signal);
            return { isError: result?.ok === false, content: [{ type: "text", text: JSON.stringify(result) }] };
        } catch (error) {
            return { isError: true, content: [{ type: "text", text: error.message }] };
        }
    });
    let retry;
    let closed = false;
    async function announceTools() {
        try {
            const tools = await request(toolsPath);
            if (!tools.length) throw new Error("等待画布连接");
            if (!closed) await server.notification({ method: "notifications/tools/list_changed" });
        } catch {
            if (!closed) retry = setTimeout(announceTools, 2000);
        }
    }
    server.oninitialized = () => { void announceTools(); };
    server.onclose = () => { closed = true; clearTimeout(retry); };
    await server.connect(new StdioServerTransport());
}


function normalizeComfyUrl(value) {
    let url;
    try { url = new URL(String(value || "")); } catch { throw new Error("ComfyUI 服务地址无效"); }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("ComfyUI 地址必须是有效的 HTTP(S) 地址");
    return url.href.replace(/\/+$/, "");
}

async function readComfyJson(baseUrl, route, apiKey) {
    const response = await fetch(baseUrl + route, {
        headers: { Accept: "application/json", ...(apiKey ? { Authorization: "Bearer " + apiKey } : {}) },
        redirect: "error",
        signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) throw new Error("ComfyUI 请求失败（HTTP " + response.status + "）");
    try { return await response.json(); } catch { throw new Error("ComfyUI 返回了无效 JSON"); }
}

function validPort(value, fallback, label) {
    const port = value === undefined || value === "" ? fallback : Number(value);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(label + "端口无效");
    return port;
}

function listComfyTunnels() {
    return [...comfyTunnels.values()].map(({ id, host, user, localPort, remoteHost, remotePort }) => ({ id, host, user, localPort, remoteHost, remotePort, baseUrl: "http://127.0.0.1:" + localPort }));
}

function startHttp() {
    const app = express();
    app.use((req, res, next) => {
        if (!["127.0.0.1:" + port, "localhost:" + port].includes(req.headers.host)) return res.status(403).json({ error: "无效的本地地址" });
        const origin = req.headers.origin;
        if (origin) {
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Vary", "Origin");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-canvas-agent-token");
            res.setHeader("Access-Control-Expose-Headers", "x-canvas-agent-generation");
            res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
            res.setHeader("Access-Control-Allow-Private-Network", "true");
        }
        if (req.method === "OPTIONS") return res.sendStatus(204);
        if (req.method === "GET" && req.path === "/config") return res.json({ url: endpoint, hasToken: Boolean(token) });
        const credential = req.path === "/events" ? req.query.token : req.headers["x-canvas-agent-token"];
        if (credential !== token) return res.status(401).json({ error: "Token 不正确" });
        if (origin && !origins.has(origin)) {
            origins.add(origin);
            saveConfig();
        }
        next();
    });
    app.use(express.json({ limit: "20mb" }));
    app.post("/shutdown", (req, res) => {
        res.json({ ok: true });
        shutdown();
    });
    app.post("/comfy/status", async (req, res) => {
        let baseUrl;
        try { baseUrl = normalizeComfyUrl(req.body?.url); } catch (error) { return res.status(400).json({ error: error.message }); }
        const apiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
        try {
            const [stats, queue] = await Promise.all([
                readComfyJson(baseUrl, "/system_stats", apiKey),
                readComfyJson(baseUrl, "/queue", apiKey),
            ]);
            const running = Array.isArray(queue.queue_running) ? queue.queue_running : [];
            const pending = Array.isArray(queue.queue_pending) ? queue.queue_pending : [];
            res.json({ online: true, running: running.length, pending: pending.length, device: stats.system?.device_name || "" });
        } catch (error) {
            res.status(502).json({ error: error instanceof Error ? error.message : "无法连接 ComfyUI" });
        }
    });
    app.get("/comfy/tunnels", (_req, res) => res.json(listComfyTunnels()));
    app.post("/comfy/tunnels", async (req, res) => {
        const { host, username, identityFile, remoteHost = "127.0.0.1" } = req.body || {};
        let port, remotePort;
        try {
            port = validPort(req.body?.port, 22, "SSH ");
            remotePort = validPort(req.body?.remotePort, 8188, "ComfyUI ");
        } catch (error) { return res.status(400).json({ error: error.message }); }
        const user = String(username || "").trim();
        const sshHost = String(host || "").trim();
        const targetHost = String(remoteHost || "").trim();
        if (!/^[A-Za-z_][A-Za-z0-9._-]{0,63}$/.test(user)) return res.status(400).json({ error: "SSH 用户名格式无效" });
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/.test(sshHost)) return res.status(400).json({ error: "SSH 主机地址格式无效" });
        if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,252}$/.test(targetHost)) return res.status(400).json({ error: "远端 ComfyUI 主机格式无效" });
        let keyPath = "";
        if (identityFile) {
            keyPath = String(identityFile).trim();
            if (keyPath.startsWith("-") || !existsSync(keyPath)) return res.status(400).json({ error: "SSH 私钥文件不存在或路径无效" });
        }
        try {
            const id = randomUUID();
            const tunnel = await openComfyTunnel({ host: sshHost, port, username: user, identityFile: keyPath, remoteHost: targetHost, remotePort, password: typeof req.body.password === "string" ? req.body.password : "", passphrase: typeof req.body.passphrase === "string" ? req.body.passphrase : "" }, resolve(dirname(configPath), "comfy-known-hosts.json"));
            comfyTunnels.set(id, { id, host: sshHost, user, localPort: tunnel.localPort, remoteHost: targetHost, remotePort, close: tunnel.close });
            tunnel.onClose(() => comfyTunnels.delete(id));
            res.json({ id, localPort: tunnel.localPort, baseUrl: "http://127.0.0.1:" + tunnel.localPort, fingerprint: tunnel.fingerprint });
        } catch (error) {
            res.status(502).json({ error: error instanceof Error ? error.message : "无法启动 SSH 隧道" });
        }
    });
    app.delete("/comfy/tunnels/:id", (req, res) => {
        const tunnel = comfyTunnels.get(req.params.id);
        if (!tunnel) return res.json({ stopped: false });
        tunnel.close();
        comfyTunnels.delete(tunnel.id);
        res.json({ stopped: true });
    });
    app.post("/connect", (req, res) => {
        const { clientId, canvasId, tools } = req.body;
        if (typeof clientId !== "string" || !clientId || typeof canvasId !== "string" || !canvasId || !Array.isArray(tools)) {
            return res.status(400).json({ error: "连接参数不完整" });
        }
        const session = findSession(clientId);
        if ((session.canvasId && session.canvasId !== canvasId) || session.origin !== req.headers.origin) {
            return res.status(409).json({ error: "连接标识已被其他画布使用" });
        }
        session.canvasId = canvasId;
        session.tools = tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }));
        res.json({ serviceId });
    });
    app.get("/events", (req, res) => {
        const clientId = req.query.clientId;
        if (typeof clientId !== "string" || !clientId) return res.status(400).json({ error: "缺少连接标识" });
        let session = sessions.get(clientId);
        if (!session) {
            session = { clientId, origin: req.headers.origin, tools: [], toolsPending: new Map(), codexGeneration: 0 };
            sessions.set(clientId, session);
        }
        if (session.origin !== req.headers.origin) return res.status(403).json({ error: "连接来源不匹配" });
        const previous = session.events;
        session.events = res;
        previous?.end();
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-cache");
        res.setHeader("Connection", "keep-alive");
        res.flushHeaders();
        res.write(": connected\n\n");
        const heartbeat = setInterval(() => res.write(": ping\n\n"), 15000);
        res.on("close", () => {
            clearInterval(heartbeat);
            if (session.events === res) closeSession(session);
        });
    });
    app.post("/rpc", async (req, res) => {
        const { clientId, method, params, generation } = req.body;
        const session = findSession(clientId);
        res.json(await runRpc(session, method, params, generation).finally(() => res.setHeader("x-canvas-agent-generation", String(session.codexGeneration))));
    });
    app.post("/reply", (req, res) => {
        const { clientId, id, result, error, generation } = req.body;
        const session = findSession(clientId);
        if (generation === session.codexGeneration) session.codex?.reply(id, result, error);
        res.json({ ok: true });
    });
    app.post("/result", (req, res) => {
        const { clientId, requestId, result, error } = req.body;
        const session = findSession(clientId);
        const pending = session.toolsPending.get(requestId);
        if (!pending) return res.status(409).json({ error: "工具请求已结束" });
        clearTimeout(pending.timer);
        session.toolsPending.delete(requestId);
        if (error) pending.reject(new Error(error));
        else pending.resolve(result);
        res.json({ ok: true });
    });
    app.get("/tools", (req, res) => {
        const session = findSession(req.query.clientId);
        if (!session.canvasId) throw new Error("请先在网页连接画布");
        res.json(session.tools);
    });
    app.post("/tools/call", async (req, res) => {
        const { clientId, name, arguments: args, source, generation } = req.body;
        res.json(await callTool(findSession(clientId), name, args, source === "codex" ? "codex" : "external", generation, res));
    });
    app.use((error, req, res, next) => {
        if (res.destroyed) return;
        if (res.headersSent) return next(error);
        res.status(400).json({ error: error.message });
    });
    const server = app.listen(port, "127.0.0.1", () => {
        saveConfig();
        console.log("Local URL: " + endpoint);
        console.log("Connect token: " + token);
    });
    server.on("error", (error) => {
        console.error("Canvas Agent 启动失败：" + error.message);
        process.exitCode = 1;
    });
    function shutdown() {
        for (const session of sessions.values()) closeSession(session);
        for (const tunnel of comfyTunnels.values()) tunnel.close();
        comfyTunnels.clear();
        server.close();
    }
    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
}

if (mode === "config") console.log(JSON.stringify({ url: endpoint, token, origins: [...origins] }));
else if (mode === "open") await openCanvas();
else if (mode === "mcp") await startMcp();
else startHttp();
