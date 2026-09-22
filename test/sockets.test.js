/**
 * Loopback WebSocket tests for live snapshots, session revocation, and owner isolation.
 * Fixtures use temporary vaults and synthetic index data.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter, once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { WalletVault, WalletService, passwordKey, passwordHash } from 'pepecoin-js-wallet/server';
import { UserStore } from '../lib/store.js';
import { walletHttp } from '../lib/wallet-http.js';
import { attachWalletSockets } from '../lib/wallet-sockets.js';

/**
 * Create isolated console dependencies and register resource cleanup.
 * @param {import("node:test").TestContext} t - Test lifecycle.
 * @returns {Promise<object>} Fixture resources and helpers.
 */
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pepe-socket-'));
  const vault = new WalletVault(dir), store = new UserStore(dir); await store.init();
  const password = 'socket test password';
  const owners = [];
  for (const accountName of ['alpha', 'bravo']) {
    const salt = randomBytes(16), key = passwordKey(password, salt);
    owners.push(await store.create({ accountName, displayName: accountName, passwordSalt: salt.toString('base64url'), passwordHash: passwordHash(key).toString('base64url') }));
    key.fill(0);
  }
  const status = { state: 'syncing', height: 100, targetHeight: 102, progressPercent: 98, lastSyncedAt: null };
  const events = new EventEmitter();
  const coins = [];
  const index = { watchIdentity: async () => {}, walletSnapshot: async ids => ({ height: status.height, utxos: coins.filter(c => ids.includes(c.identity)), transactions: [], legacyPending: [] }) };
  const service = new WalletService({ vault, index, status, broadcast: async () => { throw new Error('No real relay in tests'); } });
  const wallets = owners.map((o, i) => vault.create(o.id, `account-${i}`, `Wallet ${i}`));
  const handler = walletHttp({ store, vault, service, status });
  const server = http.createServer(handler);
  const live = attachWalletSockets(server, { handler, vault, service, status, events, throttleMs: 5, heartbeatMs: 1000 });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await live.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); vault.close(); });
  const base = `http://127.0.0.1:${server.address().port}`, url = base.replace('http:', 'ws:') + '/events';
  const request = (command, input, cookie) => fetch(base + '/console', { method: 'POST', headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ command, kind: input === undefined ? 'read' : 'write', input }) });
  const cookies = [];
  for (const owner of owners) {
    const response = await request('login', { accountName: owner.accountName, password });
    assert.equal(response.status, 200); cookies.push(response.headers.get('set-cookie').split(';')[0]);
  }
  return { vault, handler, status, events, owners, wallets, base, url, cookies, request, coins };
}

/**
 * Connect a fixture operator and buffer snapshots for predicate-based assertions.
 * @param {object} f - Socket fixture.
 * @param {number} [index=0] - Operator/session index.
 * @returns {Promise<object>} Socket and snapshot wait helper.
 */
async function connect(f, index = 0) {
  const ws = new WebSocket(f.url, { origin: f.base, headers: { cookie: f.cookies[index] } });
  const messages = [], events = new EventEmitter();
  ws.on('error', () => {});
  ws.on('message', bytes => { messages.push(JSON.parse(bytes)); events.emit('data'); });
  await once(ws, 'open');
  const next = (matches = () => true) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => { events.off('data', check); reject(new Error('No matching socket update')); }, 3000);
    function check() {
      const i = messages.findIndex(matches); if (i < 0) return;
      clearTimeout(timer); events.off('data', check); resolve(messages.splice(i, 1)[0]);
    }
    events.on('data', check); check();
  });
  return { ws, next };
}

test('WebSocket pushes initial state, indexed blocks, and writes without client polling', async t => {
  const f = await fixture(t), a = await connect(f), b = await connect(f, 1);
  const initial = await a.next();
  assert.equal(initial.snapshot.wallet.id, f.wallets[0].id);
  assert.deepEqual(initial.wallets.map(w => w.owner), [f.owners[0].id]);
  assert.ok(!JSON.stringify(initial).includes('passwordHash'));
  assert.ok(!JSON.stringify(initial).includes('secret'));
  await b.next();
  f.coins.push({ identity: f.wallets[0].addresses[0].identity, txid: '11'.repeat(32), vout: 0, valueKoinu: '100000000', height: 90, coinbase: 0 });
  f.status.height = 101; f.events.emit('block', { height: 101 });
  const funded = (await a.next(m => m.network.height === 101)).snapshot;
  assert.equal(funded.indexedHeight, 101); assert.equal(funded.balance, '1.00000000');
  const isolated = (await b.next(m => m.network.height === 101)).snapshot;
  assert.equal(isolated.wallet.id, f.wallets[1].id); assert.equal(isolated.balance, '0.00000000');
  const response = await f.request('wallets', { accountId: 'new-account', label: 'New' }, f.cookies[0]);
  assert.equal(response.status, 200);
  assert.equal((await a.next(m => m.wallets.length === 2)).wallets.length, 2);
  const other = await b.next(); assert.equal(other.wallets.length, 1);
  const lock = await f.request('admin/lock', { password: 'socket test password', locked: true }, f.cookies[0]);
  assert.equal(lock.status, 200);
  assert.ok((await b.next(m => m.network.spendingLocked)).network.spendingLocked);
});

test('socket upgrade rejects missing sessions, foreign origins, bearer keys and wrong paths', async t => {
  const f = await fixture(t);
  for (const [url, options, code] of [
    [f.url, { origin: f.base }, 401],
    [f.url, { origin: 'https://evil.example', headers: { cookie: f.cookies[0] } }, 403],
    [f.url, { headers: { cookie: f.cookies[0] } }, 403],
    [f.url, { origin: f.base, headers: { cookie: f.cookies[0], authorization: 'Bearer ignored' } }, 403],
    [f.url + '-other', { origin: f.base, headers: { cookie: f.cookies[0] } }, 404]
  ]) {
    const ws = new WebSocket(url, options); ws.on('error', () => {});
    const [, response] = await once(ws, 'unexpected-response');
    assert.equal(response.statusCode, code); response.resume(); ws.terminate();
  }
});

test('socket subscriptions cannot cross operators or perform spending commands', async t => {
  const f = await fixture(t);
  for (const message of [{ type: 'subscribe', walletId: f.wallets[1].id }, { type: 'withdraw', walletId: f.wallets[0].id }]) {
    const client = await connect(f); await client.next();
    const ended = once(client.ws, 'close'); client.ws.send(JSON.stringify(message));
    assert.equal((await ended)[0], 4400);
  }
  assert.equal(f.vault.outgoing(f.wallets[0].id).length, 0);
});

test('logout closes sockets and reconnect supplies a fresh snapshot without replaying writes', async t => {
  const f = await fixture(t), first = await connect(f); await first.next();
  const ended = once(first.ws, 'close'); first.ws.close(); await ended;
  f.status.height = 102; f.status.state = 'synced';
  const second = await connect(f); assert.equal((await second.next()).network.height, 102);
  const loggedOut = once(second.ws, 'close');
  assert.equal((await f.request('logout', {}, f.cookies[0])).status, 200);
  assert.equal((await loggedOut)[0], 4401);
  assert.equal(f.vault.outgoing(f.wallets[0].id).length, 0);
});

test('an idle socket closes when its session expires', async t => {
  const f = await fixture(t), authorize = f.handler.authorizeSocket;
  f.handler.authorizeSocket = req => ({ ...authorize(req), expires: Date.now() + 60 });
  const client = await connect(f), ended = once(client.ws, 'close');
  await client.next(); assert.equal((await ended)[0], 4401);
});
