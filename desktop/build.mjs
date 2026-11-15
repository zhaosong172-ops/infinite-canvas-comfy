import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const desktop = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(desktop);
const payload = path.join(desktop, 'payload');
const go = process.env.GO_BINARY || (fs.existsSync(path.join(root, '.tools/go/bin/go.exe')) ? path.join(root, '.tools/go/bin/go.exe') : 'go');
const env = { ...process.env, CGO_ENABLED: '0', GOTELEMETRY: 'off' };
function run(file, args, cwd, extra = {}) {
    const result = spawnSync(file, args, { cwd, env: { ...env, ...extra }, stdio: 'inherit', windowsHide: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(path.basename(file) + ' failed: ' + result.status);
}
fs.mkdirSync(payload, { recursive: true });
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(payload, 'UPSTREAM-LICENSE.txt')); 
run(go, ['build', '-trimpath', '-ldflags=-s -w', '-o', path.join(payload, 'canvas-server.exe'), '.'], root);
for (const [os, arch, name] of [['windows', 'amd64', 'InfiniteCanvas-ComfyBridge.exe'], ['linux', 'amd64', 'InfiniteCanvas-ComfyBridge-linux-amd64'], ['linux', 'arm64', 'InfiniteCanvas-ComfyBridge-linux-arm64']]) {
    run(go, ['build', '-trimpath', '-ldflags=-s -w', '-o', path.join(root, 'web/public', name), '.'], path.join(root, 'canvas-agent/native/comfy-bridge'), { GOOS: os, GOARCH: arch });
}
fs.copyFileSync(path.join(root, 'web/public/InfiniteCanvas-ComfyBridge.exe'), path.join(payload, 'InfiniteCanvas-ComfyBridge.exe'));
run(process.execPath, ['node_modules/next/dist/bin/next', 'build', '--webpack'], path.join(root, 'web'), { PERSONAL_DESKTOP: '1', NEXT_TELEMETRY_DISABLED: '1' });
const web = path.join(payload, 'web');
fs.mkdirSync(web, { recursive: true });
fs.cpSync(path.join(root, 'web/.next/standalone'), web, { recursive: true });
fs.cpSync(path.join(root, 'web/.next/static'), path.join(web, '.next/static'), { recursive: true });
fs.cpSync(path.join(root, 'web/public'), path.join(web, 'public'), { recursive: true });
const agent = path.join(payload, 'agent');
fs.mkdirSync(agent, { recursive: true });
for (const file of ['index.mjs', 'codex.mjs', 'comfy-ssh.mjs', 'package.json']) fs.copyFileSync(path.join(root, 'canvas-agent', file), path.join(agent, file));
// Codex CLI is optional. ComfyUI and Canvas Agent do not need to bundle its platform packages.
fs.cpSync(path.join(root, 'canvas-agent/node_modules'), path.join(agent, 'node_modules'), { recursive: true, filter: source => !source.includes(path.join('node_modules', '@openai', 'codex')) && !source.includes(path.join('node_modules', '.bin')) });
run(process.execPath, ['node_modules/electron-builder/out/cli/cli.js', '--win', 'portable', '--x64', '--publish', 'never'], desktop, { CSC_IDENTITY_AUTO_DISCOVERY: 'false', ELECTRON_BUILDER_COMPRESSION_LEVEL: '1', ...(fs.existsSync(path.join(root, '.tools/nsis')) ? { ELECTRON_BUILDER_NSIS_DIR: path.join(root, '.tools/nsis'), ELECTRON_BUILDER_NSIS_RESOURCES_DIR: path.join(root, '.tools/nsis-resources') } : {}) });
