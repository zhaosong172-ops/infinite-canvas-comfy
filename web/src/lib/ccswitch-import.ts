import type { ModelChannelProtocol } from "./model-channel";

export type CCSwitchProviderImport = {
    protocol: ModelChannelProtocol;
    name: string;
    baseUrl: string;
    apiKey: string;
    models: string[];
};

const openAIChatApps = new Set(["opencode", "openclaw", "hermes", "pi"]);
const baseUrlKeys = ["baseUrl", "baseURL", "base_url", "endpoint", "url", "OPENAI_BASE_URL", "OPENAI_API_BASE"];
const apiKeyKeys = ["apiKey", "api_key", "key", "token", "OPENAI_API_KEY", "OPENAI_AUTH_TOKEN"];
const modelKeys = ["models", "model", "modelName", "model_name", "defaultModel", "default_model", "OPENAI_MODEL"];

export function parseCCSwitchProviderImport(value: string): CCSwitchProviderImport[] {
    const input = value.trim();
    if (!input) throw new Error("请粘贴 CC Switch 链接或服务商配置 JSON");
    if (input.length > 1_000_000) throw new Error("配置内容过大，无法导入");
    if (/^ccswitch:/i.test(input)) return [parseCCSwitchProviderLink(input)];

    let parsed: unknown;
    try {
        parsed = JSON.parse(input);
    } catch {
        throw new Error("内容不是有效的 CC Switch 链接或 JSON 配置");
    }

    const providers = findProviderList(parsed);
    if (!providers.length || providers.length > 100) throw new Error("JSON 中没有可导入的服务商，或服务商数量超过限制");
    return providers.map((provider, index) => normalizeProvider(provider, index));
}

function parseCCSwitchProviderLink(value: string): CCSwitchProviderImport {
    let link: URL;
    try {
        link = new URL(value);
    } catch {
        throw new Error("CC Switch 链接格式无效");
    }
    if (link.protocol !== "ccswitch:" || link.hostname.toLowerCase() !== "v1" || link.pathname !== "/import") {
        throw new Error("请使用 CC Switch 生成的 ccswitch://v1/import 服务商分享链接");
    }
    if (link.searchParams.get("resource") !== "provider") throw new Error("该链接不是服务商配置链接");

    const app = (link.searchParams.get("app") || "").trim().toLowerCase();
    if (!app) throw new Error("CC Switch 服务商链接缺少目标应用");
    if (link.searchParams.has("configUrl")) throw new Error("暂不支持远程配置链接，请使用 CC Switch 内联分享链接");
    const config = parseLinkConfig(link);
    const format = normalizeFormat(link.searchParams.get("apiFormat") || link.searchParams.get("api_format") || "");
    if (!isOpenAIChatLinkFormat(format, app)) {
        throw new Error("当前仅支持 OpenAI Chat 兼容的 CC Switch 链接；Responses、Anthropic 或 Gemini 配置不能直接用于此渠道");
    }

    const env = record(config.env || config);
    const endpointValue = firstString(link.searchParams.get("endpoint"), link.searchParams.get("baseUrl"), link.searchParams.get("baseURL"), link.searchParams.get("base_url"), env.OPENAI_BASE_URL, env.OPENAI_API_BASE);
    const endpoint = endpointValue.split(",").map((item) => item.trim()).find(Boolean) || "";
    const models = link.searchParams.get("models") || link.searchParams.get("model") || firstString(env.OPENAI_MODEL, config.model, config.models);
    return makeProvider({
        name: link.searchParams.get("name") || "",
        baseUrl: endpoint,
        apiKey: firstString(link.searchParams.get("apiKey"), link.searchParams.get("api_key"), env.OPENAI_API_KEY, env.OPENAI_AUTH_TOKEN),
        models,
    });
}

function parseLinkConfig(link: URL): Record<string, unknown> {
    const encoded = link.searchParams.get("config");
    const format = (link.searchParams.get("configFormat") || "json").trim().toLowerCase();
    if (format !== "json") throw new Error("目前只支持 CC Switch JSON 配置；Codex TOML 配置暂不支持");
    if (!encoded) return {};
    try {
        const base64 = encoded.replace(/\s/g, "+").replace(/-/g, "+").replace(/_/g, "/");
        const padded = base64 + "=".repeat((4 - base64.length % 4) % 4);
        const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
        return record(JSON.parse(new TextDecoder().decode(bytes)));
    } catch {
        throw new Error("CC Switch 链接内的 JSON 配置无法解析");
    }
}

function findProviderList(value: unknown): unknown[] {
    if (Array.isArray(value)) return value;
    const root = record(value);
    for (const key of ["providers", "providerList", "provider_list", "items"]) {
        if (Array.isArray(root[key])) return root[key] as unknown[];
        const nested = record(root[key]);
        if (Object.keys(nested).length) return Object.values(nested);
    }
    return Object.keys(root).length ? [value] : [];
}

