import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Catalog } from '../desktop/catalog.mjs';

test('catalogue disque : 10 000 références, pagination, réglages, presets et transactions', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'atelier-catalog-'));
  const originals = join(directory, 'originals');
  const databaseDirectory = join(directory, 'catalog');
  mkdirSync(originals);
  let catalog = new Catalog(databaseDirectory);
  const file = name => {
    const path = join(originals, name);
    writeFileSync(path, 'placeholder image reference');
    return path;
  };
  const files = Array.from({ length: 10_000 }, (_, index) => file(`photo-${String(index).padStart(5, '0')}.jpg`));
  try {
    await t.test('importe 10 000 fichiers en lots et ne charge que les métadonnées', () => {
      const start = performance.now();
      assert.deepEqual(catalog.importPaths(files), { added: 10_000, skipped: 0 });
      assert.deepEqual(catalog.counts(), { all: 10_000, picked: 0, edited: 0 });
      const page = catalog.list();
      assert.equal(page.items.length, 200);
      assert.equal(page.total, 10_000);
      assert.equal(page.items[0].name, 'photo-09999.jpg');
      assert.equal(page.items[0].width, 0);
      assert.equal(page.items[0].height, 0);
      assert.deepEqual(page.items[0].adjustments, {});
      assert.equal(Object.hasOwn(page.items[0], 'image'), false);
      t.diagnostic(`10 000 références importées en ${(performance.now() - start).toFixed(0)} ms.`);
    });

    await t.test('la pagination et les tris restent stables', () => {
      const first = catalog.list({ limit: 137, sort: 'name' });
      const second = catalog.list({ limit: 137, offset: 137, sort: 'name' });
      assert.equal(first.items[0].name, 'photo-00000.jpg');
      assert.equal(first.items.at(-1).name, 'photo-00136.jpg');
      assert.equal(second.items[0].name, 'photo-00137.jpg');
      assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 274);
      assert.equal(catalog.list({ search: 'photo-099' }).total, 100);
      assert.equal(catalog.list({ offset: 10_000 }).items.length, 0);
      assert.throws(() => catalog.list({ limit: 1_000_000 }), /500/);
      assert.throws(() => catalog.list({ sort: 'name; DROP TABLE photos' }), /Tri inconnu/);
      assert.throws(() => catalog.list({ filter: '1 OR 1=1' }), /Filtre inconnu/);
    });

    await t.test('déduplique les chemins canoniques et refuse fichiers manquants, dossiers, exécutables', () => {
      const alias = join(originals, 'alias.jpg');
      let hasAlias = false;
      try { symlinkSync(files[0], alias); hasAlias = true; } catch (error) {
        if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
      }
      const folder = join(originals, 'folder.jpg');
      mkdirSync(folder);
      const script = file('script.exe');
      const candidates = [files[0], folder, script, join(originals, 'missing.jpg'), '../relative.jpg', null];
      if (hasAlias) candidates.push(alias);
      assert.deepEqual(catalog.importPaths(candidates), { added: 0, skipped: candidates.length });
      assert.equal(catalog.getByPath(files[0]).name, 'photo-00000.jpg');
      if (hasAlias) assert.equal(catalog.getByPath(alias).id, catalog.getByPath(files[0]).id);
      assert.equal(catalog.getByPath(join(originals, 'missing.jpg')), null);
      assert.deepEqual(catalog.importPaths([file('raw-photo.NEF')]), { added: 1, skipped: 0 });
    });

    await t.test('recherche littérale avec caractères SQL, sans élargissement ni injection', () => {
      const special = file("literal_%' OR 1=1 --.jpg");
      assert.equal(catalog.importPaths([special]).added, 1);
      assert.equal(catalog.list({ search: '%' }).total, 1);
      assert.equal(catalog.list({ search: '_' }).total, 1);
      assert.equal(catalog.list({ search: "' OR 1=1 --" }).items[0].name, "literal_%' OR 1=1 --.jpg");
      assert.equal(catalog.get("' OR 1=1 --"), null);
      assert.equal(catalog.list().total, 10_002);
    });

    let editedPhoto;
    await t.test('met à jour uniquement les métadonnées autorisées et compte les réglages neutres', () => {
      editedPhoto = catalog.list({ sort: 'name', limit: 1 }).items[0];
      const edited = catalog.update(editedPhoto.id, {
        adjustments: { contrast: 1, saturation: 1, exposure: 0.5, flipHorizontal: false },
        rating: 5, picked: true, width: 6000, height: 4000,
      });
      assert.equal(edited.width, 6000);
      assert.equal(edited.adjustments.exposure, 0.5);
      assert.equal(edited.picked, true);
      assert.deepEqual(catalog.counts(), { all: 10_002, picked: 1, edited: 1 });
      assert.equal(catalog.list({ filter: 'edited' }).total, 1);
      assert.equal(catalog.list({ filter: 'picked' }).items[0].id, editedPhoto.id);
      assert.equal(catalog.list({ sort: 'rating', limit: 1 }).items[0].id, editedPhoto.id);
      assert.throws(() => catalog.update(editedPhoto.id, { rating: 1, path: '/tmp/replace.jpg' }), /ne peut pas/);
      assert.equal(catalog.get(editedPhoto.id).rating, 5, 'Validation must happen before any write');
      assert.throws(() => catalog.update(editedPhoto.id, { adjustments: { exposure: Infinity } }), /non valide/);
      assert.throws(() => catalog.update(editedPhoto.id, { rating: 10 }), /0 et 5/);
      assert.throws(() => catalog.update(editedPhoto.id, { picked: 'true' }), /booléen/);
      catalog.update(editedPhoto.id, { adjustments: { exposure: 0, contrast: 1, saturation: 1, flipHorizontal: false, cropRatio: 0 } });
      assert.equal(catalog.counts().edited, 0);
      catalog.update(editedPhoto.id, { adjustments: { exposure: 0.5 } });
    });

    let preset;
    await t.test('conserve les presets et remplace un nom existant sans doublon', () => {
      preset = catalog.savePreset(' Portrait doux ', { exposure: 0.3, contrast: 1 });
      assert.equal(preset.name, 'Portrait doux');
      const replacement = catalog.savePreset('portrait DOUX', { exposure: 0.6 });
      assert.equal(replacement.id, preset.id);
      assert.equal(catalog.presets().length, 1);
      assert.equal(catalog.presets()[0].adjustments.exposure, 0.6);
      assert.throws(() => catalog.savePreset(' ', {}), /1 et 120/);
      assert.throws(() => catalog.savePreset('Invalid', { exposure: NaN }), /non valide/);
    });

    await t.test('réouvre le catalogue et retire les références sans toucher aux originaux', () => {
      catalog.close();
      catalog.close();
      assert.throws(() => catalog.list(), /fermé/);
      catalog = new Catalog(databaseDirectory);
      assert.equal(catalog.get(editedPhoto.id).adjustments.exposure, 0.5);
      assert.equal(catalog.get(editedPhoto.id).rating, 5);
      assert.equal(catalog.presets()[0].id, preset.id);
      const bytes = readFileSync(editedPhoto.path);
      assert.deepEqual(catalog.remove([editedPhoto.id, editedPhoto.id, "' OR 1=1 --"]), { removed: 1 });
      assert.equal(catalog.get(editedPhoto.id), null);
      assert.equal(existsSync(editedPhoto.path), true);
      assert.deepEqual(readFileSync(editedPhoto.path), bytes);
      assert.equal(catalog.removePreset(preset.id).removed, 1);
      assert.equal(catalog.presets().length, 0);
      assert.deepEqual(catalog.counts(), { all: 10_001, picked: 0, edited: 0 });
    });

    await t.test('annule le lot en erreur et conserve les lots déjà validés', () => {
      const extra = Array.from({ length: 503 }, (_, index) => file(`batch-${index}.jpg`));
      extra[501] = file('abort-import.jpg');
      const inspect = new DatabaseSync(join(databaseDirectory, 'catalog.sqlite3'));
      try {
        inspect.exec(`CREATE TRIGGER reject_import BEFORE INSERT ON photos
          WHEN NEW.name = 'abort-import.jpg' BEGIN SELECT RAISE(ABORT, 'test rollback'); END;`);
        const before = catalog.counts().all;
        assert.throws(() => catalog.importPaths(extra), /test rollback/);
        assert.equal(catalog.counts().all, before + 500);
        assert.equal(catalog.list({ search: 'batch-500.jpg' }).total, 0, 'The failed batch must fully roll back');
        inspect.exec('DROP TRIGGER reject_import');

        const selected = catalog.list({ sort: 'name', limit: 2 }).items;
        const blockedId = selected[1].id;
        // IDs originate from UUID generation; no external strings are interpolated here.
        inspect.exec(`CREATE TRIGGER reject_delete BEFORE DELETE ON photos
          WHEN OLD.id = '${blockedId}' BEGIN SELECT RAISE(ABORT, 'test delete rollback'); END;`);
        const count = catalog.counts().all;
        assert.throws(() => catalog.remove(selected.map(item => item.id)), /test delete rollback/);
        assert.equal(catalog.counts().all, count);
        assert.ok(catalog.get(selected[0].id), 'Earlier deletes in the same transaction must be restored');
        inspect.exec('DROP TRIGGER reject_delete');
        assert.equal(inspect.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
      } finally { inspect.close(); }
    });
  } finally {
    catalog.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
