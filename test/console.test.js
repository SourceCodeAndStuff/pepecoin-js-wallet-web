/**
 * Console asset, session, owner-isolation, and legacy login migration tests.
 * All storage is temporary and real transaction relay is disabled.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { WalletVault, WalletService, createWallet, passwordKey, passwordHash, encryptPrivateKey } from 'pepecoin-js-wallet/server';
import { walletHttp } from '../lib/wallet-http.js';
import { UserStore } from '../lib/store.js';
/**
 * Create isolated console dependencies and register resource cleanup.
 * @param {import("node:test").TestContext} t - Test lifecycle.
 * @returns {Promise<object>} Fixture resources and helpers.
 */
async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'pepe-web-test-'));
  const vault = new WalletVault(dir); t.after(() => vault.close());
  const status = { state: 'stopped', height: -1 };
  const index = { watchIdentity: async () => {}, walletSnapshot: async () => ({ height: -1, utxos: [], transactions: [], legacyPending: [] }) };
  const service = new WalletService({ vault, index, status, broadcast: async () => { throw new Error('Disabled in tests'); } });
  const wallet = await service.create('other', 'other-account', 'Other');
  return { dir, vault, service, status, wallet };
}

test('optional console rejects REST routes and bearer keys, but preserves browser login migration',async t=>{
  const f=await fixture(t),store=new UserStore(f.dir);await store.init();
  const salt=randomBytes(16),key=passwordKey('a long test password',salt),legacy=createWallet();
  await store.create({accountName:'operator',displayName:'Operator',passwordSalt:salt.toString('base64url'),passwordHash:passwordHash(key).toString('base64url'),encryptedPrivateKey:encryptPrivateKey(legacy.privateKey,key),address:legacy.address,identity:legacy.identity.toString('hex')});
  const server=http.createServer(walletHttp({...f,store,status:f.status}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  const base=`http://127.0.0.1:${server.address().port}`;
  const page = await (await fetch(base + '/')).text();
  assert.match(page, /<title>PepeCoin JS Wallet<\/title>/);
  assert.match(page, /id="new-wallet"/);
  const sections = ['overview', 'receive', 'send', 'history', 'addresses', 'contacts', 'security', 'network'];
  assert.deepEqual([...page.matchAll(/data-page="([^"]+)"/g)].map(m => m[1]), sections);
  assert.deepEqual([...page.matchAll(/data-view="([^"]+)"/g)].map(m => m[1]), sections);
  assert.doesNotMatch(page, /data-(?:page|view)="integration"/);
  const client = await (await fetch(base + '/wallet.js')).text();
  assert.match(client, /name="accountId"/);
  assert.match(client, /new WebSocket\(url\)/);
  assert.doesNotMatch(client, /integration:|'integration'/);
  assert.doesNotMatch(client, /setInterval\(/);
  const staticResponse = await fetch(base + '/');
  assert.ok(staticResponse.headers.get('content-security-policy').includes(base.replace('http:', 'ws:')));
  for (const asset of ['/wallet.js', '/wallet.css']) assert.equal((await fetch(base + asset)).status, 200);
  const request=(command,input,headers={})=>fetch(base+'/console',{method:'POST',headers:{'content-type':'application/json',...headers},body:JSON.stringify({command,kind:input===undefined?'read':'write',input})});
  assert.equal((await fetch(base+'/api/v1/wallets')).status,404);
  assert.equal((await request('wallets')).status,401);
  assert.equal((await request('health',undefined,{authorization:'Bearer old-key'})).status,401);
  assert.equal((await request('login',{accountName:'operator',password:'a long test password'},{origin:'https://evil.example'})).status,403);
  const login=await request('login',{accountName:'operator',password:'a long test password'});assert.equal(login.status,200);
  assert.match(login.headers.get('set-cookie'),/HttpOnly; SameSite=Strict/);
  const cookie=login.headers.get('set-cookie').split(';')[0];
  const migrated=await (await request('wallets',undefined,{cookie})).json();assert.equal(migrated.wallets[0].addresses[0].address,legacy.address);
  assert.equal((await request('auth-record/prepare',{}, {cookie})).status,404);
  assert.equal((await request('admin/keys',undefined,{cookie})).status,404);
  assert.equal((await request('register',{accountName:'intruder',password:'a long test password'})).status,403);
  assert.equal((await request(`wallets/${f.wallet.id}`,undefined,{cookie})).status,404);
});

test('console hardening: JSON-only commands, uniform login failures and operator-owned spending locks', async t => {
  const f = await fixture(t), store = new UserStore(f.dir); await store.init();
  for (const [accountName, password] of [['alice', 'alice long password'], ['bob', 'bob long password!']]) {
    const salt = randomBytes(16), key = passwordKey(password, salt);
    await store.create({ accountName, displayName: accountName, passwordSalt: salt.toString('base64url'), passwordHash: passwordHash(key).toString('base64url') });
  }
  const server = http.createServer(walletHttp({ ...f, store, status: f.status })); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (command, input, headers = {}) => fetch(base + '/console', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify({ command, kind: input === undefined ? 'read' : 'write', input }) });
  // A cross-site "simple" form/text POST is refused before any command runs.
  assert.equal((await request('health', undefined, { 'content-type': 'text/plain' })).status, 415);
  // Unknown account, short password and wrong password are indistinguishable.
  const failures = await Promise.all([
    request('login', { accountName: 'nobody', password: 'some long password' }),
    request('login', { accountName: 'alice', password: 'short' }),
    request('login', { accountName: 'alice', password: 'wrong long password' })
  ]);
  assert.deepEqual(failures.map(r => r.status), [401, 401, 401]);
  assert.equal(new Set(await Promise.all(failures.map(r => r.text()))).size, 1);
  const alice = (await request('login', { accountName: 'alice', password: 'alice long password' })).headers.get('set-cookie').split(';')[0];
  const bob = (await request('login', { accountName: 'bob', password: 'bob long password!' })).headers.get('set-cookie').split(';')[0];
  assert.equal((await request('admin/lock', { locked: true, password: 'alice long password' }, { cookie: alice })).status, 200);
  const override = await request('admin/lock', { locked: false, password: 'bob long password!' }, { cookie: bob });
  assert.equal(override.status, 403);
  assert.equal(f.vault.db.prepare("SELECT value FROM settings WHERE name='locked'").get().value, '1');
  assert.equal((await request('admin/lock', { locked: false, password: 'alice long password' }, { cookie: alice })).status, 200);
  assert.equal(f.vault.db.prepare("SELECT value FROM settings WHERE name='locked'").get().value, '0');
});
