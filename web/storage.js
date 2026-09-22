/* Multiple local projects, including media blobs. No credentials or object URLs on disk. */
window.VoiceCutStorage = (() => {
  function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('voicecut-projects', 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('projects')) {
          db.createObjectStore('projects', {keyPath: 'id'});
          return;
        }
        // Version 1 used out-of-line keys with a single 'current' record: migrate it.
        const tx = request.transaction;
        const store = tx.objectStore('projects');
        const get = store.get('current');
        get.onsuccess = () => {
          const legacy = get.result;
          db.deleteObjectStore('projects');
          const next = db.createObjectStore('projects', {keyPath: 'id'});
          if (legacy && legacy.project && Array.isArray(legacy.project.clips)) {
            const project = legacy.project;
            next.put({id: project.id || 'migrated-project', version: 2, modified: project.modified || Date.now(), project});
          }
        };
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('Close other VoiceCut tabs, then retry.'));
    });
  }
  async function transaction(mode, action) {
    const db = await open();
    try {
      return await new Promise((resolve, reject) => {
        const tx = db.transaction('projects', mode);
        const request = action(tx.objectStore('projects'));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error || request.error);
        tx.onabort = () => reject(tx.error || new Error('Save interrupted.'));
      });
    } finally { db.close(); }
  }
  function sanitize(project) {
    const data = structuredClone(project);
    data.videoUrl = null;
    if (data.originalAudio) data.originalAudio.enhancedUrl = null;
    (data.clips || []).forEach(c => { c.url = null; c.originalUrl = null; });
    return data;
  }
  function validate(record) {
    if (!record || record.version !== 2 || !record.project || !Array.isArray(record.project.clips) || !Array.isArray(record.project.segments)) throw new Error('Unsupported or damaged project snapshot.');
    return record.project;
  }
  return {
    async save(project) {
      project.modified = Date.now();
      await transaction('readwrite', store => store.put({id: project.id, version: 2, modified: project.modified, project: sanitize(project)}));
    },
    async list() {
      const records = await transaction('readonly', store => store.getAll());
      return records.map(r => ({id: r.id, name: r.project?.name || 'Untitled Project', duration: Number(r.project?.duration) || 0, modified: r.modified || 0}))
        .sort((a, b) => b.modified - a.modified);
    },
    async get(id) {
      return validate(await transaction('readonly', store => store.get(id)));
    },
    async rename(id, name) {
      const record = await transaction('readonly', store => store.get(id));
      const project = validate(record);
      project.name = name;
      project.modified = Date.now();
      await transaction('readwrite', store => store.put({id, version: 2, modified: project.modified, project: sanitize(project)}));
    },
    remove: id => transaction('readwrite', store => store.delete(id)),
    async load() {
      // Most recently modified project, for quick "Open Project".
      const records = await transaction('readonly', store => store.getAll());
      if (!records.length) return null;
      records.sort((a, b) => (b.modified || 0) - (a.modified || 0));
      return validate(records[0]);
    },
    clear: () => transaction('readwrite', store => store.clear())
  };
})();
