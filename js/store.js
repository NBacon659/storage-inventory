/* IndexedDB persistence: items, photo blobs, and a cache of UPC lookups. */
(function () {
  const DB_NAME = "storage-inventory";
  const DB_VER = 1;
  let dbp = null;

  function open() {
    if (dbp) return dbp;
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("items")) db.createObjectStore("items", { keyPath: "id" });
        if (!db.objectStoreNames.contains("photos")) db.createObjectStore("photos", { keyPath: "id" });
        if (!db.objectStoreNames.contains("lookups")) db.createObjectStore("lookups", { keyPath: "upc" });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error("Close other tabs of this app and reload."));
    });
    return dbp;
  }

  async function tx(store, mode, fn) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      const r = fn(s);
      if (r && "onsuccess" in r) r.onsuccess = () => { out = r.result; };
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error || new Error("Storage write was aborted (phone storage may be full)."));
    });
  }

  const Store = {
    allItems: () => tx("items", "readonly", s => s.getAll()),
    putItem: item => tx("items", "readwrite", s => s.put(item)),
    deleteItem: id => tx("items", "readwrite", s => s.delete(id)),
    getPhoto: id => tx("photos", "readonly", s => s.get(id)),
    putPhoto: rec => tx("photos", "readwrite", s => s.put(rec)),
    deletePhoto: id => tx("photos", "readwrite", s => s.delete(id)),
    getLookup: upc => tx("lookups", "readonly", s => s.get(upc)),
    putLookup: rec => tx("lookups", "readwrite", s => s.put(rec)),
    clearLookups: () => tx("lookups", "readwrite", s => s.clear()),
    /** id -> cropped flag for every stored photo (blobs aren't read). */
    async photoFlags() {
      const all = await tx("photos", "readonly", s => s.getAll());
      return new Map((all || []).map(r => [r.id, !!r.cropped]));
    },
    async clearAll() {
      await tx("items", "readwrite", s => s.clear());
      await tx("photos", "readwrite", s => s.clear());
    },
    async storageInfo() {
      const out = { persisted: null, usage: null, quota: null };
      try { if (navigator.storage && navigator.storage.persisted) out.persisted = await navigator.storage.persisted(); } catch (e) {}
      try { if (navigator.storage && navigator.storage.estimate) { const e = await navigator.storage.estimate(); out.usage = e.usage; out.quota = e.quota; } } catch (e) {}
      return out;
    },
    async requestPersist() {
      try { if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist(); } catch (e) {}
      return false;
    }
  };

  window.Store = Store;
})();
