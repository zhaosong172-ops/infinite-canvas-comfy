import ssh2 from 'ssh2';
const { Client } = ssh2;
import { createServer } from 'node:net';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

// Keep cloud passwords only for the lifetime of this connection. Host keys use accept-new semantics.
export async function openComfyTunnel(options, knownHostsFile) {
    const connection = new Client();
    const hostId = options.host + ':' + options.port;
    const known = existsSync(knownHostsFile) ? JSON.parse(readFileSync(knownHostsFile, 'utf8')) : {};
    let mismatch = false;
    let fingerprint = '';
    const config = {
        host: options.host, port: options.port, username: options.username,
        readyTimeout: 12000, keepaliveInterval: 15000, keepaliveCountMax: 3,
        hostHash: 'sha256',
        hostVerifier: hash => {
            fingerprint = hash;
            if (known[hostId] && known[hostId] !== hash) { mismatch = true; return false; }
            // Save only after authentication succeeds, below.
            return true;
        },
    };
    if (options.password) config.password = options.password;
    else {
        const identity = options.identityFile || ['id_ed25519', 'id_rsa'].map(name => join(homedir(), '.ssh', name)).find(existsSync);
        if (identity) config.privateKey = readFileSync(identity);
        else config.agent = process.env.SSH_AUTH_SOCK || (process.platform === 'win32' ? '\\\\.\\pipe\\openssh-ssh-agent' : undefined);
        if (!config.privateKey && !config.agent) throw new Error('请选择私钥或填写 SSH 密码');
        if (options.passphrase) config.passphrase = options.passphrase;
    }
    const server = createServer(socket => {
        connection.forwardOut('127.0.0.1', socket.localPort || 0, options.remoteHost, options.remotePort, (error, stream) => {
            if (error) { socket.destroy(); return; }
            socket.on('error', () => stream.destroy());
            stream.on('error', () => socket.destroy());
            socket.pipe(stream).pipe(socket);
        });
    });
    const sockets = new Set();
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    const close = () => { for (const socket of sockets) socket.destroy(); if (server.listening) server.close(); connection.end(); };
    try {
        await new Promise((resolve, reject) => {
            connection.once('ready', resolve);
            connection.once('error', error => reject(new Error(mismatch ? 'SSH 主机指纹已变化，请确认云实例是否重建；核对后清理本机已信任的主机记录' : error.level === 'client-authentication' ? 'SSH 认证失败，请检查用户名、密码或私钥' : 'SSH 连接失败：' + error.message)));
            connection.connect(config);
        });
        known[hostId] = fingerprint;
        mkdirSync(dirname(knownHostsFile), { recursive: true });
        writeFileSync(knownHostsFile, JSON.stringify(known), { mode: 0o600 });
        await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
        connection.on('error', close);
        connection.once('close', close);
        return { localPort: server.address().port, fingerprint, close, onClose: callback => connection.once('close', callback) };
    } catch (error) { close(); throw error; }
}
