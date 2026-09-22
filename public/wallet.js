/**
 * Browser controller for the optional PepeCoin JS Wallet console.
 * Explicit actions use session-authenticated commands; live wallet and network state arrives over WebSocket.
 * Amounts displayed as PEPE use eight decimal places; integer storage amounts are ribbits.
 */
/**
 * Find a required element in the wallet template.
 * @param {string} id - Element ID.
 * @returns {HTMLElement|null} Matching DOM element.
 */
const $ = id => document.getElementById(id);
/**
 * Escape untrusted values before inserting them into HTML text or quoted attributes.
 * @param {*} value - Display value.
 * @returns {string} HTML-escaped text.
 */
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
/**
 * Abbreviate a public identifier for display, without changing its stored value.
 * @param {string} value - Address or transaction ID.
 * @returns {string} Abbreviated identifier or an em dash.
 */
const short = value => value ? `${value.slice(0,12)}…${value.slice(-8)}` : '—';
let user, wallets = [], current = '', snapshot, page = 'overview', setup = false, selectedCoins = [], historyLimit = 50, receiveUri = '', modalAction, noticeTimer;
const titles = { overview:'Overview', receive:'Receive', send:'Send', history:'Transactions', addresses:'Addresses & coins', contacts:'Address book', security:'Security & backup', network:'Network' };
/**
 * Show a transient status message using textContent.
 * @param {string} message - Human-readable notice.
 * @param {boolean} [error=false] - Apply error styling and a longer display duration.
 * @returns {void}
 */
function notice(message, error = false) { clearTimeout(noticeTimer); $('notice').textContent = message; $('notice').className = error ? 'error' : ''; $('notice').hidden = false; noticeTimer = setTimeout(() => $('notice').hidden = true, error ? 16000 : 7000); }
/**
 * Send an explicit browser command; no automatic retries or background polling.
 * @param {string} command - Console command path.
 * @param {object} [body] - Write input; omitting it selects a read command.
 * @param {object} [options] - Optional headers containing an idempotency-key mapped to requestId.
 * @returns {Promise<object>} Parsed successful response.
 * @throws {Error} On transport, JSON, or command failure.
 */
