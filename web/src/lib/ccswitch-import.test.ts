import assert from "node:assert/strict";
import test from "node:test";
import { parseCCSwitchProviderImport } from "./ccswitch-import";

test("parses a CC Switch OpenAI Chat provider share link", () => {
    const link = "ccswitch://v1/import?resource=provider&app=opencode&apiFormat=openai_chat&name=DeepSeek&endpoint=https%3A%2F%2Fapi.deepseek.com%2Fv1%2Fchat%2Fcompletions&apiKey=sk-test&model=deepseek-chat";
    assert.deepEqual(parseCCSwitchProviderImport(link), [{
        protocol: "deepseek",
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "sk-test",
        models: ["deepseek-chat"],
    }]);
});

test("accepts CC Switch app-specific OpenAI Chat format aliases", () => {
    const links = [
        "opencode&apiFormat=npm",
        "openclaw&apiFormat=api",
        "hermes&apiFormat=api_mode",
        "pi&apiFormat=api",
    ];
    for (const fields of links) {
        const link = "ccswitch://v1/import?resource=provider&app=" + fields + "&endpoint=https%3A%2F%2Fexample.com%2Fv1";
        assert.equal(parseCCSwitchProviderImport(link).length, 1);
    }
});

test("rejects unsupported TOML and remote config links", () => {
    assert.throws(() => parseCCSwitchProviderImport("ccswitch://v1/import?resource=provider&app=codex&configFormat=toml&endpoint=https%3A%2F%2Fexample.com"), /JSON 配置/);
    assert.throws(() => parseCCSwitchProviderImport("ccswitch://v1/import?resource=provider&app=opencode&configUrl=https%3A%2F%2Fexample.com%2Fconfig"), /远程配置链接/);
});

test("accepts normalized OpenAI-compatible format names and strips endpoint query data", () => {
    const link = "ccswitch://v1/import?resource=provider&app=opencode&apiFormat=openai-compatible&endpoint=https%3A%2F%2Fexample.com%2Fv1%3Fsecret%3Dhidden";
    assert.equal(parseCCSwitchProviderImport(link)[0].baseUrl, "https://example.com/v1");
});

test("reads OpenAI credentials from the Base64 JSON config used by CC Switch links", () => {
    const config = Buffer.from(JSON.stringify({ env: { OPENAI_BASE_URL: "https://api.deepseek.com/v1", OPENAI_API_KEY: "sk-from-config", OPENAI_MODEL: "deepseek-chat" } })).toString("base64");
    const params = new URLSearchParams({ resource: "provider", app: "opencode", apiFormat: "openai_chat", name: "DeepSeek", config });
    assert.deepEqual(parseCCSwitchProviderImport("ccswitch://v1/import?" + params), [{
        protocol: "deepseek",
        name: "DeepSeek",
        baseUrl: "https://api.deepseek.com/v1",
        apiKey: "sk-from-config",
        models: ["deepseek-chat"],
    }]);
});

test("imports multiple OpenAI Chat-compatible providers from JSON", () => {
    const json = JSON.stringify({ providers: [
        { name: "DeepSeek", apiFormat: "openai_chat", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-one", models: ["deepseek-chat", { id: "deepseek-reasoner" }] },
        { name: "GRSAI 国际版", apiType: "openai", endpoint: "https://grsaiapi.com/v1", api_key: "sk-two", model: "gpt-image-1" },
        { name: "典名词元（AA）", apiFormat: "openai_chat", endpoint: "https://api.aa.com.cn/api/v1/chat/completions", apiKey: "sk-three", model: "aa-chat" },
        { name: "火山方舟", apiFormat: "openai_chat", endpoint: "https://ark.cn-beijing.volces.com/api/v3/chat/completions", apiKey: "ark-key", model: "doubao-seed-1-6" },
    ] });
    assert.deepEqual(parseCCSwitchProviderImport(json), [
        { protocol: "deepseek", name: "DeepSeek", baseUrl: "https://api.deepseek.com/v1", apiKey: "sk-one", models: ["deepseek-chat", "deepseek-reasoner"] },
        { protocol: "grsai", name: "GRSAI 国际版", baseUrl: "https://grsaiapi.com/v1", apiKey: "sk-two", models: ["gpt-image-1"] },
        { protocol: "aa", name: "典名词元（AA）", baseUrl: "https://api.aa.com.cn/api/v1", apiKey: "sk-three", models: ["aa-chat"] },
        { protocol: "ark", name: "火山方舟", baseUrl: "https://ark.cn-beijing.volces.com/api/v3", apiKey: "ark-key", models: ["doubao-seed-1-6"] },
    ]);
});

test("accepts app-specific format aliases in provider JSON", () => {
    assert.equal(parseCCSwitchProviderImport(JSON.stringify({ providers: [{ app: "opencode", apiFormat: "npm", endpoint: "https://example.com/v1" }] })).length, 1);
});

test("rejects non-provider, unsupported format, non-chat endpoint, and unsafe URL", () => {
    assert.throws(() => parseCCSwitchProviderImport("ccswitch://v1/import?resource=account&app=opencode"), /不是服务商/);
    assert.throws(() => parseCCSwitchProviderImport("ccswitch://v1/import?resource=provider&app=opencode&apiFormat=openai_responses&endpoint=https%3A%2F%2Fapi.example.com%2Fv1"), /仅支持 OpenAI Chat/);
    assert.throws(() => parseCCSwitchProviderImport("ccswitch://v1/import?resource=provider&app=opencode&apiFormat=openai_chat&endpoint=https%3A%2F%2Fapi.example.com%2Fv1%2Fresponses"), /仅支持 OpenAI Chat Completions/);
    assert.throws(() => parseCCSwitchProviderImport("ccswitch://v1/import?resource=provider&app=opencode&endpoint=file%3A%2F%2F%2Fsecret"), /HTTP 或 HTTPS/);
});
