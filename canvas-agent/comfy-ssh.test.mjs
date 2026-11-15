import assert from 'node:assert/strict';
import test from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import { createServer as httpServer } from 'node:http';
import { connect } from 'node:net';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ssh2 from 'ssh2';
const { Server } = ssh2;
import { openComfyTunnel } from './comfy-ssh.mjs';

const key = () => generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs1', format: 'pem' });

test('SSH forwards ComfyUI traffic with password and private key, rejects bad passwords and changed host keys', { timeout: 20000 }, async () => {
    const temp = mkdtempSync(join(tmpdir(), 'canvas-ssh-test-'));
    const knownFile = join(temp, 'known.json');
    const privateFile = join(temp, 'key.pem');
    writeFileSync(privateFile, key());
    const clients = new Set();
    const target = httpServer((_req, res) => res.end('comfy-through-ssh'));
    await new Promise(resolve => target.listen(0, '127.0.0.1', resolve));
    const ssh = new Server({ hostKeys: [key()] }, client => {
        clients.add(client);
        client.on('error', () => {});
        client.on('close', () => clients.delete(client));
        client.on('authentication', context => {
            if (context.username === 'tester' && (context.method === 'password' && context.password === 'temporary-password' || context.method === 'publickey')) context.accept();
            else context.reject();
        });
        client.on('tcpip', (accept, reject, info) => {
            const socket = connect(info.destPort, info.destIP);
            socket.once('error', reject);
            socket.once('connect', () => { const stream = accept(); socket.pipe(stream).pipe(socket); stream.on('error', () => socket.destroy()); });
        });
    });
    await new Promise(resolve => ssh.listen(0, '127.0.0.1', resolve));
    const options = { host: '127.0.0.1', port: ssh.address().port, username: 'tester', remoteHost: '127.0.0.1', remotePort: target.address().port };
    let tunnel;
    try {
        await assert.rejects(openComfyTunnel({ ...options, password: 'bad-password' }, knownFile), /认证失败/);
        tunnel = await openComfyTunnel({ ...options, password: 'temporary-password' }, knownFile);
        assert.equal(await (await fetch('http://127.0.0.1:' + tunnel.localPort)).text(), 'comfy-through-ssh');
        assert.ok(!readFileSync(knownFile, 'utf8').includes('temporary-password'));
        tunnel.close();
        tunnel = await openComfyTunnel({ ...options, identityFile: privateFile }, knownFile);
        assert.equal(await (await fetch('http://127.0.0.1:' + tunnel.localPort)).text(), 'comfy-through-ssh');
        tunnel.close(); tunnel = null;
        writeFileSync(knownFile, JSON.stringify({ [options.host + ':' + options.port]: 'different-fingerprint' }));
        await assert.rejects(openComfyTunnel({ ...options, password: 'temporary-password' }, knownFile), /指纹已变化/);
    } finally {
        tunnel?.close();
        for (const client of clients) client.end();
        ssh.close(); target.closeAllConnections(); target.close();
    }
});
