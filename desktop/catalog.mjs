import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, realpathSync, statSync } from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const PHOTO_EXTENSIONS = new Set([
  '.jpg', '.jpeg', '.jpe', '.png', '.tif', '.tiff', '.webp', '.avif', '.heic', '.heif', '.hif',
  '.raw', '.dng', '.cr2', '.cr3', '.crw', '.nef', '.nrw', '.arw', '.sr2', '.srf',
  '.raf', '.orf', '.rw2', '.rwl', '.pef', '.ptx', '.3fr', '.fff', '.iiq', '.kdc',
  '.mos', '.mrw', '.x3f', '.erf', '.mef', '.mdc', '.srw', '.dcr', '.bay', '.cap',
]);

const ORDER = Object.freeze({
  added: 'added_at DESC, rowid DESC',
  oldest: 'added_at ASC, rowid ASC',
  name: 'name COLLATE NOCASE ASC, id ASC',
  rating: 'rating DESC, name COLLATE NOCASE ASC, id ASC',
});

const FILTER = Object.freeze({
  all: '1',
  picked: 'picked = 1',
  edited: 'edited = 1',
  unpicked: 'picked = 0',
  unrated: 'rating = 0',
  rated: 'rating > 0',
});

const DEFAULTS = Object.freeze({ contrast: 1, saturation: 1, cropRatio: 0, cropX: 0.5, cropY: 0.5 });
const UPDATE_COLUMNS = new Set(['adjustments', 'rating', 'picked', 'width', 'height']);

function normalizeAdjustments(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Les réglages doivent être un objet.');
  }
  const seen = new Set();
  function copy(entry, depth = 0) {
    if (depth > 12) throw new TypeError('Les réglages sont trop complexes.');
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean') return entry;
    if (typeof entry === 'number' && Number.isFinite(entry)) return entry;
    if (!entry || typeof entry !== 'object' || seen.has(entry)) {
      throw new TypeError('Les réglages contiennent une valeur non valide.');
    }
    seen.add(entry);
    let result;
    if (Array.isArray(entry)) {
      result = entry.map(item => copy(item, depth + 1));
    } else {
      const prototype = Object.getPrototypeOf(entry);
      if (prototype !== Object.prototype && prototype !== null) {
        throw new TypeError('Les réglages doivent contenir des valeurs JSON.');
      }
      result = Object.create(null);
      for (const key of Object.keys(entry).sort()) {
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') {
          throw new TypeError('Nom de réglage non valide.');
        }
        result[key] = copy(entry[key], depth + 1);
      }
    }
    seen.delete(entry);
    return result;
  }
  const json = JSON.stringify(copy(value));
  if (Buffer.byteLength(json) > 65_536) throw new RangeError('Les réglages sont trop volumineux.');
  return json;
}

function hasEdits(adjustments) {
  return Object.entries(adjustments).some(([key, value]) => {
    if (Object.hasOwn(DEFAULTS, key)) return value !== DEFAULTS[key];
    if (Array.isArray(value)) return value.length > 0;
    if (value && typeof value === 'object') return Object.keys(value).length > 0;
    return value !== 0 && value !== false && value !== null && value !== '';
  });
}

function photoFromRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    width: row.width,
    height: row.height,
    adjustments: JSON.parse(row.adjustments),
    rating: row.rating,
    picked: row.picked === 1,
    addedAt: row.added_at,
  };
}

function presetFromRow(row) {
  return row ? { id: row.id, name: row.name, adjustments: JSON.parse(row.adjustments), updatedAt: row.updated_at } : null;
}

/** Disk-backed photo references and edits. No image data or API keys enter SQLite. */
export class Catalog {
  #db;
  #closed = false;
  #insertPhoto;
  #getPhoto;
  #removePhoto;

