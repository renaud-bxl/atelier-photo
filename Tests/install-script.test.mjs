import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const asset = 'AtelierPhoto-0.1.0-linux-x86_64.AppImage';
const bytes = Buffer.from('Atelier Photo installer checksum fixture\n');

async function fixture(t, validChecksum = true) {
  const directory = await mkdtemp(join(tmpdir(), 'atelier-installer-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const bin = join(directory, 'bin'), destination = join(directory, 'destination with spaces');
  const payload = join(directory, 'payload'), checksums = join(directory, 'SHA256SUMS');
  const log = join(directory, 'requests.jsonl');
  await mkdir(bin);
  await writeFile(payload, bytes);
  const digest = validChecksum ? createHash('sha256').update(bytes).digest('hex') : '0'.repeat(64);
  await writeFile(checksums, `${digest}  ${asset}\n`);
  await writeFile(join(bin, 'uname'), '#!/bin/sh\ncase "$1" in -s) echo Linux;; -m) echo x86_64;; *) exit 1;; esac\n', { mode: 0o755 });
  // Only the three expected release URLs are served, entirely from this fixture.
  await writeFile(join(bin, 'curl'), `#!${process.execPath}
import { appendFileSync, copyFileSync } from 'node:fs';
const args = process.argv.slice(2);
const url = args.find(value => value.startsWith('https://'));
appendFileSync(${JSON.stringify(log)}, JSON.stringify(url) + '\\n');
const base = 'https://github.com/renaud-bxl/atelier-photo/releases/';
if (url === base + 'latest') process.stdout.write(base + 'tag/v0.1.0');
else {
  const output = args[args.indexOf('--output') + 1];
  if (url === base + 'download/v0.1.0/SHA256SUMS') copyFileSync(${JSON.stringify(checksums)}, output);
  else if (url === base + 'download/v0.1.0/${asset}') copyFileSync(${JSON.stringify(payload)}, output);
  else throw new Error('Unexpected download URL: ' + url);
}
`, { mode: 0o755 });
  return {
    destination, log, target: join(destination, 'AtelierPhoto.AppImage'),
    install: () => run('bash', [join(root, 'scripts/install.sh'), '--repo', 'renaud-bxl/atelier-photo', '--destination', destination], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, timeout: 10_000,
    }),
  };
}

const options = { skip: process.platform === 'win32' ? 'POSIX installation script; Windows has a separate PowerShell installer.' : false };

test('Linux installer selects the delivered x86_64 archive and installs only checksum-verified bytes', options, async t => {
  const setup = await fixture(t);
  const result = await setup.install();
  assert.match(result.stdout, /Empreinte SHA-256 vérifiée/);
  assert.deepEqual(await readFile(setup.target), bytes);
  assert.equal((await stat(setup.target)).mode & 0o777, 0o755);
  const urls = (await readFile(setup.log, 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(urls.length, 3);
  assert.ok(urls.at(-1).endsWith('/' + asset));
});

test('a wrong checksum prevents installing the downloaded Linux application', options, async t => {
  const setup = await fixture(t, false);
  await assert.rejects(setup.install(), error => /empreinte SHA-256 ne correspond pas/i.test(error.stderr));
  await assert.rejects(stat(setup.target), { code: 'ENOENT' });
});

test('an existing installation is preserved and refused before any download', options, async t => {
  const setup = await fixture(t);
  await mkdir(setup.destination);
  const original = 'Existing application';
  await writeFile(setup.target, original);
  await assert.rejects(setup.install(), error => /installation existe déjà/i.test(error.stderr));
  assert.equal(await readFile(setup.target, 'utf8'), original);
  await assert.rejects(stat(setup.log), { code: 'ENOENT' });
});
