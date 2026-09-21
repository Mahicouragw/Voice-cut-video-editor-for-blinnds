/* One local project, including media blobs. No credentials or object URLs on disk. */
window.VoiceCutStorage = (() => {
  function open() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('voicecut-projects', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('projects');
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
  return {
    async save(project) {
      const data = structuredClone(project);
      data.videoUrl = null;
      data.originalAudio.enhancedUrl = null;
      data.clips.forEach(c => { c.url = null; c.originalUrl = null; });
      await transaction('readwrite', store => store.put({ version: 1, project: data }, 'current'));
    },
    async load() {
      const record = await transaction('readonly', store => store.get('current'));
      if (!record) return null;
      if (record.version !== 1 || !Array.isArray(record.project?.clips) || !Array.isArray(record.project?.segments)) throw new Error('Unsupported or damaged project snapshot.');
      return record.project;
    },
    clear: () => transaction('readwrite', store => store.delete('current'))
  };
})();
