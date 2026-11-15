"use client";

import { App, Button, Input, InputNumber, Tag } from "antd";
import { useEffect, useState } from "react";

import { isPersonalDesktop } from "@/lib/desktop";
import { connectComfyAgent, defaultComfyLocalSettings, listComfyTunnels, readComfyAgentConnection, readComfyLocalSettings, saveComfyLocalSettings, startComfyTunnel, stopComfyTunnel, testComfyConnection, type ComfyLocalSettings, type ComfyLocalStatus } from "@/services/api/comfy-local-agent";

type Props = { channelId: string; comfyUrl?: string; apiKey?: string; onComfyUrlChange: (url: string) => void; onApiKeyChange?: (key: string) => void };

export function ComfyUIConnectionSettings({ channelId, comfyUrl, apiKey, onComfyUrlChange, onApiKeyChange }: Props) {
    const { message } = App.useApp();
    const [settings, setSettings] = useState<ComfyLocalSettings>(defaultComfyLocalSettings);
    const [status, setStatus] = useState<ComfyLocalStatus | null>(null);
    const [busy, setBusy] = useState(false);
    const [loaded, setLoaded] = useState(false);
    const [agentEndpoint, setAgentEndpoint] = useState("http://127.0.0.1:3210");
    const [agentToken, setAgentToken] = useState("");
    const [agentBusy, setAgentBusy] = useState(false);
    const [sshPassword, setSSHPassword] = useState("");
    const [sshPassphrase, setSSHPassphrase] = useState("");

    useEffect(() => {
        let active = true;
        try { const agent = readComfyAgentConnection(); setAgentEndpoint(agent.endpoint); setAgentToken(agent.token); } catch { /* 组件首次加载时使用默认地址 */ }
        void readComfyLocalSettings(channelId).then(async (saved) => {
            if (!active) return;
            const next = { ...defaultComfyLocalSettings(), ...(saved || {}), url: saved?.url || comfyUrl || defaultComfyLocalSettings().url, apiKey: apiKey || saved?.apiKey || "" };
            try {
                const tunnels = await listComfyTunnels();
                if (!active) return;
                const tunnel = tunnels.find((item) => item.id === next.tunnelId);
                if (next.tunnelId && !tunnel) { next.tunnelId = ""; next.tunnelBaseUrl = ""; await saveComfyLocalSettings(channelId, next); }
                else if (tunnel) next.tunnelBaseUrl = tunnel.baseUrl;
            } catch { /* 本机 Agent 未连接时仍可编辑本地配置 */ }
            setSettings(next);
            if (comfyUrl !== (next.tunnelBaseUrl || next.url)) onComfyUrlChange(next.tunnelBaseUrl || next.url);
            setLoaded(true);
        }).catch(() => { if (active) setLoaded(true); });
        return () => { active = false; };
    }, [channelId]);

    const update = (patch: Partial<ComfyLocalSettings>) => {
        const next = { ...settings, ...patch };
        setSettings(next);
        if (patch.apiKey !== undefined) onApiKeyChange?.(patch.apiKey);
        void saveComfyLocalSettings(channelId, next);
        if (patch.url !== undefined && !next.tunnelId) onComfyUrlChange(next.url);
    };

    const connectAgent = async () => {
        setAgentBusy(true);
        try {
            const tunnels = await connectComfyAgent(agentEndpoint, agentToken);
            const tunnel = tunnels.find((item) => item.id === settings.tunnelId);
            if (tunnel) { const next = { ...settings, tunnelBaseUrl: tunnel.baseUrl }; setSettings(next); onComfyUrlChange(tunnel.baseUrl); }
            message.success("本机 Canvas Agent 已连接，访问凭据仅保存在本机浏览器");
        } catch (error) { message.error(error instanceof Error ? error.message : "连接本机 Agent 失败"); }
        finally { setAgentBusy(false); }
    };

    const checkConnection = async () => {
        setBusy(true);
        try {
            const result = await testComfyConnection(settings.tunnelBaseUrl || settings.url, settings.apiKey);
            setStatus(result);
            message.success("ComfyUI 连接正常，已刷新当前队列");
        } catch (error) {
            setStatus(null);
            message.error(error instanceof Error ? error.message : "ComfyUI 连接失败");
        } finally { setBusy(false); }
    };

    const connectSSH = async () => {
        setBusy(true);
        try {
            const tunnel = await startComfyTunnel(settings, sshPassword, sshPassphrase);
            setSSHPassword("");
            setSSHPassphrase("");
            const next = { ...settings, tunnelId: tunnel.id, tunnelBaseUrl: tunnel.baseUrl };
            setSettings(next);
            await saveComfyLocalSettings(channelId, next);
            onComfyUrlChange(tunnel.baseUrl);
            setStatus(null);
            message.success("SSH 隧道已启动；请测试连接以确认 ComfyUI 可访问");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "SSH 隧道启动失败");
        } finally { setBusy(false); }
    };

    const disconnectSSH = async () => {
        if (!settings.tunnelId) return;
        setBusy(true);
        try {
            await stopComfyTunnel(settings.tunnelId);
            const next = { ...settings, tunnelId: "", tunnelBaseUrl: "" };
            setSettings(next);
            await saveComfyLocalSettings(channelId, next);
            onComfyUrlChange(next.url);
            setStatus(null);
            message.success("SSH 隧道已关闭");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "关闭 SSH 隧道失败");
        } finally { setBusy(false); }
    };

    return <section className="space-y-3 rounded-lg border border-[var(--ant-color-border)] p-3">
        <div><div className="text-sm font-semibold">ComfyUI 连接</div><p className="mt-1 text-xs leading-5 text-[var(--ant-color-text-secondary)]">填写星云云端 ComfyUI 地址和 API Key 后，可直接用该服务生产图片与视频。连接信息保存在本机；生产工作流通过 ComfyUI 标准 API 提交到云端，不经过网站服务器。{isPersonalDesktop ? "Windows 个人版已自动连接本机服务。" : "请先在下方填写本机 Agent 地址与 Token。"}测试连接只检查服务状态；还需启用云端生产并选择对应工作流。</p></div>
        <div className="grid gap-3 md:grid-cols-2">
            <label className="space-y-1 text-xs"><span>ComfyUI 服务地址</span><Input value={settings.tunnelBaseUrl || settings.url} disabled={Boolean(settings.tunnelId)} placeholder="https://你的 ComfyUI 服务地址" onChange={(event) => update({ url: event.target.value.trim() })} /></label>
            <label className="space-y-1 text-xs"><span>API Key（可留空）</span><Input.Password value={settings.apiKey} placeholder="ComfyUI Cloud / 专属部署的 Bearer Key" onChange={(event) => update({ apiKey: event.target.value })} /></label>
        </div>
        <div className="flex flex-wrap items-center gap-2"><Button type="primary" loading={busy} onClick={() => void checkConnection()}>测试连接</Button><Button loading={busy} onClick={() => void checkConnection()}>刷新远端队列</Button>{settings.tunnelId ? <><Tag color="success">SSH 隧道已连接</Tag><Button danger size="small" loading={busy} onClick={() => void disconnectSSH()}>关闭隧道</Button></> : null}{status ? <span className="text-xs text-[var(--ant-color-text-secondary)]">运行中 {status.running} · 排队中 {status.pending}{status.device ? " · " + status.device : ""}</span> : null}</div>
        <details className="rounded-md bg-[var(--ant-color-fill-quaternary)] p-2">
            <summary className="cursor-pointer text-sm">本机连接服务</summary>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
                <label className="space-y-1 text-xs"><span>Canvas Agent 地址</span><Input value={agentEndpoint} onChange={(event) => setAgentEndpoint(event.target.value)} placeholder="http://127.0.0.1:3210" /></label>
                <label className="space-y-1 text-xs"><span>Agent Token</span><Input.Password value={agentToken} onChange={(event) => setAgentToken(event.target.value)} placeholder="本机 Agent 的连接 Token" /></label>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2"><Button size="small" loading={agentBusy} onClick={() => void connectAgent()}>保存并连接</Button><span className="text-xs text-[var(--ant-color-text-secondary)]">首次使用时先启动 Canvas Agent；Token 可由本机命令 canvas-agent config 查看。</span></div>
        </details>
        <details className="rounded-md bg-[var(--ant-color-fill-quaternary)] p-2">
            <summary className="cursor-pointer text-sm">云端 SSH 连接（仙宫云等支持 SSH 的平台）</summary>
            <div className="mt-3 grid gap-3 md:grid-cols-2">
                <label className="space-y-1 text-xs"><span>SSH 主机</span><Input value={settings.sshHost} placeholder="控制台提供的 SSH 地址" onChange={(event) => update({ sshHost: event.target.value })} /></label>
                <label className="space-y-1 text-xs"><span>SSH 端口</span><InputNumber className="!w-full" min={1} max={65535} value={settings.sshPort} onChange={(sshPort) => update({ sshPort: sshPort || 22 })} /></label>
                <label className="space-y-1 text-xs"><span>SSH 用户名</span><Input value={settings.sshUsername} placeholder="云平台提供的用户名" onChange={(event) => update({ sshUsername: event.target.value })} /></label>
                <label className="space-y-1 text-xs"><span>ComfyUI 远端主机与端口</span><div className="flex gap-2"><Input value={settings.remoteHost} placeholder="127.0.0.1" onChange={(event) => update({ remoteHost: event.target.value })} /><InputNumber className="!w-36" min={1} max={65535} value={settings.remotePort} onChange={(remotePort) => update({ remotePort: remotePort || 8188 })} /></div></label>
                <label className="space-y-1 text-xs"><span>SSH 密码（仅本次连接使用）</span><Input.Password autoComplete="new-password" value={sshPassword} onChange={(event) => setSSHPassword(event.target.value)} placeholder="云控制台提供的 SSH 密码；密钥登录时留空" /></label>
                <label className="space-y-1 text-xs"><span>私钥口令（加密私钥可填写）</span><Input.Password autoComplete="new-password" value={sshPassphrase} onChange={(event) => setSSHPassphrase(event.target.value)} /></label>
                <label className="space-y-1 text-xs md:col-span-2"><span>SSH 私钥文件路径（密码登录时留空）</span><Input value={settings.sshIdentityFile} placeholder="例如 C:/Users/你/.ssh/id_ed25519" onChange={(event) => update({ sshIdentityFile: event.target.value })} /></label>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-2"><Button loading={busy} disabled={Boolean(settings.tunnelId) || !settings.sshHost.trim() || !settings.sshUsername.trim()} onClick={() => void connectSSH()}>建立 SSH 隧道</Button><span className="text-xs text-[var(--ant-color-text-secondary)]">支持密码、私钥和本机 ssh-agent。密码及私钥口令只用于本次连接，不保存；首次信任主机指纹，后续指纹变化会拒绝连接。</span></div>
        </details>
        {!loaded ? <div className="text-xs text-[var(--ant-color-text-tertiary)]">正在读取本机配置…</div> : null}
    </section>;
}
