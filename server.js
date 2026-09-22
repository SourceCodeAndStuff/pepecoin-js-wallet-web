/**
 * Optional local wallet console entry point.
 * Opens the persistent runtime and starts public-peer sync after the HTTP listener is ready.
 */
// Optional local web console. Import index.js in your application; do not run this file.
import http from 'node:http';
import path from 'node:path';
import { UserStore } from './lib/store.js';
import { fileURLToPath } from 'node:url';
import { openWalletRuntime } from 'pepecoin-js-wallet/server';
import { walletHttp } from './lib/wallet-http.js';
import { attachWalletSockets } from './lib/wallet-sockets.js';

// Anchor the default to the original data directory, regardless of npm workspace cwd.
/**
 * Resolve DATA_DIR or the repository-level data directory, independent of workspace cwd.
 * @type {string}
 */
const dataDir = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : fileURLToPath(new URL('../data/', import.meta.url));
const store = new UserStore(dataDir);
await store.init();
const runtime = await openWalletRuntime({ dataDir, autoSync: false, rescan: process.argv.includes('--rescan'), extraIdentities: store.users.map(u => u.identity).filter(Boolean) });
const handler = walletHttp({ store, vault: runtime.vault, service: runtime.service, status: runtime.status });
const server = http.createServer(handler);
const sockets = attachWalletSockets(server, { handler, ...runtime });
server.requestTimeout = 30000; server.headersTimeout = 15000;
let closing;
/**
 * Stop sockets first, drain HTTP requests, then close the wallet runtime.
 * Repeated calls share the same shutdown promise.
 * @returns {Promise<void>} Resolves when console resources have closed.
 */
function close() {
  if (closing) return closing;
  closing = (async () => { await sockets.close(); await new Promise(resolve => server.close(resolve)); await runtime.close(); })();
  return closing;
}
server.on('error', error => { console.error(error.message); process.exitCode = 1; void close(); });
server.listen(Number(process.env.PORT || 3030), process.env.HOST || '127.0.0.1', () => {
  console.log('PepeCoin JS Wallet console ready. Import the Node.js library directly in your project.');
  runtime.startSync();
});
process.once('SIGINT', () => void close());
process.once('SIGTERM', () => void close());