function normalizeProvider(value: unknown, index: number): CCSwitchProviderImport {
    const root = record(value);
    const config = parseNested(root.settingsConfig || root.settings_config || root.config);
    const env = record(config.env || root.env || root.environment);
    const merged = { ...root, ...config, ...env };
    const explicitFormat = normalizeFormat(firstString(root.apiFormat, root.api_format, root.apiType, config.apiFormat, config.api_format, config.apiType));
    const app = firstString(root.app, config.app).toLowerCase();
    const hasOpenAIEnv = Boolean(firstString(env.OPENAI_BASE_URL, env.OPENAI_API_BASE, env.OPENAI_API_KEY));
    const hasAnthropicOnlyEnv = Boolean(firstString(env.ANTHROPIC_BASE_URL, env.ANTHROPIC_AUTH_TOKEN, env.ANTHROPIC_API_KEY)) && !hasOpenAIEnv;
    if ((explicitFormat && !isOpenAIChatLinkFormat(explicitFormat, app)) || hasAnthropicOnlyEnv) {
        throw new Error(`第 ${index + 1} 个服务商不是 OpenAI Chat 兼容格式，无法直接导入`);
    }

    const baseUrl = firstString(...baseUrlKeys.map((key) => merged[key]));
    const apiKey = firstString(...apiKeyKeys.map((key) => merged[key]));
    const modelsValue = modelKeys.map((key) => merged[key]).find((item) => item !== undefined);
    const models = Array.isArray(modelsValue)
        ? modelsValue.flatMap((item) => typeof item === "string" ? [item.trim()] : [firstString(record(item).id, record(item).name, record(item).model)]).filter(Boolean)
        : splitModels(firstString(modelsValue));
    return makeProvider({
        name: firstString(root.name, root.label, root.providerName, root.provider_name) || `CC Switch 渠道 ${index + 1}`,
        baseUrl,
        apiKey,
        models,
    });
}

function makeProvider({ name, baseUrl: endpoint, apiKey, models }: { name: string; baseUrl: string; apiKey: string; models: string | string[] }): CCSwitchProviderImport {
    let url: URL;
    try {
        url = new URL(endpoint);
    } catch {
        throw new Error("CC Switch 配置缺少有效的服务商接口地址");
    }
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
        throw new Error("服务商接口地址必须是有效的 HTTP 或 HTTPS 地址");
    }
    url.pathname = url.pathname.replace(/\/+$/, "");
    if (/\/chat\/completions$/i.test(url.pathname)) {
        url.pathname = url.pathname.replace(/\/chat\/completions$/i, "");
    } else if (/\/(responses|completions)$/i.test(url.pathname)) {
        throw new Error("当前仅支持 OpenAI Chat Completions 接口地址，不支持 Responses 或旧版 Completions 地址");
    }
    url.search = "";
    url.hash = "";
    const protocol: ModelChannelProtocol = /deepseek/i.test(url.hostname) ? "deepseek" : /grsai/i.test(url.hostname) ? "grsai" : /(^|\.)aa\.com\.cn$/i.test(url.hostname) ? "aa" : /(^|\.)volces\.com$/i.test(url.hostname) ? "ark" : "openai";
    const parsedModels = Array.isArray(models) ? models : splitModels(models);
    return {
        protocol,
        name: name.trim().slice(0, 80) || (protocol === "deepseek" ? "DeepSeek" : protocol === "grsai" ? "GRSAI 国际版" : protocol === "aa" ? "典名词元（AA）" : protocol === "ark" ? "火山方舟" : "CC Switch 导入"),
        baseUrl: url.toString().replace(/\/+$/, ""),
        apiKey: apiKey.trim(),
        models: [...new Set(parsedModels)].slice(0, 100),
    };
}

function parseNested(value: unknown): Record<string, unknown> {
    if (typeof value === "string") {
        try { return record(JSON.parse(value)); } catch { return {}; }
    }
    return record(value);
}

function record(value: unknown): Record<string, unknown> {
    return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstString(...values: unknown[]) {
    return values.find((value): value is string => typeof value === "string" && Boolean(value.trim()))?.trim() || "";
}

function splitModels(value: string) {
    return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
}

function normalizeFormat(value: string) {
    return value.trim().toLowerCase().replace(/[^a-z]/g, "");
}

function isOpenAIChatLinkFormat(value: string, app: string) {
    if (isOpenAIChatFormat(value)) return true;
    if (!value) return openAIChatApps.has(app);
    return (app === "opencode" && value === "npm") || (["openclaw", "pi"].includes(app) && value === "api") || (app === "hermes" && value === "apimode");
}

function isOpenAIChatFormat(value: string) {
    return value === "openai" || value === "chatcompletions" || value.includes("openaichat") || value === "openaicompatible";
}