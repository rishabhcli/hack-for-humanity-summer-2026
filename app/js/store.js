/* =========================================================================
 * store.js — local session storage (IndexedDB).
 * Nothing here ever touches the network. There is no sync, no account, no
 * remote endpoint anywhere in this application.
 * ========================================================================= */

const DB_NAME = 'cervical-jpe';
const DB_VERSION = 1;
const STORE = 'sessions';

let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'id' });
        os.createIndex('startedAt', 'startedAt');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

const tx = async (mode, fn) => {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const os = t.objectStore(STORE);
    let result;
    try { result = fn(os); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
};

export async function saveSession(session) {
  await tx('readwrite', (os) => { os.put(session); });
  return session.id;
}

export async function listSessions() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readonly');
    const req = t.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result.sort((a, b) => a.startedAt - b.startedAt));
    req.onerror = () => reject(req.error);
  });
}

export async function clearSessions() {
  await tx('readwrite', (os) => { os.clear(); });
}

export async function deleteSession(id) {
  await tx('readwrite', (os) => { os.delete(id); });
}

export const newSessionId = () =>
  `s_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
