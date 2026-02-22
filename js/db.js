const DB_NAME = 'master-control-center-budget';
const DB_VERSION = 1;

const STORES = [
  'accounts',
  'categories',
  'scheduledItems',
  'scheduledOverrides',
  'transactions',
  'matchRules',
  'scenarios',
  'scenarioOverrides',
  'settings',
  'auditLog',
];

export function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const store of STORES) {
        if (!db.objectStoreNames.contains(store)) {
          db.createObjectStore(store, { keyPath: 'id' });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txPromise(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getAll(db, storeName) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

export async function putMany(db, storeName, items) {
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  items.forEach((i) => store.put(i));
  await txPromise(tx);
}

export async function putOne(db, storeName, item) {
  await putMany(db, storeName, [item]);
}

export async function deleteOne(db, storeName, id) {
  const tx = db.transaction(storeName, 'readwrite');
  tx.objectStore(storeName).delete(id);
  await txPromise(tx);
}

export async function clearAll(db) {
  for (const storeName of STORES) {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).clear();
    await txPromise(tx);
  }
}

export async function exportAll(db) {
  const data = {};
  for (const store of STORES) {
    data[store] = await getAll(db, store);
  }
  return { exportedAt: new Date().toISOString(), data };
}

export async function importAll(db, payload) {
  await clearAll(db);
  for (const store of STORES) {
    const items = payload?.data?.[store] || [];
    if (items.length) await putMany(db, store, items);
  }
}
