/**
 * Local operator credential storage for the optional web console.
 * Records may contain legacy encrypted wallet keys; only publicUser output is safe to expose.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Persist operator records separately from the blockchain and wallet vault.
 */
export class UserStore {
  /**
   * @param {string} [dir="./data"] - Directory containing users.json.
   */
  constructor(dir = './data') { this.dir = path.resolve(dir); this.file = path.join(this.dir, 'users.json'); this.users = []; }
  /**
   * Load records, initialize a missing file, and migrate legacy account metadata.
   * @returns {Promise<void>}
   * @throws {Error} If an existing file cannot be read or is not a JSON array.
   */
  async init() {
    await mkdir(this.dir, { recursive: true });
    try { this.users = JSON.parse(await readFile(this.file, 'utf8')); if (!Array.isArray(this.users)) throw new Error('Invalid users file.'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.users = []; await this.flush(); }
    let migrated = false;
    for (const user of this.users) {
      if (!user.accountName) { user.accountName = user.id; migrated = true; }
      if (Object.hasOwn(user, 'email')) { delete user.email; migrated = true; }
    }
    if (migrated) await this.flush();
  }
  /**
   * Queue an atomic file replacement with the current in-memory snapshot.
   * A failed save rejects its caller without preventing subsequent saves.
   * @returns {Promise<void>} Resolves after this snapshot is persisted.
   */
  async flush() {
    const contents = `${JSON.stringify(this.users, null, 2)}\n`;
    const save = (this.writeQueue || Promise.resolve()).then(async () => {
      const temp = `${this.file}.tmp`;
      await writeFile(temp, contents, { mode: 0o600 });
      await rename(temp, this.file);
    });
    this.writeQueue = save.catch(() => {});
    await save;
  }
  /**
   * Find an internal record, including credential fields; do not expose it to clients.
   * @param {string} accountName - Already-normalized account name.
   * @returns {object|null} Matching mutable record.
   */
  findByAccountName(accountName) { return this.users.find(user => user.accountName === accountName) || null; }
  /**
   * Find an internal credential record by operator ID.
   * @param {string} id - Operator ID.
   * @returns {object|null} Matching mutable record.
   */
  findById(id) { return this.users.find(user => user.id === id) || null; }
  /**
   * Select public account metadata without password hashes or encrypted keys.
   * @param {object} user - Internal operator record.
   * @returns {object} Public metadata.
   */
  publicUser(user) { return { id: user.id, accountName: user.accountName, displayName: user.displayName, address: user.address, identity: user.identity, createdAt: user.createdAt }; }
  /**
   * Add and persist an operator; the caller validates names and derives password fields.
   * @param {object} input - Account metadata, password verifier, and optional legacy key fields.
   * @param {string} input.accountName - Unique normalized account name.
   * @param {string} input.displayName - Display label.
   * @param {string} input.passwordSalt - Base64url password salt.
   * @param {string} input.passwordHash - Base64url password verifier.
   * @param {string} [input.encryptedPrivateKey] - Optional legacy encrypted key envelope.
   * @param {string} [input.address] - Legacy receiving address.
   * @param {string} [input.identity] - Legacy public-key hash.
   * @returns {Promise<object>} Public metadata for the persisted operator.
   */
  async create({ accountName, displayName, passwordSalt, passwordHash, encryptedPrivateKey, address, identity }) {
    if (this.findByAccountName(accountName)) throw new Error('That account name is already in use.');
    const user = { id: randomBytes(16).toString('hex'), accountName, displayName, passwordSalt, passwordHash, encryptedPrivateKey, address, identity, createdAt: new Date().toISOString() };
    this.users.push(user); await this.flush(); return this.publicUser(user);
  }
}
