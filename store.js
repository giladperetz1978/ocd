(() => {
  'use strict';
  const STORES = ['projects', 'sources', 'searches', 'reports'];
  const KEYS = {projects: 'id', sources: 'key', searches: 'id', reports: 'id'};
  let opening;

  function open() {
    opening = opening || new Promise((ok, no) => {
      const r = indexedDB.open('ocd-evidence-lab', 1);
      r.onupgradeneeded = () => {
        const d = r.result;
        for (const name of STORES) {
          const s = d.createObjectStore(name, {keyPath: KEYS[name]});
          if (name !== 'projects') s.createIndex('project', 'projectId');
        }
      };
      r.onsuccess = () => ok(r.result);
      r.onerror = () => no(r.error);
      r.onblocked = () => no(new Error('מסד הנתונים חסום על ידי לשונית אחרת.'));
    });
    return opening;
  }
  const req = r => new Promise((ok, no) => { r.onsuccess = () => ok(r.result); r.onerror = () => no(r.error); });

  async function run(names, mode, fn) {
    const d = await open();
    const t = d.transaction(names, mode);
    const done = new Promise((ok, no) => { t.oncomplete = ok; t.onerror = () => no(t.error); t.onabort = () => no(t.error || new Error('הפעולה בוטלה')); });
    const result = await fn(t);
    await done;
    return result;
  }

  const put = (name, obj) => run([name], 'readwrite', t => req(t.objectStore(name).put(obj)));
  const del = (name, key) => run([name], 'readwrite', t => req(t.objectStore(name).delete(key)));
  const all = name => run([name], 'readonly', t => req(t.objectStore(name).getAll()));
  const byProject = (name, pid) => run([name], 'readonly', t => req(t.objectStore(name).index('project').getAll(pid)));

  function deleteProject(pid) {
    return run(STORES, 'readwrite', t => {
      t.objectStore('projects').delete(pid);
      for (const name of STORES.slice(1)) {
        const c = t.objectStore(name).index('project').openCursor(IDBKeyRange.only(pid));
        c.onsuccess = () => { const cur = c.result; if (cur) { cur.delete(); cur.continue(); } };
      }
    });
  }

  async function exportAll() {
    const out = {format: 'ocd-evidence-lab', version: 1, exportedAt: new Date().toISOString()};
    for (const name of STORES) out[name] = await all(name);
    return out;
  }

  const isStr = (v, max = 2_000_000) => typeof v === 'string' && v.length <= max;
  const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
  function validate(data) {
    if (!isObj(data) || data.format !== 'ocd-evidence-lab' || data.version !== 1) throw new Error('הקובץ אינו גיבוי של מעבדת המחקר.');
    for (const name of STORES) {
      if (!Array.isArray(data[name])) throw new Error('חסר אוסף ' + name + ' בגיבוי.');
      for (const item of data[name]) {
        if (!isObj(item) || !isStr(item[KEYS[name]], 500)) throw new Error('רשומה לא תקינה באוסף ' + name + '.');
        if (name === 'projects' && !isStr(item.name, 200)) throw new Error('שם פרויקט לא תקין.');
        if (name !== 'projects' && !isStr(item.projectId, 200)) throw new Error('רשומה ללא פרויקט באוסף ' + name + '.');
        if (name === 'sources' && (!isStr(item.id, 200) || !isStr(item.title, 5000) || item.key !== item.projectId + '|' + item.id)) throw new Error('מקור לא תקין בגיבוי.');
      }
    }
    const pids = new Set(data.projects.map(p => p.id));
    for (const name of STORES.slice(1)) if (data[name].some(i => !pids.has(i.projectId))) throw new Error('בגיבוי יש רשומות שמשויכות לפרויקט שאינו קיים.');
  }

  async function importAll(data) {
    validate(data);
    await run(STORES, 'readwrite', t => { for (const name of STORES) for (const item of data[name]) t.objectStore(name).put(item); });
    return STORES.reduce((n, name) => n + data[name].length, 0);
  }

  window.Lab = Object.assign(window.Lab || {}, {store: {put, del, all, byProject, deleteProject, exportAll, importAll, validate}});
})();
