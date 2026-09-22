/**
 * Session-authenticated browser console transport and static asset handler.
 * This adapter is separate from the embeddable wallet library; it is not a public REST API.
 */
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import QRCode from 'qrcode';
import { normalizeAccountName, passwordKey, passwordHash, passwordMatches, decryptPrivateKey, walletFromPrivateKey, destinationScript, importWif, wif } from 'pepecoin-js-wallet/server';
import { signMessage, verifyMessage, ribbit } from 'pepecoin-js-wallet/server';
import { label } from 'pepecoin-js-wallet/server';

/**
 * Create the console handler and its shared socket authorization boundary.
 * @param {object} options - Store, vault, service, mutable sync status, and deployment origin.
 * @param {object} options.store - Local operator credential store.
 * @param {object} options.vault - Wallet vault.
 * @param {object} options.service - Owner-scoped wallet operations.
 * @param {object} options.status - Live synchronization status.
 * @param {string} [options.publicOrigin] - Allowed external origin; defaults to PUBLIC_ORIGIN.
 * @returns {Function & {changes: EventEmitter, authorizeSocket: Function}} HTTP handler with session hooks.
 */
export function walletHttp({ store, vault, service, status, publicOrigin = process.env.PUBLIC_ORIGIN }) {
  const sessions = new Map(), attempts = new Map(), changes = new EventEmitter();
  let registration = Promise.resolve();
  const pages = new Map([['/', 'wallet.html'], ['/login','wallet.html'], ['/signup','wallet.html'], ['/dashboard','wallet.html'], ['/wallet.js','wallet.js'], ['/wallet.css','wallet.css']]);
  const headers = {
    'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
  };
  /**
   * Write a response with common security headers and optional overrides.
   * @param {import("node:http").ServerResponse} res - Response stream.
   * @param {number} code - HTTP status.
   * @param {*} body - JSON value or raw asset bytes.
   * @param {string} [type] - MIME type; JSON bodies are serialized.
   * @param {object} [extra] - Additional response headers.
   * @returns {void}
   */
  function reply(res, code, body, type = 'application/json; charset=utf-8', extra = {}) {
    res.writeHead(code, { ...headers, 'content-type': type, ...extra });
    res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
  }
  /**
   * Read a JSON command with a five-MiB upper bound.
   * @param {import("node:http").IncomingMessage} req - Request stream.
   * @returns {Promise<object>} Parsed input, or an empty object for an empty body.
   * @throws {Error} For oversized or malformed input.
   */
  async function readJson(req) {
    let size = 0; const parts = [];
    for await (const part of req) { size += part.length; if (size > 5 * 1024 * 1024) throw Object.assign(new Error('Request too large.'), { status: 413 }); parts.push(part); }
    return parts.length ? JSON.parse(Buffer.concat(parts).toString()) : {};
  }
  /**
   * Verify an operator password and return its derived key.
   * The caller must clear the returned buffer after use; failures clear it here.
   * @param {object} user - Credential record.
   * @param {string} value - Submitted password.
   * @returns {Buffer} Sensitive derived key.
   * @throws {Error} For invalid credentials.
   */
  function password(user, value) {
    const invalid = () => Object.assign(new Error('Invalid account name or password.'), { status: 401 });
    // Same work and the same error for unknown accounts and malformed passwords, so responses
    // and timing do not reveal which account names exist.
    const candidate = typeof value === 'string' && value.length >= 12 && value.length <= 1024 ? value : '\0'.repeat(12);
    const key = passwordKey(candidate, Buffer.from(user ? user.passwordSalt : 'AAAAAAAAAAAAAAAAAAAAAA', 'base64url'));
    if (!user || candidate !== value || !passwordMatches(passwordHash(key), Buffer.from(user.passwordHash, 'base64url'))) { key.fill(0); throw invalid(); }
    return key;
  }
  /**
   * Resolve and check the session cookie, expiring stale sessions.
   * @param {import("node:http").IncomingMessage} req - HTTP or upgrade request.
   * @returns {{user: object|null, token: string}} Stored operator and session token.
   * @throws {Error} With status 401 when no live session exists.
   */
  function admin(req) {
    const token = req.headers.cookie?.split(';').map(v => v.trim()).find(v => v.startsWith('pep_session='))?.slice(12);
    const session = sessions.get(token);
    if (!session || session.expires < Date.now()) { if (token) sessions.delete(token); throw Object.assign(new Error('Sign in is required.'), { status: 401 }); }
    return { user: store.findById(session.userId), token };
  }
  /**
   * Resolve the signed-in operator namespace for wallet ownership checks.
   * @param {import("node:http").IncomingMessage} req - Browser request.
   * @returns {string} Operator ID.
   */
  function authorize(req) { return admin(req).user.id; }
  /**
   * Require a current password for a sensitive operation and clear the derived key.
   * @param {import("node:http").IncomingMessage} req - Browser request.
   * @param {{password: string}} input - Password-bearing command input.
   * @returns {object} Internal operator record.
   */
  function reauth(req, input) { const { user } = admin(req); const key = password(user, input.password); key.fill(0); return user; }
  /**
   * Build the minimal session identity returned to the browser.
   * @param {object} user - Internal record.
   * @returns {{id: string, accountName: string, displayName: string}} Public identity.
   */
  const safeUser = user => ({ id: user.id, accountName: user.accountName, displayName: user.displayName });
  /**
   * Serve allowed assets or execute an owner-scoped console command.
   * Successful write responses notify socket subscribers; errors become JSON responses.
   * @param {import("node:http").IncomingMessage} req - Incoming request.
   * @param {import("node:http").ServerResponse} res - Outgoing response.
   * @returns {Promise<void>} Resolves after responding.
   */
  const handler = async (req, res) => {
    let writes = false;
    res.once('finish', () => { if (writes && res.statusCode < 400) changes.emit('change'); });
    try {
      let url = new URL(req.url, 'http://localhost'), p = url.pathname, method = req.method, post = false;
      const expected = publicOrigin ? new URL(publicOrigin) : null;
      const host = req.headers.host || '';
      if (expected ? host !== expected.host : !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) return reply(res, 403, { error: 'Host not allowed. Configure PUBLIC_ORIGIN for your deployment.' });
      if (req.headers.origin && req.headers.origin !== (expected?.origin || `http://${host}`)) return reply(res, 403, { error: 'Cross-origin requests are not permitted.' });
      if (method === 'GET' && pages.has(p)) {
        const file = pages.get(p), type = file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'text/javascript' : 'text/html';
        const socketOrigin = expected ? expected.origin.replace(/^http/, 'ws') : `ws://${host}`;
        const csp = headers['content-security-policy'].replace("connect-src 'self'", `connect-src 'self' ${socketOrigin}`);
        return reply(res, 200, await readFile(new URL(`../public/${file}`, import.meta.url)), `${type}; charset=utf-8`, { 'content-security-policy': csp });
      }
      if (method !== 'POST' || p !== '/console') return reply(res, 404, { error: 'Not found.' });
      if (req.headers.authorization) return reply(res, 401, { error: 'The optional console accepts browser sessions only. Import the Node library in your application.' });
      // Browsers cannot send application/json cross-site without a CORS preflight, which this server never grants.
      if (!/^application\/json(\s*;|$)/i.test(req.headers['content-type'] || '')) return reply(res, 415, { error: 'Console commands must be sent as application/json.' });
      const envelope = await readJson(req);
      if (typeof envelope.command !== 'string' || envelope.command.length > 250 || !['read','write'].includes(envelope.kind)) throw new Error('Invalid console command.');
      url = new URL('/' + envelope.command, 'http://localhost'); p = url.pathname;
      post = envelope.kind === 'write'; writes = post; method = post ? 'POST' : 'GET';
      const json = async () => envelope.input || {};
      if (p === '/health' && method === 'GET') return reply(res, 200, { ok: true, rpcRequired: false, mode: 'pepecoin-js-wallet', setupRequired: !store.users.length });
      if (post && ['/login','/register'].includes(p)) {
        const ip = req.socket.remoteAddress, cutoff = Date.now() - 60000;
        for (const [k, v] of attempts) if (!v.some(t => t > cutoff)) attempts.delete(k);
        const times = (attempts.get(ip) || []).filter(t => t > cutoff);
        if (times.length >= 10) return reply(res, 429, { error: 'Too many sign-in attempts. Wait one minute.' });
        attempts.set(ip, [...times, Date.now()]);
        const input = await json(req), accountName = normalizeAccountName(input.accountName);
        let user;
        if (p === '/register') {
          const work = registration.then(async () => {
            if (store.users.length && process.env.ALLOW_REGISTRATION !== '1') throw Object.assign(new Error('Public operator registration is disabled.'), { status: 403 });
            const salt = randomBytes(16), key = passwordKey(input.password, salt);
            try { return await store.create({ accountName, displayName: label(input.displayName || accountName), passwordSalt: salt.toString('base64url'), passwordHash: passwordHash(key).toString('base64url') }); }
            finally { key.fill(0); }
          });
          registration = work.catch(() => {});
          const created = await work; user = store.findById(created.id);
        } else user = store.findByAccountName(accountName);
        const key = password(user, input.password);
        try {
          if (user.encryptedPrivateKey) {
            const privateKey = decryptPrivateKey(user.encryptedPrivateKey, key);
            try {
              const wallet = walletFromPrivateKey(privateKey);
              if (wallet.address !== user.address) throw new Error('Legacy wallet address mismatch; migration stopped.');
              await service.watch(vault.create(user.id, `legacy:${user.accountName}`, user.displayName || user.accountName, wallet));
            } finally { privateKey.fill(0); }
          }
        } finally { key.fill(0); }
        for (const [t,s] of sessions) if (s.expires < Date.now()) sessions.delete(t);
        const token = randomBytes(32).toString('base64url'); sessions.set(token, { userId: user.id, expires: Date.now() + 8 * 3600000 });
        return reply(res, 200, { user: safeUser(user) }, undefined, { 'set-cookie': `pep_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=28800${expected?.protocol === 'https:' ? '; Secure' : ''}` });
      }
      if (post && p === '/logout') { const { token } = admin(req); sessions.delete(token); return reply(res, 200, { ok: true }, undefined, { 'set-cookie': 'pep_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }); }
      if (method === 'GET' && p === '/me') { const { user } = admin(req); return reply(res, 200, { user: safeUser(user) }); }
      if (method === 'GET' && p === '/status') { authorize(req); return reply(res, 200, { ...status, spendingLocked: vault.db.prepare("SELECT value FROM settings WHERE name='locked'").get()?.value === '1' }); }
      if (p === '/wallets') {
        const owner = authorize(req);
        if (method === 'GET') return reply(res, 200, { wallets: vault.list(owner) });
        if (post) { const b = await json(req); return reply(res, 200, { wallet: await service.create(owner, b.accountId, b.label) }); }
      }
      const match = p.match(/^\/wallets\/([a-f0-9-]+)(?:\/(addresses|quote|withdrawals|coins|receive)(?:\/([a-f0-9-]+)\/rebroadcast)?)?$/);
      if (match) {
        const [,id,action,withdrawalId] = match;
        const owner = authorize(req); vault.get(owner, id);
        if (method === 'GET' && !action) return reply(res, 200, await service.snapshot(owner, id, Number(url.searchParams.get('confirmations') || 6)));
        if (method === 'GET' && action === 'withdrawals') { const snap = await service.snapshot(owner, id); return reply(res, 200, { withdrawals: snap.withdrawals }); }
        if (post) {
          const b = await json(req);
          if (action === 'addresses') { const a = vault.addAddress(id, undefined, b.label || 'Receive address'); await service.index.watchIdentity(a.identity); return reply(res, 201, a); }
          if (action === 'quote') return reply(res, 200, await service.quote(owner, id, b));
          if (action === 'withdrawals') {
            reauth(req, b);
            return reply(res, 202, withdrawalId ? await service.rebroadcast(owner, id, withdrawalId) : await service.send(owner, id, b, b.requestId));
          }
          if (action === 'coins') {
            if (!Array.isArray(b.outpoints) || b.outpoints.length > 400 || typeof b.locked !== 'boolean') throw new Error('Provide coin outpoints and locked boolean.');
            for (const coin of b.outpoints) if (!/^[0-9a-f]{64}:\d{1,10}$/.test(coin)) throw new Error('Invalid outpoint.');
            vault.db.transaction(() => { for (const coin of b.outpoints) vault.db.prepare(b.locked ? 'INSERT OR IGNORE INTO coin_locks VALUES (?,?)' : 'DELETE FROM coin_locks WHERE walletId=? AND outpoint=?').run(id, coin); })();
            return reply(res, 200, { ok: true });
          }
          if (action === 'receive') {
            const a = vault.addresses(id).find(a => a.address === b.address) || vault.addresses(id)[0];
            const query = new URLSearchParams();
            if (b.amount) { ribbit(b.amount); query.set('amount', b.amount); }
            if (b.label) query.set('label', label(b.label));
            const uri = `pepecoin:${a.address}${query.size ? '?' + query : ''}`;
            return reply(res, 200, { address: a.address, uri, qr: await QRCode.toDataURL(uri, { width: 240, margin: 2 }) });
          }
        }
      }
      if (p.startsWith('/admin/')) {
        const { user } = admin(req), b = post ? await json(req) : {};
        if (p === '/admin/contacts') {
          if (method === 'GET') return reply(res,200,{contacts:vault.contacts(user.id)});
          if (post) { destinationScript(b.address); return reply(res,201,vault.saveContact(user.id,b.label,b.address)); }
        }
        if (p === '/admin/delete-contact' && post) { vault.db.prepare('DELETE FROM contacts WHERE owner=? AND id=?').run(user.id,b.id); return reply(res,200,{ok:true}); }
        if (p === '/admin/backup' && post) { reauth(req,b); return reply(res,200,vault.backup(user.id,b.passphrase)); }
        if (p === '/admin/restore' && post) { reauth(req,b); const result = vault.restore(user.id,b.backup,b.passphrase); for(const identity of vault.allIdentities()) await service.index.watchIdentity(identity); return reply(res,200,result); }
        if (p === '/admin/lock' && post) {
          reauth(req,b);
          const setting = name => vault.db.prepare('SELECT value FROM settings WHERE name=?').get(name)?.value;
          // The spending lock is vault-wide. Only the operator who engaged it may release it, so
          // another operator (e.g. one added with ALLOW_REGISTRATION=1) cannot override an incident lock.
          if (b.locked === false && setting('locked') === '1' && setting('locked-by') && setting('locked-by') !== user.id)
            throw Object.assign(new Error(setting('locked-by') === 'library' ? 'Spending was locked by the host application; unlock it there.' : 'Only the operator who locked spending can unlock it.'), { status: 403 });
          vault.db.transaction(() => {
            vault.db.prepare("INSERT OR REPLACE INTO settings VALUES ('locked',?)").run(b.locked === false ? '0' : '1');
            if (b.locked === false) vault.db.prepare("DELETE FROM settings WHERE name='locked-by'").run();
            else if (setting('locked-by') == null) vault.db.prepare("INSERT INTO settings VALUES ('locked-by',?)").run(user.id);
          })();
          return reply(res,200,{ok:true});
        }
        if (p === '/admin/import-key' && post) {
          reauth(req,b); vault.get(user.id,b.walletId);
          const wallet = importWif(b.wif);
          try { const a = vault.addAddress(b.walletId,wallet,b.label || 'Imported key',true); await service.index.watchIdentity(a.identity); return reply(res,201,a); }
          finally { wallet.privateKey.fill(0); }
        }
        if (p === '/admin/verify-message' && post) return reply(res,200,{valid:verifyMessage(b.address,b.message,b.signature)});
        if (post && ['/admin/export-key','/admin/sign-message'].includes(p)) {
          reauth(req,b); vault.get(user.id,b.walletId);
          if (vault.db.prepare("SELECT value FROM settings WHERE name='locked'").get()?.value === '1') throw new Error('Wallet spending is locked.');
          const a = vault.addresses(b.walletId).find(a => a.address === b.address);
          if (!a) throw new Error('Address not found.');
          const key = vault.signingKey(b.walletId,a.identity);
          try { return reply(res,200,p.endsWith('export-key') ? {wif:wif(key.privateKey,key.compressed)} : {signature:signMessage(key.privateKey,b.message,key.compressed)}); }
          finally { key.privateKey.fill(0); }
        }
      }
      reply(res,404,{error:'Not found.'});
    } catch (e) { reply(res,e.status || 400,{error:e.message || 'Request failed.'}); }
  };
  handler.changes = changes;
  /**
   * Enforce the configured Host, same-origin upgrade, and live browser session.
   * Called again during delivery so logout also revokes existing sockets.
   * @param {import("node:http").IncomingMessage} req - Original upgrade request.
   * @returns {{owner: string, expires: number}} Owner and expiry in Unix milliseconds.
   * @throws {Error} With status 401 or 403 when authorization fails.
   */
  handler.authorizeSocket = req => {
    const expected = publicOrigin ? new URL(publicOrigin) : null;
    const host = req.headers.host || '';
    if (req.headers.authorization || (expected ? host !== expected.host : !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) ||
        req.headers.origin !== (expected?.origin || `http://${host}`)) {
      throw Object.assign(new Error('Socket origin not allowed.'), { status: 403 });
    }
    const { user, token } = admin(req);
    if (!user) throw Object.assign(new Error('Sign in is required.'), { status: 401 });
    return { owner: user.id, expires: sessions.get(token).expires };
  };
  return handler;
}
