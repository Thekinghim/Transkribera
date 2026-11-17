// Enkel IndexedDB-lagring av föreläsningar. Nyckel: namn + storlek + lastModified.
const DB_NAME = 'transkribera';
const STORE = 'lectures';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const store = t.objectStore(STORE);
    let result;
    Promise.resolve(fn(store)).then(r => { result = r; });
    t.oncomplete = () => resolve(result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Transaktionen avbröts'));
  }));
}

function reqP(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export function fileKey(file) {
  return `${file.name}|${file.size}|${file.lastModified}`;
}

export const db = {
  get: (id) => tx('readonly', s => reqP(s.get(id))),
  put: (rec) => tx('readwrite', s => { s.put(rec); }),
  delete: (id) => tx('readwrite', s => { s.delete(id); }),
  all: () => tx('readonly', s => reqP(s.getAll())),
};

export async function requestPersistence() {
  try { if (navigator.storage?.persist) await navigator.storage.persist(); } catch {}
}