  constructor(directory) {
    if (typeof directory !== 'string' || !isAbsolute(directory)) {
      throw new TypeError('Le catalogue nécessite un dossier local absolu.');
    }
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.#db = new DatabaseSync(join(directory, 'catalog.sqlite3'));
    try {
      this.#db.exec(`
        PRAGMA busy_timeout = 5000;
        PRAGMA journal_mode = WAL;
        PRAGMA synchronous = NORMAL;
        PRAGMA foreign_keys = ON;
        CREATE TABLE IF NOT EXISTS photos (
          id TEXT PRIMARY KEY,
          path TEXT NOT NULL,
          path_key TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          width INTEGER NOT NULL DEFAULT 0 CHECK (width >= 0),
          height INTEGER NOT NULL DEFAULT 0 CHECK (height >= 0),
          adjustments TEXT NOT NULL DEFAULT '{}',
          rating INTEGER NOT NULL DEFAULT 0 CHECK (rating BETWEEN 0 AND 5),
          picked INTEGER NOT NULL DEFAULT 0 CHECK (picked IN (0, 1)),
          edited INTEGER NOT NULL DEFAULT 0 CHECK (edited IN (0, 1)),
          added_at INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX IF NOT EXISTS photos_added ON photos(added_at DESC);
        CREATE INDEX IF NOT EXISTS photos_name ON photos(name COLLATE NOCASE);
        CREATE INDEX IF NOT EXISTS photos_picked ON photos(picked);
        CREATE INDEX IF NOT EXISTS photos_edited ON photos(edited);
        CREATE TABLE IF NOT EXISTS presets (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE COLLATE NOCASE,
          adjustments TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;
      `);
      this.#insertPhoto = this.#db.prepare(`INSERT INTO photos
        (id,path,path_key,name,added_at) VALUES (?,?,?,?,?) ON CONFLICT(path_key) DO NOTHING`);
      this.#getPhoto = this.#db.prepare('SELECT * FROM photos WHERE id = ?');
      this.#removePhoto = this.#db.prepare('DELETE FROM photos WHERE id = ?');
    } catch (error) {
      this.#db.close();
      this.#closed = true;
      throw error;
    }
  }

  #ensureOpen() {
    if (this.#closed) throw new Error('Le catalogue est fermé.');
  }

  #transaction(work) {
    this.#db.exec('BEGIN IMMEDIATE');
    try {
      const value = work();
      this.#db.exec('COMMIT');
      return value;
    } catch (error) {
      try { this.#db.exec('ROLLBACK'); } catch { /* Preserve the original failure. */ }
      throw error;
    }
  }

  list({ search = '', filter = 'all', offset = 0, limit = 200, sort = 'added' } = {}) {
    this.#ensureOpen();
    if (typeof search !== 'string' || search.length > 4_096) throw new TypeError('Recherche non valide.');
    if (!Object.hasOwn(FILTER, filter)) throw new TypeError('Filtre inconnu.');
    if (!Object.hasOwn(ORDER, sort)) throw new TypeError('Tri inconnu.');
    if (!Number.isSafeInteger(offset) || offset < 0) throw new RangeError('Position de page non valide.');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new RangeError('Une page doit contenir entre 1 et 500 photos.');
    const parameters = [];
    let where = FILTER[filter];
    if (search) {
      // %, _ and the escape character are literal search text, never SQL patterns.
      const escaped = search.replace(/[\\%_]/g, character => `\\${character}`);
      where += " AND name LIKE ? ESCAPE '\\'";
      parameters.push(`%${escaped}%`);
    }
    const total = this.#db.prepare(`SELECT COUNT(*) AS total FROM photos WHERE ${where}`).get(...parameters).total;
    const rows = this.#db.prepare(`SELECT * FROM photos WHERE ${where} ORDER BY ${ORDER[sort]} LIMIT ? OFFSET ?`)
      .all(...parameters, limit, offset);
    return { items: rows.map(photoFromRow), total };
  }

  get(id) {
    this.#ensureOpen();
    if (typeof id !== 'string') throw new TypeError('Identifiant de photo non valide.');
    return photoFromRow(this.#getPhoto.get(id));
  }

  getByPath(path) {
    this.#ensureOpen();
    if (typeof path !== 'string' || !isAbsolute(path)) return null;
    let canonical;
    try { canonical = realpathSync.native(path); } catch { return null; }
    const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    return photoFromRow(this.#db.prepare('SELECT * FROM photos WHERE path_key = ?').get(key));
  }

  importPaths(paths) {
    this.#ensureOpen();
    if (!Array.isArray(paths)) throw new TypeError('L’import nécessite une liste de fichiers.');
    let added = 0;
    let skipped = 0;
    const addedAt = Date.now();
    // Keep transactions short for large folders and retain completed batches on interruption.
    for (let offset = 0; offset < paths.length; offset += 500) {
      const batch = this.#transaction(() => {
        let batchAdded = 0;
        let batchSkipped = 0;
        for (const candidate of paths.slice(offset, offset + 500)) {
          let canonical;
          try {
            if (typeof candidate !== 'string' || !isAbsolute(candidate) || !PHOTO_EXTENSIONS.has(extname(candidate).toLowerCase())) {
              batchSkipped++;
              continue;
            }
            canonical = realpathSync.native(candidate);
            // Resolve aliases before checking type and extension; never launch a source file.
            if (!PHOTO_EXTENSIONS.has(extname(canonical).toLowerCase()) || !statSync(canonical).isFile()) {
              batchSkipped++;
              continue;
            }
          } catch {
            batchSkipped++;
            continue;
          }
          const key = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
          const result = this.#insertPhoto.run(randomUUID(), canonical, key, basename(canonical), addedAt);
          if (result.changes === 1) batchAdded++;
          else batchSkipped++;
        }
        return { added: batchAdded, skipped: batchSkipped };
      });
      added += batch.added;
      skipped += batch.skipped;
    }
    return { added, skipped };
  }

  update(id, patch) {
    this.#ensureOpen();
    if (typeof id !== 'string' || !patch || typeof patch !== 'object' || Array.isArray(patch)) {
      throw new TypeError('Mise à jour de photo non valide.');
    }
    const columns = [];
    const values = [];
    for (const key of Object.keys(patch)) {
      if (!UPDATE_COLUMNS.has(key)) throw new TypeError(`La propriété « ${key} » ne peut pas être modifiée.`);
      const value = patch[key];
      if (key === 'adjustments') {
        const json = normalizeAdjustments(value);
        columns.push('adjustments = ?', 'edited = ?');
        values.push(json, hasEdits(JSON.parse(json)) ? 1 : 0);
      } else if (key === 'rating') {
        if (!Number.isInteger(value) || value < 0 || value > 5) throw new RangeError('La note doit être comprise entre 0 et 5.');
        columns.push('rating = ?');
        values.push(value);
      } else if (key === 'picked') {
        if (typeof value !== 'boolean') throw new TypeError('La sélection doit être un booléen.');
        columns.push('picked = ?');
        values.push(value ? 1 : 0);
      } else {
        if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000) {
          throw new RangeError('Dimensions de photo non valides.');
        }
        columns.push(`${key} = ?`);
        values.push(value);
      }
    }
    if (columns.length) {
      // Column names come exclusively from UPDATE_COLUMNS, values are always bound.
      this.#db.prepare(`UPDATE photos SET ${columns.join(', ')} WHERE id = ?`).run(...values, id);
    }
    return this.get(id);
  }

  remove(ids) {
    this.#ensureOpen();
    if (!Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new TypeError('Liste de photos non valide.');
    return this.#transaction(() => {
      let removed = 0;
      for (const id of ids) removed += this.#removePhoto.run(id).changes;
      return { removed };
    });
  }

  counts() {
    this.#ensureOpen();
    const row = this.#db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(picked), 0) AS picked,
      COALESCE(SUM(edited), 0) AS edited FROM photos`).get();
    return { all: row.total, picked: row.picked, edited: row.edited };
  }

  presets() {
    this.#ensureOpen();
    return this.#db.prepare('SELECT * FROM presets ORDER BY name COLLATE NOCASE, id').all().map(presetFromRow);
  }

  savePreset(name, adjustments) {
    this.#ensureOpen();
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 120) {
      throw new TypeError('Le nom du préréglage doit contenir entre 1 et 120 caractères.');
    }
    const cleanName = name.trim();
    const json = normalizeAdjustments(adjustments);
    this.#db.prepare(`INSERT INTO presets(id,name,adjustments,updated_at) VALUES(?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET adjustments=excluded.adjustments,updated_at=excluded.updated_at`)
      .run(randomUUID(), cleanName, json, Date.now());
    return presetFromRow(this.#db.prepare('SELECT * FROM presets WHERE name = ? COLLATE NOCASE').get(cleanName));
  }

  removePreset(id) {
    this.#ensureOpen();
    if (typeof id !== 'string') throw new TypeError('Identifiant de préréglage non valide.');
    return { removed: this.#db.prepare('DELETE FROM presets WHERE id = ?').run(id).changes };
  }

  close() {
    if (!this.#closed) {
      this.#db.close();
      this.#closed = true;
    }
  }
}
