import localforage from "localforage";
import { isPersonalDesktop } from "@/lib/desktop";

export type ComfyLocalSettings = {
    bridgeId?: string;
    bridgeToken?: string;
    url: string;
    apiKey: string;
    sshHost: string;
    sshPort: number;
    sshUsername: string;
    sshIdentityFile: string;
    remoteHost: string;
    remotePort: number;
    tunnelId: string;
    tunnelBaseUrl: string;
};

export type ComfyLocalStatus = { online: boolean; running: number; pending: number; device: string };
export type ComfyTunnel = { id: string; host: string; user: string; localPort: number; remoteHost: string; remotePort: number; baseUrl: string };

const storage = localforage.createInstance({ name: "infinite-canvas", storeName: "comfy_local_connections" });
const key = (channelId: string) => encodeURIComponent(channelId);
export const defaultComfyLocalSettings = (): ComfyLocalSettings => ({ url: "http://127.0.0.1:8188", apiKey: "", sshHost: "", sshPort: 22, sshUsername: "", sshIdentityFile: "", remoteHost: "127.0.0.1", remotePort: 8188, tunnelId: "", tunnelBaseUrl: "" });
export const readComfyLocalSettings = (channelId: string) => storage.getItem<ComfyLocalSettings>(key(channelId));
export const saveComfyLocalSettings = (channelId: string, settings: ComfyLocalSettings) => storage.setItem(key(channelId), settings);

type AgentConnection = { endpoint: string; token: string };
const agentUrl = (endpoint: string, path: string) => isPersonalDesktop ? "/desktop/agent" + path : endpoint + path;
export function readComfyAgentConnection(): AgentConnection {
    let value: AgentConnection | null = null;
    try { value = JSON.parse(localStorage.getItem("canvas-codex-connection") || "null") as AgentConnection | null; } catch { /* 由用户重新录入本机连接 */ }
    if (!value?.endpoint) return { endpoint: "http://127.0.0.1:3210", token: "" };
    const endpoint = new URL(value.endpoint);
    if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(endpoint.hostname)) throw new Error("本地 Agent 地址必须是 127.0.0.1 或 localhost");
    return { endpoint: endpoint.origin, token: value.token };
}

export function saveComfyAgentConnection(endpoint: string, token: string) {
    localStorage.setItem("canvas-codex-connection", JSON.stringify({ endpoint: endpoint.trim(), token: token.trim() }));
}

export async function connectComfyAgent(endpointText: string, tokenText: string) {
    let endpoint: URL;
    try { endpoint = new URL(endpointText.trim()); } catch { throw new Error("本机 Agent 地址格式无效"); }
    if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(endpoint.hostname) || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) throw new Error("本机 Agent 地址须为 http://127.0.0.1:端口");
    const token = tokenText.trim();
    if (token.length < 32) throw new Error("Agent Token 至少需要 32 位");
    let response: Response;
    try { response = await fetch(agentUrl(endpoint.origin, "/comfy/tunnels"), { headers: { "x-canvas-agent-token": token }, signal: AbortSignal.timeout(5_000) }); }
    catch { throw new Error("无法访问本机 Agent；请先启动服务，并允许浏览器访问本机网络"); }
    if (response.status === 401) throw new Error("Agent Token 不正确");
    if (!response.ok) throw new Error("本机 Agent 连接失败");
    saveComfyAgentConnection(endpoint.origin, token);
    return await response.json() as ComfyTunnel[];
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
    const connection = readComfyAgentConnection();
    if (!connection.token) throw new Error("请填写正在运行的 Canvas Agent 地址和连接 Token");
    let response: Response;
    try {
        response = await fetch(agentUrl(connection.endpoint, path), { ...init, headers: { "content-type": "application/json", "x-canvas-agent-token": connection.token, ...init?.headers }, signal: AbortSignal.timeout(15_000) });
    } catch { throw new Error("无法连接本机 Canvas Agent；请确认 Agent 正在运行并已允许当前画布"); }
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "本机 ComfyUI 请求失败");
    return result as T;
}

export const testComfyConnection = (url: string, apiKey: string) => request<ComfyLocalStatus>("/comfy/status", { method: "POST", body: JSON.stringify({ url, apiKey }) });
export const startComfyTunnel = (settings: ComfyLocalSettings, password = "", passphrase = "") => request<ComfyTunnel>("/comfy/tunnels", { method: "POST", body: JSON.stringify({ host: settings.sshHost, port: settings.sshPort, username: settings.sshUsername, identityFile: settings.sshIdentityFile, password, passphrase, remoteHost: settings.remoteHost, remotePort: settings.remotePort }) });
export const stopComfyTunnel = (id: string) => request<{ stopped: boolean }>("/comfy/tunnels/" + encodeURIComponent(id), { method: "DELETE" });
export const listComfyTunnels = () => request<ComfyTunnel[]>("/comfy/tunnels");
