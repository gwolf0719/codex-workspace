import { DatabaseSync } from 'node:sqlite';

export function createStore(path) {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS records (
      collection TEXT NOT NULL,
      id TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (collection, id)
    );
  `);
  const read = db.prepare('SELECT data FROM records WHERE collection = ? AND id = ?');
  const list = db.prepare('SELECT data FROM records WHERE collection = ? ORDER BY rowid');
  const put = db.prepare('INSERT INTO records VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET data = excluded.data');
  const remove = db.prepare('DELETE FROM records WHERE collection = ? AND id = ?');
  return {
    get: (collection, id) => {
      const record = read.get(collection, id);
      return record && JSON.parse(record.data);
    },
    list: (collection) => list.all(collection).map(({ data }) => JSON.parse(data)),
    put: (collection, record) => { put.run(collection, record.id, JSON.stringify(record)); return record; },
    remove: (collection, id) => remove.run(collection, id),
    close: () => db.close(),
  };
}
