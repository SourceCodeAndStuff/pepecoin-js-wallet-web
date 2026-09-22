/**
 * Read-only WebSocket snapshots for authenticated console sessions.
 * Subscriptions select owned wallets; this channel never accepts spending commands.
 */
import { WebSocketServer, WebSocket } from 'ws';

// A read-only, session-authenticated push channel. Spending is never accepted here.
/**
 * Attach session-authenticated /events upgrades and live snapshot notifications.
 * @param {import("node:http").Server} server - Console HTTP server.
 * @param {object} options - Console dependencies and scheduling intervals.
 * @param {Function} options.handler - HTTP handler exposing changes and authorizeSocket.
 * @param {object} options.vault - Owner-scoped wallet and contact storage.
 * @param {object} options.service - Wallet snapshot service.
 * @param {object} options.status - Mutable network status.
 * @param {import("node:events").EventEmitter} options.events - Runtime sync/block events.
 * @param {number} [options.throttleMs=250] - Snapshot coalescing delay in milliseconds.
 * @param {number} [options.heartbeatMs=30000] - Ping interval in milliseconds.
 * @returns {{close: function(): Promise<void>}} Idempotent shutdown handle.
 */
export function attachWalletSockets(server, { handler, vault, service, status, events, throttleMs = 250, heartbeatMs = 30000 }) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096, perMessageDeflate: false });
  const clients = new Map();
  let closed = false;
  const jobs = new Set();
  /**
   * Revalidate the original upgrade session and its owner on every use.
   * @param {object} client - Connected client state.
   * @returns {boolean} Whether the session still belongs to this client.
   */
  function authenticated(client) {
    try { return handler.authorizeSocket(client.req).owner === client.owner; }
    catch { return false; }
  }
  /**
   * Mark a client dirty and coalesce updates without overlapping snapshot jobs.
   * @param {object} client - Connected client state.
   * @returns {void}
   */
  function schedule(client) {
    client.dirty = true;
    if (closed || client.timer || client.running || client.ws.readyState !== WebSocket.OPEN) return;
    client.timer = setTimeout(() => {
      client.timer = null;
      const job = push(client); jobs.add(job);
      void job.finally(() => jobs.delete(job));
    }, throttleMs);
  }
  /**
   * Build an owner-scoped snapshot and recheck session and subscription after I/O.
   * Slow consumers are disconnected; stale selections are rescheduled.
   * @param {object} client - Connected client state.
   * @returns {Promise<void>} Resolves after sending, skipping, or closing the socket.
   */
  async function push(client) {
    client.running = true; client.dirty = false;
    try {
      if (!authenticated(client)) { client.ws.close(4401, 'Session expired'); return; }
      if (client.ws.bufferedAmount > 1024 * 1024) { client.ws.terminate(); return; }
      const revision = client.revision;
      const wallets = vault.list(client.owner);
      const walletId = client.walletId || wallets[0]?.id || '';
      const snapshot = walletId ? await service.snapshot(client.owner, walletId) : null;
      // Recheck after awaiting the index: logout or a new selection may have happened.
      if (closed || client.ws.readyState !== WebSocket.OPEN) return;
      if (!authenticated(client)) { client.ws.close(4401, 'Session expired'); return; }
      if (revision !== client.revision) { client.dirty = true; return; }
      client.ws.send(JSON.stringify({ type: 'snapshot', walletId, wallets, snapshot,
        network: { ...status, spendingLocked: vault.db.prepare("SELECT value FROM settings WHERE name='locked'").get()?.value === '1' },
        contacts: vault.contacts(client.owner) }));
    } catch {
      // Never expose SQL, signing material, or another operator's data on the channel.
      if (client.ws.readyState === WebSocket.OPEN) client.ws.close(1011, 'Unable to refresh wallet state');
    } finally {
      client.running = false;
      if (client.dirty) schedule(client);
    }
  }
  /**
   * Invalidate all live snapshots after a console write or runtime event.
   * @returns {void}
   */
  const changed = () => {
    for (const client of clients.values()) {
      if (!authenticated(client)) client.ws.close(4401, 'Session expired');
      else schedule(client);
    }
  };
  /**
   * Authorize an upgrade, enforce connection limits, and bind subscription validation.
   * @param {import("node:http").IncomingMessage} req - Upgrade request.
   * @param {import("node:net").Socket} socket - Raw TCP connection.
   * @param {Buffer} head - Bytes already read after the HTTP headers.
   * @returns {void}
   */
  const upgrade = (req, socket, head) => {
    socket.on('error', () => {});
    try {
      if (closed || req.url !== '/events') throw Object.assign(new Error(), { status: 404 });
      const auth = handler.authorizeSocket(req);
      if (clients.size >= 100 || [...clients.values()].filter(c => c.owner === auth.owner).length >= 5) {
        throw Object.assign(new Error(), { status: 429 });
      }
      wss.handleUpgrade(req, socket, head, ws => {
        const client = { ws, req, owner: auth.owner, walletId: '', revision: 0, alive: true, dirty: false, running: false, timer: null };
        clients.set(ws, client);
        const expiry = setTimeout(() => ws.close(4401, 'Session expired'), Math.max(0, auth.expires - Date.now()));
        expiry.unref();
        ws.on('error', () => {});
        ws.on('pong', () => { client.alive = true; });
        ws.on('message', (bytes, binary) => {
          if (!authenticated(client)) { ws.close(4401, 'Session expired'); return; }
          try {
            const message = JSON.parse(bytes.toString());
            if (binary || message.type !== 'subscribe' || typeof message.walletId !== 'string' || message.walletId.length > 100) throw new Error();
            if (message.walletId) vault.get(client.owner, message.walletId);
            client.walletId = message.walletId; client.revision++;
            schedule(client);
          } catch { ws.close(4400, 'Invalid wallet subscription'); }
        });
        ws.on('close', () => { clearTimeout(client.timer); clearTimeout(expiry); clients.delete(ws); });
        schedule(client);
      });
    } catch (error) {
      const code = [401, 403, 404, 429].includes(error.status) ? error.status : 401;
      socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    }
  };
  server.on('upgrade', upgrade);
  handler.changes.on('change', changed);
  events.on('sync', changed); events.on('block', changed);
  /**
   * Check session validity and ping responsiveness; this is transport liveness, not balance polling.
   * @type {NodeJS.Timeout}
   */
  const heartbeat = setInterval(() => {
    for (const client of clients.values()) {
      if (!authenticated(client)) { client.ws.close(4401, 'Session expired'); continue; }
      if (!client.alive) { client.ws.terminate(); continue; }
      client.alive = false; client.ws.ping();
    }
  }, heartbeatMs);
  heartbeat.unref();
  let closePromise;
  /**
   * Return a shutdown handle that removes event hooks, terminates sockets,
   * and waits for all outstanding snapshot jobs before resolving.
   */
  return { close() {
    if (closePromise) return closePromise;
    closed = true; clearInterval(heartbeat);
    server.off('upgrade', upgrade); handler.changes.off('change', changed);
    events.off('sync', changed); events.off('block', changed);
    for (const client of clients.values()) { clearTimeout(client.timer); client.ws.terminate(); }
    closePromise = (async () => {
      await new Promise(resolve => wss.close(resolve));
      await Promise.allSettled([...jobs]);
    })();
    return closePromise;
  } };
}
