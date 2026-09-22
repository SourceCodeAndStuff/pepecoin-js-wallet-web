# PepeCoin JS Wallet — web app

This package contains only the optional browser UI, operator login store, HTTP command bridge and WebSocket server. It imports `pepecoin-js-wallet/server` from the separate wallet package; it does not duplicate wallet signing or sync code.

## Start

Use Node.js **24.13.0 or newer**. There is no Python or native build-tool requirement; the wallet package uses Node’s built-in SQLite.

For the separate private repositories, clone them into sibling `wallet/` and `web/` directories (GitHub access to both is required):

```sh
git clone https://github.com/SourceCodeAndStuff/pepecoin-js-wallet.git wallet
git clone https://github.com/SourceCodeAndStuff/pepecoin-js-wallet-web.git web
cd wallet
npm ci
cd ../web
npm ci
npm start
```

The web package references `file:../wallet`, so keep those sibling folder names. Its default data directory is `../data/`, outside both repositories. Set `DATA_DIR` to an absolute persistent directory on your server; never put real wallet data in Git.

If using the original combined workspace instead, deploy both directories with the root manifests and lockfile, then run from that workspace root:

```sh
npm ci
npm start
```

Alternatively run `npm start` inside `web/`. Both use the original root `data/` by default. Set `DATA_DIR` to an absolute path if storing data elsewhere. Stop the running server before restarting after an upgrade; never remove a live lock.

Settings: `HOST` (default `127.0.0.1`), `PORT` (3030), `DATA_DIR`, `PUBLIC_ORIGIN` for a trusted HTTPS reverse proxy, and opt-in `ALLOW_REGISTRATION=1`. Keep the operator console private. No credentials are written to the blockchain.

`npm run rescan` starts a fresh index while preserving the old index and wallet keys. This is an explicit recovery action, not part of normal startup.

## Live updates

The browser opens a native WebSocket connection to `/events` (`wss:` over HTTPS). The server uses [ws](https://github.com/websockets/ws) with authentication before upgrade, same-origin enforcement, disabled compression, bounded incoming messages and ping/pong liveness checks.

The socket only accepts `{ "type": "subscribe", "walletId": "..." }`. An empty wallet ID selects the operator's first wallet. The server validates ownership and pushes `{ type: 'snapshot', walletId, wallets, snapshot, network, contacts }`. It never includes private keys, raw signed transactions or login secrets. Updates are coalesced during fast sync. Slow clients are disconnected rather than given an unbounded send buffer.

Sync/block events and successful console writes trigger fresh snapshots. Logout and session expiry close sockets. Reconnection obtains the latest state and never repeats a payment. All tabs belonging to an operator update, and global spending-lock changes reach all authorized tabs. The browser has no periodic HTTP polling loop.

HTTP serves static assets and a private `POST /console` command bridge for explicit actions. `/api/*` remains absent. Socket subscriptions cannot authorize withdrawals; sensitive actions still require operator password confirmation.

For HTTPS proxying, forward WebSocket Upgrade/Connection headers and preserve the configured Host/Origin. `PUBLIC_ORIGIN` must match the visible HTTPS origin so cookies are Secure and socket authentication passes.

## Test and preview

```sh
npm test
npm run preview
```

Tests use isolated temporary vaults and never broadcast funds. Preview is a local synthetic fixture on port 3041, not a production mode.
