/**
 * Isolated UI preview with temporary keys, synthetic history, and disabled transaction relay.
 * Auto-authentication is for this loopback fixture only; never use it as a production server.
 */
// Isolated UI fixture: temporary keys, synthetic balances, NO network relay.
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { UserStore } from '../lib/store.js';
import { WalletVault, WalletService, passwordKey, passwordHash } from 'pepecoin-js-wallet/server';
import { walletHttp } from '../lib/wallet-http.js';
import { EventEmitter } from 'node:events';
import { attachWalletSockets } from '../lib/wallet-sockets.js';

const dir=await mkdtemp(path.join(os.tmpdir(),'pepe-ui-preview-'));
const store=new UserStore(dir);await store.init();
const salt=randomBytes(16),password='preview-only-not-real',key=passwordKey(password,salt);
const user=await store.create({accountName:'preview',displayName:'Preview',passwordSalt:salt.toString('base64url'),passwordHash:passwordHash(key).toString('base64url')});
const vault=new WalletVault(dir),wallet=vault.create(user.id,'account-1042','Account 1042');
const identity=wallet.addresses[0].identity;
/**
 * Synthetic caught-up network state with an explicit preview warning.
 */
const status={state:'synced',height:1218500,targetHeight:1218500,verifiedHeight:1218500,progressPercent:100,peer:'Public-peer preview',lastSyncedAt:new Date().toISOString(),error:'UI PREVIEW — synthetic balances, temporary addresses, no real transaction broadcasting.'};
/**
 * In-memory index fixture returning fabricated coins and history for the preview identity.
 * Stored amount fields are integer ribbits, despite legacy Koinu field names.
 */
const index={watchIdentity:async()=>{},walletSnapshot:async ids=>({height:1218500,legacyPending:[],utxos:ids.includes(identity)?[{identity,txid:'aa'.repeat(32),vout:0,height:1218400,coinbase:0,valueKoinu:'1245000000000'}]:[],transactions:ids.includes(identity)?[0,1,2,3].map((n)=>({identity,txid:String(n+1).repeat(64),height:1218480-n*100,time:Math.floor(Date.now()/1000)-n*3600,receivedKoinu:String((n+1)*250000000),spentKoinu:n===2?'900000000':'0'})):[]})};
/**
 * Use the real wallet service with a relay callback that always rejects.
 */
const service=new WalletService({vault,index,status,broadcast:async()=>{throw new Error('Preview never broadcasts transactions.');}});
const handler=walletHttp({store,vault,service,status});let cookie='';
/**
 * Inject the fixture session into loopback HTTP requests to bypass manual preview login.
 */
const server=http.createServer((req,res)=>{if(cookie)req.headers.cookie=cookie;return handler(req,res);});
const live = attachWalletSockets(server, { handler, vault, service, status, events: new EventEmitter() });
// The isolated preview auto-authenticates both HTTP and socket requests.
server.prependListener('upgrade', req => { if (cookie) req.headers.cookie = cookie; });
await new Promise(resolve=>server.listen(3041,'127.0.0.1',resolve));
const login=await fetch('http://127.0.0.1:3041/console',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({command:'login',kind:'write',input:{accountName:'preview',password}})});
cookie=login.headers.get('set-cookie').split(';')[0];
console.log('Isolated wallet UI preview: http://127.0.0.1:3041');
/**
 * On interruption, close socket clients before the HTTP listener and temporary vault.
 */
process.once('SIGINT',()=>{void live.close().then(() => {server.closeAllConnections();server.close();vault.close();});});
