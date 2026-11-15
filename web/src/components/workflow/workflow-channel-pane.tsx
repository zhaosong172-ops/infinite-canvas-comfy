"use client";

import { App, AutoComplete, Button, Form, Input, Popconfirm, Segmented, Select, Switch, Tag } from "antd";
import { useEffect, useRef, useState } from "react";

import { isPersonalDesktop } from "@/lib/desktop";
import { defaultComfyLocalSettings, readComfyLocalSettings, saveComfyLocalSettings, testComfyConnection } from "@/services/api/comfy-local-agent";
import { ComfyUIConnectionSettings } from "@/components/workflow/comfyui-connection-settings";
import { WorkflowFieldMappingEditor } from "@/components/workflow/workflow-field-mapping-editor";
import { WorkflowGraphEditor } from "@/components/workflow/workflow-graph-editor";
import { WorkflowTestWorkbench } from "@/components/workflow/workflow-test-workbench";
import { parseComfyWorkflowJSON } from "@/lib/comfy-workflow-json";
import { mergeWorkflowFieldMappings, normalizeWorkflowFieldMappings, type WorkflowCapability, type WorkflowEntry, type WorkflowKind } from "@/lib/workflow-channel";
import { createComfyBridge, deleteComfyBridge, inspectComfyBridge, listComfyBridges, type ComfyBridgeSummary } from "@/services/api/comfy-bridge";
import { inspectRunningHub, searchRunningHubTemplates, type RunningHubTemplate } from "@/services/api/runninghub";
import type { AdminModelChannel } from "@/services/api/admin";
import styles from "./workflow-channel-pane.module.css";

export type WorkflowChannelSettings = {
    id: string;
    protocol: "runninghub" | "comfyui";
    baseUrl: string;
    apiKey: string;
    uploadApiKey?: string;
    bridgeId?: string;
    comfyUrl?: string;
    workflowDir?: string;
};

type Props = {
    channel: WorkflowChannelSettings;
    workflows: WorkflowEntry[];
    token: string;
    admin?: { index?: number; channel: AdminModelChannel };
    onChannelChange: (patch: Partial<WorkflowChannelSettings>) => void;
    onBridgeDeleted: (bridgeId: string) => void;
    onWorkflowsChange: (workflows: WorkflowEntry[]) => void;
    onBeforeTest: () => Promise<string>;
};

const capabilityOptions = [
    { label: "图片", value: "image" },
    { label: "视频", value: "video" },
    { label: "音频", value: "audio" },
];
const entryKey = (item: WorkflowEntry) => `${item.kind}:${item.workflowId}`;