async function api(command, body, options = {}) {
  const input = body === undefined ? undefined : { ...body, ...(options.headers?.['idempotency-key'] ? { requestId: options.headers['idempotency-key'] } : {}) };
  const response = await fetch('/console', { method:'POST', headers:{'content-type':'application/json'}, credentials:'same-origin', body:JSON.stringify({command, kind:body === undefined ? 'read':'write', input}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed.');
  return data;
}
/**
 * Bind a form action, disabling buttons while it runs and reporting failures.
 * @param {string} id - Form element ID.
 * @param {function(object, SubmitEvent, HTMLFormElement): *} action - Receives named form values, event, and form.
 * @returns {void}
 */
function bindForm(id, action) {
  $(id).addEventListener('submit', async event => {
    event.preventDefault(); const form = event.currentTarget, buttons = [...form.querySelectorAll('button')];
    buttons.forEach(b => b.disabled = true);
    try { await action(Object.fromEntries(new FormData(form)), event, form); }
    catch (e) { notice(e.message,true); }
    finally { buttons.forEach(b => b.disabled = false); }
  });
}
/**
 * Bind a click action and surface synchronous or asynchronous errors as notices.
 * @param {string} id - Element ID.
 * @param {Function} action - Click operation.
 * @returns {void}
 */
function bind(id, action) { $(id).addEventListener('click', () => Promise.resolve().then(action).catch(e => notice(e.message,true))); }
/**
 * Render table markup; callers must escape untrusted values inside row HTML.
 * @param {string[]} headers - Plain-text column titles.
 * @param {string[]} rows - Already-safe table-row markup.
 * @param {string} [empty] - Message when no rows exist.
 * @returns {string} Table or empty-state HTML.
 */
function table(headers, rows, empty = 'Nothing here yet.') { return rows.length ? `<table><thead><tr>${headers.map(h => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.join('')}</tbody></table>` : `<div class="table-empty">${escapeHtml(empty)}</div>`; }
/**
 * Render an escaped status badge, distinguishing confirmed from pending states.
 * @param {string} state - Status label.
 * @returns {string} Badge markup.
 */
function badge(state) { return `<span class="badge ${state === 'confirmed' ? '' : 'pending'}">${escapeHtml(state)}</span>`; }
/**
 * Render an indexed transaction with its signed decimal PEPE net amount.
 * @param {object} t - Transaction summary with txid, Unix time, net, and confirmations.
 * @returns {string} Escaped transaction-row markup.
 */
function txRow(t) { return `<tr><td><span class="mono" title="${escapeHtml(t.txid)}">${escapeHtml(short(t.txid))}</span><br><small class="muted">${escapeHtml(new Date(t.time*1000).toLocaleString())}</small></td><td class="${t.net.startsWith('-') ? 'negative' : 'positive'}">${escapeHtml(t.net)} PEPE</td><td>${badge(t.confirmations >= 6 ? 'confirmed' : 'confirming')}</td><td>${t.confirmations}</td></tr>`; }
/**
 * Select a view, update navigation, and load contacts when entering the address book.
 * @param {string} next - Known view name.
 * @returns {void}
 */
function go(next) {
  page = next; $('page-title').textContent = titles[page];
  document.querySelectorAll('[data-page]').forEach(b => b.classList.toggle('active',b.dataset.page === page));
  const requiresWallet = !['contacts','security','network'].includes(page);
  document.querySelectorAll('[data-view]').forEach(s => s.hidden = s.dataset.view !== page || (!current && requiresWallet));
  $('empty').hidden = Boolean(current) || !requiresWallet;
  if (page === 'contacts') void loadContacts().catch(e => notice(e.message,true));
}
/**
 * Open the shared dialog with an explicit submit action.
 * @param {string} title - Plain-text heading.
 * @param {string} html - Trusted markup with any dynamic values already escaped.
 * @param {Function} action - Form submission callback.
 * @param {string} [submit="Confirm"] - Submit-button label.
 * @returns {void}
 */
function modal(title, html, action, submit = 'Confirm') {
  $('modal-title').textContent = title; $('modal-content').innerHTML = html; $('modal-submit').textContent = submit; modalAction = action; $('modal').showModal();
}
const passwordField = '<label>Operator password<input name="password" type="password" autocomplete="current-password" required></label>';
bindForm('modal-form', async (b,e) => { await modalAction(b,e); $('modal').close(); });
bind('modal-close', () => $('modal').close()); bind('modal-cancel', () => $('modal').close());
document.querySelectorAll('[data-page]').forEach(b => b.addEventListener('click',()=>go(b.dataset.page)));
document.querySelectorAll('[data-goto]').forEach(b => b.addEventListener('click',()=>go(b.dataset.goto)));
/**
 * Ask for a stable account ID, then create or retrieve its wallet.
 * @returns {void}
 */
function createAccount() { modal('Create an account wallet','<label>Unique account ID<input name="accountId" required maxlength="120" placeholder="account-123"></label><label>Display label<input name="label" maxlength="120" placeholder="Optional account name"></label><p class="fine">Repeating an account ID returns the same wallet. Keys stay in the local library vault.</p>',async b=> { const r = await api('wallets',b); await loadWallets(r.wallet.id); notice('Account wallet ready.'); },'Create wallet'); }
bind('new-wallet',createAccount); bind('empty-create',createAccount);
/**
 * Reload owned wallets, choose a selection, clear selection-specific fields, and request a live snapshot.
 * @param {string} [preferred=current] - Preferred wallet ID, if still available.
 * @returns {Promise<void>} Resolves after requesting, not receiving, the snapshot.
 */
async function loadWallets(preferred = current) {
  wallets = (await api('wallets')).wallets;
  current = wallets.find(w=>w.id === preferred)?.id || wallets[0]?.id || '';
  $('wallet-select').innerHTML = wallets.length ? wallets.map(w=>`<option value="${w.id}">${escapeHtml(w.label)}</option>`).join('') : '<option>No account wallets</option>';
  $('wallet-select').value = current;
  selectedCoins = []; receiveUri = ''; $('qr').hidden = true; $('copy-receive').disabled = true;
  $('receive-text').textContent = 'Generate a payment request to show its QR code.';
  $('sign-result').hidden = true; $('sign-result').textContent = '';
  await refresh(); go(page);
}
$('wallet-select').addEventListener('change',()=>loadWallets($('wallet-select').value).catch(e=>notice(e.message,true)));
/**
 * Show the authenticated console and initialize wallet selection and live updates.
 * @returns {Promise<void>} Resolves after initial wallet loading.
 */
async function enter() {
  $('auth').hidden = true; $('app').hidden = false; $('operator').textContent = user.accountName.slice(0,2).toUpperCase(); $('operator').title = user.accountName;
  connectUpdates();
  await loadWallets();
}
bindForm('login-form',async b=> { user = (await api(setup ? 'register' : 'login',b)).user; $('login-form').reset(); await enter(); });
bind('logout',async()=>{ await api('logout',{}); location.reload(); });
/**
 * Render pushed network state and only the snapshot matching the selected wallet.
 * A mismatched snapshot triggers a new subscription request instead of displaying another wallet.
 * @param {object} update - Socket snapshot envelope.
 * @returns {void}
 */
function renderUpdate(update) {
    const network = update.network;
    $('sync-state').textContent = network.state === 'synced' ? 'Up to date' : network.state;
    $('sync-height').textContent = `Block ${Math.max(network.height,0).toLocaleString()}`;
    const warnings = [];
    if (!network.lastSyncedAt || Date.now()-Date.parse(network.lastSyncedAt)>120000) warnings.push('Index is not yet up to date. Withdrawals are paused.');
    if (network.error) warnings.push(network.error);
    if (network.spendingLocked) warnings.push('Spending is locked by the operator.');
    const fields = { 'State':network.state, 'Indexed height':network.height, 'Peer height (median)':network.targetHeight ?? 'Unknown', 'Confirmed by independent peers':network.verifiedHeight ?? 'Not yet', 'Peer':network.peer || 'Discovering', 'Last caught up':network.lastSyncedAt || 'Not yet', 'Progress':network.progressPercent === null ? '—' : `${network.progressPercent}%` };
    $('network-details').innerHTML = Object.entries(fields).map(([k,v])=>`<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join('');
    if (current) {
      if (update.walletId !== current || !update.snapshot) { void refresh(); return; }
      snapshot = update.snapshot;
      if (snapshot.needsRescan) warnings.push('This wallet contains imported keys. Run a full rescan before using its balance.');
      for (const id of ['available','balance','reserved','immature']) $(id).textContent = snapshot[id] + (id === 'available' ? '' : ' PEPE');
      $('wallet-label').textContent = `${snapshot.wallet.label} · ${snapshot.wallet.accountId}`;
      const options = snapshot.addresses.map(a=>`<option value="${a.address}">${escapeHtml(a.label)} · ${escapeHtml(short(a.address))}</option>`).join('');
      for(const id of ['receive-address','sign-address']) { const old=$(id).value; $(id).innerHTML=options; if(snapshot.addresses.some(a=>a.address === old)) $(id).value=old; }
      $('recent').innerHTML = table(['Transaction','Net amount','Status','Confirmations'],snapshot.transactions.slice(0,5).map(txRow),'No indexed transactions yet. Share a receiving address to get started.');
      renderHistory(); renderCoins();
      $('addresses-table').innerHTML=table(['Label','Address','Index status'],snapshot.addresses.map(a=>`<tr><td>${escapeHtml(a.label)}</td><td class="mono">${escapeHtml(a.address)}</td><td>${badge(a.needsRescan ? 'rescan required':'watching')}</td></tr>`));
    }
    $('network-warning').hidden = !warnings.length; $('network-warning').textContent = warnings.join(' ');
}
/**
 * Render filtered transaction history and saved withdrawal relay states.
 * Rebroadcast actions retain the original transaction and require password confirmation.
 * @returns {void}
 */
function renderHistory() {
  if(!snapshot) return;
  const search=$('tx-search').value.toLowerCase(), rows=snapshot.transactions.filter(t=>t.txid.includes(search));
  $('history-table').innerHTML=table(['Transaction','Net amount','Status','Confirmations'],rows.slice(0,historyLimit).map(txRow));
  $('more-history').hidden=rows.length<=historyLimit;
  $('pending-table').innerHTML=table(['Request / transaction','Amount','Fee','State','Action'],snapshot.withdrawals.map(p=>`<tr><td title="${escapeHtml(p.txid)}">${escapeHtml(p.requestId)}<br><span class="mono">${escapeHtml(short(p.txid))}</span>${p.error?`<br><small title="${escapeHtml(p.error)}">Relay uncertain; inputs stay reserved</small>`:''}</td><td>${amount(p.amountKoinu)}</td><td>${amount(p.feeKoinu)}</td><td>${badge(p.state)}</td><td>${p.state!=='confirmed'?`<button class="quiet" data-rebroadcast="${p.id}">Rebroadcast same TX</button>`:'—'}</td></tr>`));
  document.querySelectorAll('[data-rebroadcast]').forEach(b=>b.addEventListener('click',()=>modal('Rebroadcast withdrawal','<p class="muted">This sends the exact saved transaction again. It does not create another payment.</p>'+passwordField,async input=>{ await api(`wallets/${current}/withdrawals/${b.dataset.rebroadcast}/rebroadcast`,input); await refresh(); notice('Rebroadcast attempted. Check its relay state.'); })));
}
/**
 * Format a nonnegative integer ribbit amount as decimal PEPE without floating-point rounding.
 * @param {string|bigint|number} v - Integer ribbits; numbers must already be exact.
 * @returns {string} PEPE amount with eight decimal places.
 */
function amount(v) { const n=BigInt(v); return `${n/100000000n}.${(n%100000000n).toString().padStart(8,'0')}`; }
$('tx-search').addEventListener('input',()=>{historyLimit=50;renderHistory();}); bind('more-history',()=>{historyLimit+=50;renderHistory();});
/**
 * Offer generated content as a browser download and release its object URL.
 * @param {string} name - Suggested filename.
 * @param {string} content - File contents.
 * @param {string} [type="application/json"] - MIME type.
 * @returns {void}
 */
function download(name,content,type='application/json') { const link=document.createElement('a'),url=URL.createObjectURL(new Blob([content],{type})); link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000); }
bind('export-history',()=>{ if(!snapshot) return; const cells=[['txid','height','confirmations','received_PEPE','spent_PEPE','net_PEPE'],...snapshot.transactions.map(t=>[t.txid,t.height,t.confirmations,t.received,t.spent,t.net])]; download('pepecoin-transactions.csv',cells.map(r=>r.join(',')).join('\r\n'),'text/csv'); });
/**
 * Open the address-creation dialog for the selected wallet.
 * @returns {Promise<void>} Resolves after showing the dialog, not after its submission.
 */
async function newAddress() { if(!current) return notice('Create an account wallet first.',true); modal('New receiving address','<label>Address label<input name="label" value="Receive address" required maxlength="120"></label>',async b=>{await api(`wallets/${current}/addresses`,b);await refresh();notice('New receiving address added.');}); }
bind('new-address',newAddress);bind('add-address',newAddress);
/**
 * Generate a payment URI and QR code on demand; creating a request does not move coins.
 */
bindForm('receive-form',async b=>{const r=await api(`wallets/${current}/receive`,b);receiveUri=r.uri;$('qr').src=r.qr;$('qr').hidden=false;$('receive-text').textContent=r.uri;$('copy-receive').disabled=false;});
bind('copy-receive',async()=>{await navigator.clipboard.writeText(receiveUri);notice('Payment URI copied.');});
/**
 * Append a destination/amount row while retaining at least one recipient row.
 * @returns {void}
 */
function addRecipient() { const row=document.createElement('div');row.className='recipient';row.innerHTML='<label>Destination address<input name="destination" placeholder="Pepecoin mainnet address" required></label><label>Amount (PEPE)<input name="amount" inputmode="decimal" placeholder="0.00000000" required></label><button type="button" aria-label="Remove recipient">✕</button>';row.querySelector('button').onclick=()=>{if($('recipients').children.length>1)row.remove();};$('recipients').append(row); }
addRecipient();bind('add-recipient',addRecipient);
/**
 * Quote the selected payment before asking for password authorization.
 * Capture the wallet, expected transaction ID, and one durable-in-dialog request ID
 * so retrying the same open confirmation dialog does not create a second withdrawal.
 */
bindForm('send-form',async (b,e,form)=>{
  const recipients=[...$('recipients').children].map(row=>({address:row.querySelector('[name=destination]').value.trim(),amount:row.querySelector('[name=amount]').value.trim()}));
  const payment={recipients,feeRate:b.feeRate,minConfirmations:Number(b.minConfirmations),sendAll:form.elements.sendAll.checked,selected:selectedCoins};
  const walletId=current,quote=await api(`wallets/${walletId}/quote`,payment),requestId=crypto.randomUUID();
  const html=`<p class="muted">Check every address. Pepecoin payments cannot be reversed.</p>${quote.recipients.map(r=>`<p class="mono wrap">${escapeHtml(r.address)}<br><strong>${escapeHtml(r.amount)} PEPE</strong></p>`).join('')}<dl><dt>Network fee</dt><dd>${amount(quote.feeKoinu)} PEPE</dd><dt>Change</dt><dd>${amount(quote.changeKoinu)} PEPE</dd></dl>${passwordField}<p class="fine">If this request times out, retry this same dialog; its request ID is retained.</p>`;
  modal('Authorize withdrawal',html,async input=>{
    const result=await api(`wallets/${walletId}/withdrawals`,{...payment,expectedTxid:quote.txid,password:input.password},{headers:{'idempotency-key':requestId}});
    $('withdrawal-result').hidden=false;$('withdrawal-result').textContent=`${result.state}: ${result.txid}. ${result.error || 'Waiting for a block confirmation.'}`;
    selectedCoins=[];await refresh();notice('Withdrawal saved. Its state is shown below.');
  },'Authorize & send');
});
$('send-form').elements.sendAll.addEventListener('change',e=>document.querySelectorAll('#recipients [name=amount]').forEach(i=>{i.required=!e.target.checked;}));
/**
 * Read selected outpoints from the coin-control table.
 * @returns {string[]} Outpoints in txid:vout form.
 */
function checkedCoins() { return [...document.querySelectorAll('[data-coin]:checked')].map(i=>i.dataset.coin); }
/**
 * Render indexed coins while preserving checked outpoints across live updates.
 * @returns {void}
 */
function renderCoins() {
  const checked=new Set(checkedCoins());
  $('coins-table').innerHTML=table(['Select','Outpoint','Amount (PEPE)','Confirmations','State'],snapshot.coins.map(c=>{const key=`${c.txid}:${c.vout}`;return `<tr><td><input type="checkbox" aria-label="Select ${escapeHtml(key)}" data-coin="${key}" ${checked.has(key)?'checked':''}></td><td class="mono" title="${key}">${short(c.txid)}:${c.vout}</td><td>${escapeHtml(c.amount)}</td><td>${c.confirmations}</td><td>${badge(c.reserved?'reserved / locked':c.immature?'immature':c.spendable?'available':'confirming')}</td></tr>`;}));
}
for(const locked of [true,false]) bind(locked?'lock-coins':'unlock-coins',async()=>{const outpoints=checkedCoins();if(!outpoints.length)throw new Error('Select coins first.');await api(`wallets/${current}/coins`,{outpoints,locked});await refresh();});
bind('use-coins',()=>{selectedCoins=checkedCoins();$('coin-selection').textContent=selectedCoins.length?`${selectedCoins.length} selected inputs will be used.`:'Automatic coin selection.';go('send');});
/**
 * Fetch and render the signed-in operator’s address book on demand.
 * @returns {Promise<void>}
 */
async function loadContacts() { const {contacts}=await api('admin/contacts'); renderContacts(contacts); }
/**
 * Render escaped contacts and bind send-prefill and removal actions.
 * @param {object[]} contacts - Owner-scoped contact records.
 * @returns {void}
 */
function renderContacts(contacts) {$('contacts-table').innerHTML=table(['Label','Address',''],contacts.map(c=>`<tr><td>${escapeHtml(c.label)}</td><td class="mono" title="${escapeHtml(c.address)}">${escapeHtml(short(c.address))}</td><td><button class="quiet" data-contact-send="${escapeHtml(c.address)}">Send</button> · <button class="quiet" data-contact-delete="${c.id}">Remove</button></td></tr>`));document.querySelectorAll('[data-contact-send]').forEach(b=>b.onclick=()=>{go('send');$('recipients').querySelector('[name=destination]').value=b.dataset.contactSend;});document.querySelectorAll('[data-contact-delete]').forEach(b=>b.onclick=()=>api('admin/delete-contact',{id:b.dataset.contactDelete}).then(loadContacts).catch(e=>notice(e.message,true))); }
bindForm('contact-form',async(b,e,f)=>{await api('admin/contacts',b);f.reset();await loadContacts();notice('Address saved.');});
/**
 * Download a password-authorized encrypted backup and clear the completed form.
 */
bindForm('backup-form',async(b,e,f)=>{const backup=await api('admin/backup',b);download('pepecoin-js-wallet-backup.json',JSON.stringify(backup,null,2));f.reset();notice('Encrypted backup downloaded. Store it offline with its passphrase.');});
/**
 * Validate backup size, restore with explicit credentials, and explain the required manual rescan.
 */
bindForm('restore-form',async(b,e,f)=>{const file=f.elements.file.files[0];if(file.size>5*1024*1024)throw new Error('Backup is too large.');const backup=JSON.parse(await file.text());const r=await api('admin/restore',{backup,passphrase:b.passphrase,password:b.password});f.reset();await loadWallets();notice(`Restored ${r.wallets} wallets. Stop the server and run npm run rescan.`,true);});
/**
 * Import a private key into the selected wallet and warn that historical balance needs a rescan.
 */
bindForm('import-form',async(b,e,f)=>{if(!current)throw new Error('Create an account wallet first.');await api('admin/import-key',{...b,walletId:current});f.reset();await refresh();notice('Key imported. Stop the server and run npm run rescan before using its balance.',true);});
/**
 * Require the operator password to change the vault-wide spending lock.
 */
bindForm('lock-form',async(b,e,f)=>{await api('admin/lock',{password:b.password,locked:e.submitter.value==='true'});f.reset();await refresh();notice('Spending lock updated.');});
/**
 * Request message signing or private-key export after reauthentication.
 * Clear the password field and display sensitive results as text, never as HTML.
 */
bindForm('sign-form',async(b,e,f)=>{if(!current)throw new Error('Select a wallet first.');const r=await api(`admin/${e.submitter.value}`,{...b,walletId:current});f.elements.password.value='';$('sign-result').textContent=r.wif?`PRIVATE KEY — anyone with this can spend your coins.\n${r.wif}`:r.signature;$('sign-result').hidden=false;});
/**
 * Verify a message signature without requesting or exposing private-key material.
 */
bindForm('verify-form',async b=>{const r=await api('admin/verify-message',b);$('verify-result').textContent=r.valid?'Signature is valid for this address and message.':'Signature is NOT valid.';});
/**
 * Select first-time setup or sign-in, then restore an existing browser session if available.
 * @returns {Promise<void>} Resolves after initializing the appropriate view.
 */
async function init() {
  const health=await api('health');setup=health.setupRequired;
  if(setup){$('auth-title').textContent='Set up your operator';$('auth-eyebrow').textContent='FIRST-TIME SETUP';$('auth-help').textContent='Create the local operator account. Wallet accounts are managed after signing in.';$('auth-submit').textContent='Create operator';$('login-form').elements.password.autocomplete='new-password';}
  try { user=(await api('me')).user; } catch { return; /* The sign-in form is the normal unauthenticated view. */ }
  await enter();
}
void init().catch(e=>notice(e.message,true));
// Authenticated push updates; no periodic HTTP balance/status polling.
let updatesSocket, reconnectTimer, reconnectAttempt = 0;
/**
 * Set the live-channel connection label.
 * @param {string} text - Connection status.
 * @returns {void}
 */
function liveState(text) { $('live-state').textContent = text; }
/**
 * Open one same-origin socket and subscribe on connection.
 * Retry transport failures with capped exponential backoff; session expiry returns to sign-in.
 * @returns {void}
 */
function connectUpdates() {
  if (!user || (updatesSocket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(updatesSocket.readyState))) return;
  clearTimeout(reconnectTimer);
  const url = new URL('/events', location.href); url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = updatesSocket = new WebSocket(url);
  liveState('Connecting live updates…');
  socket.onopen = () => { reconnectAttempt = 0; liveState('Live updates connected'); void refresh(); };
  socket.onmessage = event => {
    if (socket !== updatesSocket || !user) return;
    try {
      const update = JSON.parse(event.data); if (update.type !== 'snapshot') return;
      wallets = update.wallets;
      current = wallets.find(w => w.id === current)?.id || wallets[0]?.id || '';
      $('wallet-select').innerHTML = wallets.length ? wallets.map(w => `<option value="${w.id}">${escapeHtml(w.label)}</option>`).join('') : '<option>No account wallets</option>';
      $('wallet-select').value = current;
      renderUpdate(update);
      if (page === 'contacts') renderContacts(update.contacts);
      goViewOnly();
    } catch (error) { notice(error.message, true); }
  };
  socket.onclose = event => {
    if (socket !== updatesSocket) return;
    updatesSocket = null;
    if (event.code === 4401) {
      user = null; $('app').hidden = true; $('auth').hidden = false;
      notice('Your session expired. Sign in again.', true); return;
    }
    if (!user) return;
    liveState('Live updates disconnected — reconnecting…');
    reconnectTimer = setTimeout(connectUpdates, Math.min(30000, 1000 * 2 ** Math.min(reconnectAttempt++, 5)));
  };
  socket.onerror = () => liveState('Live update connection interrupted');
}
/**
 * Request the current wallet snapshot through the socket, opening a connection if needed.
 * @returns {Promise<void>} Resolves after scheduling/sending, not when the snapshot arrives.
 */
async function refresh() {
  if (!user) return;
  if (updatesSocket?.readyState === WebSocket.OPEN) updatesSocket.send(JSON.stringify({ type: 'subscribe', walletId: current }));
  else connectUpdates();
}
/**
 * Reapply view visibility after a push without triggering additional HTTP requests.
 * @returns {void}
 */
function goViewOnly() {
  const requiresWallet = !['contacts','security','network'].includes(page);
  document.querySelectorAll('[data-view]').forEach(s => s.hidden = s.dataset.view !== page || (!current && requiresWallet));
  $('empty').hidden = Boolean(current) || !requiresWallet;
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && user) void refresh(); });