export function WorkflowChannelPane({ channel, workflows, token, admin, onChannelChange, onBridgeDeleted, onWorkflowsChange, onBeforeTest }: Props) {
    const { message } = App.useApp();
    const [selectedKey, setSelectedKey] = useState("");
    const [kind, setKind] = useState<WorkflowKind>("workflow");
    const [workflowId, setWorkflowId] = useState("");
    const [title, setTitle] = useState("");
    const [capability, setCapability] = useState<WorkflowCapability>("image");
    const [jsonText, setJsonText] = useState("");
    const [mode, setMode] = useState<"fields" | "test">("fields");
    const [busy, setBusy] = useState(false);
    const [bridges, setBridges] = useState<ComfyBridgeSummary[]>([]);
    const [bridgeName, setBridgeName] = useState("");
    const [newToken, setNewToken] = useState("");
    const [newTokenBridgeId, setNewTokenBridgeId] = useState("");
    const [runningHubSearch, setRunningHubSearch] = useState("");
    const [runningHubTemplates, setRunningHubTemplates] = useState<RunningHubTemplate[]>([]);
    const [searchingRunningHub, setSearchingRunningHub] = useState(false);
    const activeRef = useRef(true);
    const selected = workflows.find((item) => entryKey(item) === selectedKey);
    const bridge = bridges.find((item) => item.id === channel.bridgeId);

    const searchRunningHub = async () => {
        if (!token) return message.warning("请先登录应用个人会话");
        setSearchingRunningHub(true);
        try {
            const items = await searchRunningHubTemplates(token, { baseUrl: channel.baseUrl, search: runningHubSearch, page: 1 }, admin);
            setRunningHubTemplates(items);
            if (!items.length) message.info("目录中没有匹配的工作流");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "搜索 RunningHub 工作流失败");
        } finally {
            setSearchingRunningHub(false);
        }
    };

    useEffect(() => {
        activeRef.current = true;
        return () => {
            activeRef.current = false;
        };
    }, []);

    useEffect(() => {
        if (channel.protocol !== "comfyui" || !token) return;
        void listComfyBridges(token, Boolean(admin))
            .then(setBridges)
            .catch((error) => message.error(error instanceof Error ? error.message : "读取 Bridge 失败"));
    }, [channel.protocol, token, admin?.index]);

    const choose = (key?: string) => {
        const item = workflows.find((entry) => entryKey(entry) === key);
        setSelectedKey(key || "");
        setKind(item?.kind || "workflow");
        setWorkflowId(item?.workflowId || "");
        setTitle(item?.title || "");
        setCapability(item?.capability || "image");
        setJsonText(item?.workflowJson ? JSON.stringify(item.workflowJson, null, 2) : "");
    };

    const saveEntry = (item: WorkflowEntry) => {
        const key = entryKey(item);
        const index = workflows.findIndex((entry) => entryKey(entry) === key);
        onWorkflowsChange(index < 0 ? [...workflows, item] : workflows.map((entry, current) => (current === index ? item : entry)));
        setSelectedKey(key);
    };

    const pull = async () => {
        const id = workflowId.trim();
        if (!id) return message.warning("请先填写工作流 ID");
        setBusy(true);
        try {
            let incoming: WorkflowEntry;
            if (channel.protocol === "runninghub") {
                if (!token) throw new Error("拉取 RunningHub 参数请先登录");
                incoming = await inspectRunningHub(token, { baseUrl: channel.baseUrl, apiKey: channel.apiKey, kind, workflowId: id, title, capability }, admin);
            } else {
                if (!token) throw new Error("拉取 ComfyUI 参数请先登录");
                if (!channel.bridgeId) throw new Error("请先选择 Bridge 设备");
                const discovered = bridge?.capabilities?.workflows?.find((entry) => entry.workflowId === id);
                const source = jsonText.trim() ? (JSON.parse(jsonText) as Record<string, unknown>) : undefined;
                const inspected = await inspectComfyBridge(token, { bridgeId: channel.bridgeId, workflowId: id, workflowJson: source, capability }, Boolean(admin));
                incoming = {
                    provider: "comfyui",
                    kind: "workflow",
                    workflowId: id,
                    title: title.trim() || discovered?.title || id,
                    capability,
                    enabled: true,
                    fields: inspected.fields,
                    workflowJson: inspected.workflowJson,
                    workflowGraph: inspected.workflowGraph,
                };
            }
            if (!activeRef.current) return;
            const old = workflows.find((entry) => entryKey(entry) === entryKey(incoming));
            const fields = old?.fields.length ? mergeWorkflowFieldMappings(old.fields, incoming.fields, capability) : normalizeWorkflowFieldMappings(incoming.fields, capability);
            const next = { ...incoming, enabled: old?.enabled ?? true, fields, workflowGraph: incoming.workflowGraph || old?.workflowGraph };
            saveEntry(next);
            setTitle(next.title);
            setJsonText(next.workflowJson ? JSON.stringify(next.workflowJson, null, 2) : "");
            message.success(
                channel.protocol === "runninghub"
                    ? next.fields.some((field) => field.enabled !== false && ["referenceImage", "referenceVideo", "referenceAudio", "mask"].includes(field.source || ""))
                        ? `RunningHub ${kind === "app" ? "App" : "工作流"}参数已保存；生成时会调用 RunningHub 素材上传接口`
                        : `RunningHub ${kind === "app" ? "App" : "工作流"}参数已重新拉取并保存`
                    : "ComfyUI 工作流配置已保存",
            );
        } catch (error) {
            if (activeRef.current) message.error(error instanceof Error ? error.message : "拉取工作流失败");
        } finally {
            if (activeRef.current) setBusy(false);
        }
    };

    const saveJson = async () => {
        if (!selected || selected.kind === "app") return;
        try {
            const source = JSON.parse(jsonText) as Record<string, unknown>;
            if (channel.protocol === "runninghub") {
                const parsed = parseComfyWorkflowJSON(source);
                saveEntry({ ...selected, workflowJson: parsed.workflowJson, workflowGraph: parsed.workflowGraph || selected.workflowGraph });
                return;
            }
            if (!token || (!channel.bridgeId && !channel.comfyUrl)) return message.error("请先填写 ComfyUI 地址");
            setBusy(true);
            try {
                const inspected = await inspectComfyBridge(token, { bridgeId: channel.bridgeId, workflowId: selected.workflowId, workflowJson: source, capability: selected.capability }, Boolean(admin));
                if (!activeRef.current) return;
                saveEntry({ ...selected, workflowJson: inspected.workflowJson, workflowGraph: inspected.workflowGraph || selected.workflowGraph, fields: mergeWorkflowFieldMappings(selected.fields, inspected.fields, selected.capability) });
                setJsonText(JSON.stringify(inspected.workflowJson, null, 2));
            } finally {
                if (activeRef.current) setBusy(false);
            }
        } catch (error) {
            if (activeRef.current) message.error(error instanceof Error ? error.message : "API JSON 无效");
        }
    };

    const refreshBridges = async () => {
        if (!token) return;
        setBridges(await listComfyBridges(token, Boolean(admin)));
    };

    const registerBridge = async () => {
        if (!token) return message.warning("注册 Bridge 请先登录");
        try {
            const created = await createComfyBridge(token, bridgeName, Boolean(admin));
            setNewToken(created.token);
            setNewTokenBridgeId(created.bridge.id);
            onChannelChange({ bridgeId: created.bridge.id });
            await refreshBridges();
            setBridgeName("");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "注册 Bridge 失败");
        }
    };

    const startLocalBridge = async () => {
        setBusy(true);
        try {
            const settings = { ...defaultComfyLocalSettings(), ...(await readComfyLocalSettings(channel.id)) };
            const comfyUrl = settings.tunnelBaseUrl || channel.comfyUrl || settings.url;
            await testComfyConnection(comfyUrl, settings.apiKey);
            let bridgeId = settings.bridgeId || "";
            let bridgeToken = settings.bridgeToken || "";
            if (!bridgeToken || !bridges.some((item) => item.id === bridgeId)) {
                const created = await createComfyBridge(token, bridgeName.trim() || "本机个人 Bridge", Boolean(admin));
                bridgeId = created.bridge.id;
                bridgeToken = created.token;
                await saveComfyLocalSettings(channel.id, { ...settings, bridgeId, bridgeToken });
            }
            onChannelChange({ bridgeId, comfyUrl });
            const response = await fetch("/desktop/bridge", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ comfyUrl, apiKey: settings.apiKey, token: bridgeToken, workflowDir: channel.workflowDir }) });
            const result = await response.json();
            if (!response.ok) throw new Error(result.error || "启动失败");
            for (let index = 0; index < 15; index++) {
                if (!activeRef.current) return;
                const next = await listComfyBridges(token, Boolean(admin));
                setBridges(next);
                const online = next.find((item) => item.id === bridgeId && item.online);
                if (online) {
                    const candidates = (online.capabilities?.workflows || []).filter((item) => item.source === "builtin" && item.capability && !workflows.some((entry) => entry.workflowId === item.workflowId && entry.kind === "workflow"));
                    const added: WorkflowEntry[] = [];
                    const failed: string[] = [];
                    for (const item of candidates) {
                        try {
                            const capability = item.capability!;
                            const result = await inspectComfyBridge(token, { bridgeId, workflowId: item.workflowId, capability }, Boolean(admin));
                            const fields = normalizeWorkflowFieldMappings(result.fields, capability).map((field) => (item.workflowId === "builtin:h3-ref" && field.source === "referenceAudio" ? { ...field, required: false } : field));
                            added.push({
                                provider: "comfyui",
                                kind: "workflow",
                                workflowId: item.workflowId,
                                title: item.title || item.workflowId,
                                capability,
                                enabled: true,
                                fields,
                                workflowJson: result.workflowJson,
                                workflowGraph: result.workflowGraph,
                            });
                        } catch (error) {
                            failed.push(`${item.title || item.workflowId}：${error instanceof Error ? error.message : "检查失败"}`);
                        }
                    }
                    if (added.length) onWorkflowsChange([...workflows, ...added]);
                    if (failed.length) message.warning(`部分内置工作流未登记：${failed.join("；")}`, 12);
                    else message.success(`ComfyUI 已连接${added.length ? `，新增 ${added.length} 条内置工作流` : ""}`);
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, 700));
            }
            throw new Error("Bridge 尚未上线，请查看日志或稍后刷新设备状态");
        } catch (error) {
            if (activeRef.current) message.error(error instanceof Error ? error.message : "启动 Bridge 失败");
        } finally {
            if (activeRef.current) setBusy(false);
        }
    };

    const serverURL = typeof window === "undefined" ? "" : window.location.origin;
    const bridgeArgs = `--server "${serverURL}" --token "${newToken}" --comfy "${channel.comfyUrl || "http://127.0.0.1:8188"}" --workflow-dir "${channel.workflowDir || "workflows"}"`;
    const windowsBridgeCommand = `$secure = Read-Host 'ComfyUI API Key（没有则直接回车）' -AsSecureString; \$env:COMFY_API_KEY = [System.Net.NetworkCredential]::new('', \$secure).Password; .\\InfiniteCanvas-ComfyBridge.exe ${bridgeArgs}; Remove-Item Env:COMFY_API_KEY`;
    const linuxBridgeCommand = `read -rsp 'ComfyUI API Key（没有则直接回车）: ' COMFY_API_KEY; printf '\n'; export COMFY_API_KEY; chmod +x ./InfiniteCanvas-ComfyBridge-linux-amd64 && ./InfiniteCanvas-ComfyBridge-linux-amd64 ${bridgeArgs}; unset COMFY_API_KEY`;

    return (
        <div className={`${styles.root} space-y-3`} inert={busy}>
            {channel.protocol === "runninghub" ? (
                <div className="grid gap-3 md:grid-cols-2">
                    <Form.Item label="Base URL" className="!mb-0">
                        <AutoComplete
                            value={channel.baseUrl}
                            options={[
                                { label: "中国站 · https://www.runninghub.cn", value: "https://www.runninghub.cn" },
                                { label: "国际站 · https://www.runninghub.ai", value: "https://www.runninghub.ai" },
                            ]}
                            onChange={(baseUrl) => onChannelChange({ baseUrl })}
                        >
                            <Input />
                        </AutoComplete>
                    </Form.Item>
                    <Form.Item label="积分 API Key（提交、查询）" className="!mb-0">
                        <Input.Password value={channel.apiKey} onChange={(event) => onChannelChange({ apiKey: event.target.value })} placeholder={admin?.index === undefined ? "" : "留空沿用已保存密钥"} />
                    </Form.Item>
                    <Form.Item label="素材上传 API Key（企业级）" className="!mb-0 md:col-span-2">
                        <Input.Password value={channel.uploadApiKey || ""} onChange={(event) => onChannelChange({ uploadApiKey: event.target.value })} placeholder="没有参考素材可以留空" />
                    </Form.Item>
                    <Form.Item label="RunningHub 公开工作流目录" className="!mb-0 md:col-span-2">
                        <div className="grid gap-2 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto]">
                            <Input value={runningHubSearch} onChange={(event) => setRunningHubSearch(event.target.value)} onPressEnter={() => void searchRunningHub()} placeholder="搜索 H3、MOSS、Anima 等" />
                            <Select
                                showSearch
                                filterOption={false}
                                value={undefined}
                                placeholder={runningHubTemplates.length ? `找到 ${runningHubTemplates.length} 个公开工作流` : "搜索后选择工作流"}
                                options={runningHubTemplates.map((item) => ({
                                    value: item.workflowId,
                                    label: `${item.title} · ${item.author || "未知作者"} · 使用 ${item.useCount || "0"} 次`,
                                    title: item.description,
                                }))}
                                onChange={(id) => {
                                    const item = runningHubTemplates.find((candidate) => candidate.workflowId === id);
                                    if (!item) return;
                                    setKind("workflow");
                                    setWorkflowId(item.workflowId);
                                    setTitle(item.title);
                                    setCapability(/视频|video/i.test(`${item.title} ${item.labels}`) ? "video" : "image");
                                }}
                            />
                            <Button loading={searchingRunningHub} onClick={() => void searchRunningHub()}>
                                搜索目录
                            </Button>
                        </div>
                        <div className="mt-1 text-xs text-[var(--ant-color-text-tertiary)]">目录搜索不调用生成任务。选中后请用自己的 API Key 拉取参数；跨平台运行还需确认节点和模型兼容。</div>
                    </Form.Item>
                </div>
            ) : (
                <div className="space-y-3">
                    <ComfyUIConnectionSettings channelId={channel.id} comfyUrl={channel.comfyUrl} apiKey={channel.apiKey} onComfyUrlChange={(comfyUrl) => onChannelChange({ comfyUrl })} onApiKeyChange={(apiKey) => onChannelChange({ apiKey })} />
                    {token ? (
                        <>
                            {isPersonalDesktop ? (
                                <div className="flex flex-wrap items-center gap-2">
                                    <Button type="primary" loading={busy} onClick={() => void startLocalBridge()}>
                                        启用云端生产
                                    </Button>
                                    <span className="text-xs text-[var(--ant-color-text-secondary)]">使用上方星云 ComfyUI 地址和 API Key。启用后，在画布图片或视频节点的模型选择器中选取已启用的 ComfyUI 工作流即可生产。</span>
                                </div>
                            ) : null}
                            <div className="grid gap-3 md:grid-cols-2">
                                <Form.Item label="Bridge 设备" className="!mb-0">
                                    <Select
                                        value={channel.bridgeId || undefined}
                                        options={bridges.map((item) => ({ value: item.id, label: `${item.name} · ${item.online ? "在线" : "离线"}` }))}
                                        onChange={(bridgeId) => {
                                            onChannelChange({ bridgeId });
                                            if (bridgeId !== newTokenBridgeId) setNewToken("");
                                        }}
                                    />
                                </Form.Item>
                                <Form.Item label="设备状态" className="!mb-0">
                                    <div className="flex items-center gap-2 pt-1">
                                        <Tag color={bridge?.online ? "success" : "default"}>{bridge?.online ? "在线" : "未连接"}</Tag>
                                        <Button size="small" onClick={() => void refreshBridges()}>
                                            刷新发现
                                        </Button>
                                        {bridge ? (
                                            <Popconfirm
                                                title="删除此 Bridge 设备？"
                                                onConfirm={async () => {
                                                    const bridgeId = bridge.id;
                                                    try {
                                                        await deleteComfyBridge(token, bridgeId, Boolean(admin));
                                                    } catch (error) {
                                                        message.error(error instanceof Error ? error.message : "删除设备失败");
                                                        return;
                                                    }
                                                    onBridgeDeleted(bridgeId);
                                                    setBridges((current) => current.filter((item) => item.id !== bridgeId));
                                                    if (newTokenBridgeId === bridgeId) setNewToken("");
                                                    void refreshBridges().catch(() => {});
                                                }}
                                            >
                                                <Button size="small" danger>
                                                    删除设备
                                                </Button>
                                            </Popconfirm>
                                        ) : null}
                                    </div>
                                </Form.Item>
                                <Form.Item label="工作流目录" className="!mb-0">
                                    <Input value={channel.workflowDir || bridge?.capabilities?.workflowDir || ""} onChange={(event) => onChannelChange({ workflowDir: event.target.value })} placeholder="workflows" />
                                </Form.Item>
                            </div>
                            <div className="flex gap-2">
                                <Input value={bridgeName} onChange={(event) => setBridgeName(event.target.value)} placeholder="新 Bridge 名称" />
                                <Button onClick={() => void registerBridge()}>注册 Bridge</Button>
                            </div>
                            {newToken && channel.bridgeId === newTokenBridgeId ? (
                                <div className="space-y-2 rounded border p-3 text-xs">
                                    专用 Token 只显示这一次，关闭后无法找回：
                                    <Input.Password readOnly visibilityToggle value={newToken} />
                                    <div>下载对应程序，在能访问 ComfyUI 的机器上运行；API Key 会在终端以隐藏输入方式询问，不写入命令或账号服务器：</div>
                                    <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-[var(--muted)] p-2 select-text">
                                        Windows PowerShell: {windowsBridgeCommand}
                                        {"\n"}Linux: {linuxBridgeCommand}
                                    </pre>
                                    <div className="flex gap-2">
                                        <Button size="small" onClick={() => void navigator.clipboard.writeText(windowsBridgeCommand).then(() => message.success("Windows 启动命令已复制"))}>
                                            复制 Windows 命令
                                        </Button>
                                        <Button size="small" onClick={() => void navigator.clipboard.writeText(linuxBridgeCommand).then(() => message.success("Linux 启动命令已复制"))}>
                                            复制 Linux 命令
                                        </Button>
                                        <Button size="small" onClick={() => setNewToken("")}>
                                            我已保存
                                        </Button>
                                    </div>
                                    <div>Linux ARM64：将命令中的 amd64 改为 arm64。</div>
                                </div>
                            ) : null}
                            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--ant-color-border-secondary)] bg-[var(--ant-color-fill-quaternary)] px-3 py-2">
                                <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
                                    <Tag color="blue" className="!m-0 shrink-0">
                                        下载 Bridge
                                    </Tag>
                                    <span className="text-xs text-[var(--ant-color-text-secondary)]">在可访问 ComfyUI 的设备运行独立 Bridge，一个 Bridge 可运行该目录中的多条工作流，启动后点击“刷新发现”同步工作流</span>
                                </div>
                                <div className="flex flex-wrap gap-2">
                                    <Button type="primary" ghost size="small" href="/InfiniteCanvas-ComfyBridge.exe" download>
                                        下载 Windows
                                    </Button>
                                    <Button type="primary" ghost size="small" href="/InfiniteCanvas-ComfyBridge-linux-amd64" download>
                                        下载 Linux x64
                                    </Button>
                                    <Button type="primary" ghost size="small" href="/InfiniteCanvas-ComfyBridge-linux-arm64" download>
                                        下载 Linux ARM64
                                    </Button>
                                </div>
                            </div>
                        </>
                    ) : (
                        <div className="rounded-md bg-[var(--ant-color-fill-quaternary)] p-3 text-xs leading-5 text-[var(--ant-color-text-secondary)]">本机连接测试和队列查看无需登录。登录后可继续使用站内工作流配置与 Bridge 任务。</div>
                    )}
                </div>
            )}
            {token ? (
                <>
                    <div className="grid gap-3 md:grid-cols-12">
                        <Form.Item label="工作流用途" className="!mb-0 md:col-span-6">
                            <Select
                                value={capability}
                                options={capabilityOptions}
                                onChange={(value) => {
                                    setCapability(value);
                                    if (selected) saveEntry({ ...selected, capability: value });
                                }}
                            />
                        </Form.Item>
                        <Form.Item label="已保存条目" className="!mb-0 md:col-span-6">
                            <Select
                                allowClear
                                value={selectedKey || undefined}
                                options={workflows.map((item) => ({ value: entryKey(item), label: `${item.kind === "app" ? "App" : "Workflow"} · ${item.title || item.workflowId} · ${item.enabled ? "启用" : "停用"}` }))}
                                onChange={choose}
                                placeholder="选择已保存 Workflow / App"
                            />
                        </Form.Item>
                        {channel.protocol === "runninghub" ? (
                            <Form.Item label="类型" className="!mb-0 md:col-span-3">
                                <Segmented
                                    block
                                    value={kind}
                                    options={[
                                        { label: "Workflow", value: "workflow" },
                                        { label: "App", value: "app" },
                                    ]}
                                    onChange={(value) => {
                                        choose();
                                        setKind(value as WorkflowKind);
                                    }}
                                />
                            </Form.Item>
                        ) : null}
                        <Form.Item label={kind === "app" ? "webappId" : "workflowId"} className={`!mb-0 ${channel.protocol === "runninghub" ? "md:col-span-3" : "md:col-span-6"}`}>
                            <Input value={workflowId} onChange={(event) => setWorkflowId(event.target.value)} />
                        </Form.Item>
                        <Form.Item label="显示名称" className="!mb-0 md:col-span-6">
                            <Input value={title} onChange={(event) => setTitle(event.target.value)} onBlur={() => selected && saveEntry({ ...selected, title: title.trim() || selected.workflowId })} />
                        </Form.Item>
                        {channel.protocol === "comfyui" && bridge?.capabilities?.workflows?.length ? (
                            <Form.Item label="Bridge 发现的工作流" className="!mb-0 md:col-span-6">
                                <Select
                                    showSearch
                                    options={bridge.capabilities.workflows.map((item) => ({ value: item.workflowId, label: item.source === "remote-template" ? `云端模板 · ${item.title || item.workflowId}` : item.title || item.workflowId }))}
                                    onChange={(id) => {
                                        setWorkflowId(id);
                                        const discovered = bridge?.capabilities?.workflows?.find((item) => item.workflowId === id);
                                        if (discovered?.capability) setCapability(discovered.capability);
                                        setJsonText("");
                                    }}
                                />
                            </Form.Item>
                        ) : null}
                        {channel.protocol === "comfyui" && bridge?.capabilities?.remoteWorkflowError ? (
                            <div className="md:col-span-12 text-xs text-[var(--ant-color-text-tertiary)]">云端模板目录暂时无法读取：{bridge.capabilities.remoteWorkflowError}</div>
                        ) : null}
                        {channel.protocol === "comfyui" ? (
                            <Form.Item label="导入工作流文件（ComfyUI API JSON 或界面 JSON）" className="!mb-0 md:col-span-12">
                                <input
                                    type="file"
                                    accept=".json,application/json"
                                    onChange={async (event) => {
                                        const file = event.target.files?.[0];
                                        event.target.value = "";
                                        if (!file) return;
                                        try {
                                            if (file.size > 5 * 1024 * 1024) throw new Error("工作流文件不能超过 5 MB");
                                            const text = await file.text();
                                            JSON.parse(text);
                                            setJsonText(text);
                                            setWorkflowId(file.name.replace(/\.json$/i, ""));
                                            setTitle(file.name.replace(/\.json$/i, ""));
                                            message.success("文件已载入，点击拉取参数完成登记");
                                        } catch (error) {
                                            message.error(error instanceof Error ? error.message : "读取工作流失败");
                                        }
                                    }}
                                />
                            </Form.Item>
                        ) : null}
                        <Form.Item label="操作" className="!mb-0 md:col-span-12">
                            <div className="flex flex-wrap items-center gap-2">
                                <Button type="primary" loading={busy} onClick={() => void pull()}>
                                    {selected ? "重新拉取参数" : "拉取参数"}
                                </Button>
                                <Switch checked={selected?.enabled === true} disabled={!selected} checkedChildren="启用" unCheckedChildren="停用" onChange={(enabled) => selected && saveEntry({ ...selected, enabled })} />
                                <Popconfirm
                                    title="删除当前工作流？"
                                    onConfirm={() => {
                                        if (!selected) return;
                                        onWorkflowsChange(workflows.filter((item) => entryKey(item) !== selectedKey));
                                        choose();
                                    }}
                                >
                                    <Button danger disabled={!selected}>
                                        删除
                                    </Button>
                                </Popconfirm>
                            </div>
                        </Form.Item>
                    </div>
                    <Segmented
                        block
                        value={mode}
                        options={[
                            { label: "字段配置", value: "fields" },
                            { label: "测试画布", value: "test" },
                        ]}
                        onChange={(value) => setMode(value as "fields" | "test")}
                    />
                    {mode === "fields" ? (
                        <>
                            {selected?.kind === "app" ? (
                                <WorkflowFieldMappingEditor fields={selected.fields} onChange={(fields) => saveEntry({ ...selected, fields })} />
                            ) : (
                                <WorkflowGraphEditor
                                    workflowJson={selected?.workflowJson}
                                    workflowGraph={selected?.workflowGraph}
                                    fields={selected?.fields || []}
                                    onChange={(fields) => selected && saveEntry({ ...selected, fields })}
                                    disabled={!selected}
                                    emptyDescription={`请先拉取 ${channel.protocol === "runninghub" ? "RunningHub" : "ComfyUI"} 工作流`}
                                />
                            )}
                            {kind !== "app" ? (
                                <details className="rounded border border-[var(--ant-color-border)] p-2">
                                    <summary>查看或编辑 ComfyUI API JSON</summary>
                                    <Input.TextArea
                                        className="!mt-2"
                                        rows={12}
                                        spellCheck={false}
                                        value={jsonText}
                                        disabled={busy}
                                        onChange={(event) => setJsonText(event.target.value)}
                                        onBlur={channel.protocol === "runninghub" ? () => void saveJson() : undefined}
                                        placeholder={'{"3":{"class_type":"...","inputs":{}}}'}
                                    />
                                    {channel.protocol === "comfyui" ? (
                                        <div className="mt-2 flex justify-end">
                                            <Button size="small" loading={busy} disabled={busy || !selected} onClick={() => void saveJson()}>
                                                应用 JSON
                                            </Button>
                                        </div>
                                    ) : null}
                                </details>
                            ) : null}
                        </>
                    ) : (
                        <>
                            <WorkflowTestWorkbench
                                key={`${admin ? "system" : "personal"}:${channel.id}:${selected?.kind || kind}:${selected?.workflowId || ""}`}
                                workflowRef={{ scope: admin ? "system" : "personal", channelId: channel.id, kind: selected?.kind || kind, workflowId: selected?.workflowId || "" }}
                                token={token}
                                provider={channel.protocol}
                                workflowId={selected?.workflowId || ""}
                                workflowKind={selected?.kind || kind}
                                title={selected?.title || ""}
                                capability={selected?.capability || capability}
                                fields={selected?.fields || []}
                                disabled={!selected || !selected.enabled || !token}
                                disabledReason={!selected ? "请先拉取或选择一个已保存的工作流" : !token ? "请先登录" : "此条工作流已停用"}
                                onBeforeTest={onBeforeTest}
                            />
                        </>
                    )}
                </>
            ) : (
                <div className="rounded-md bg-[var(--ant-color-fill-quaternary)] p-3 text-xs leading-5 text-[var(--ant-color-text-secondary)]">登录后可编辑工作流、拉取参数和提交任务。</div>
            )}
        </div>
    );
}
