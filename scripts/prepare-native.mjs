#!/usr/bin/env node
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, isAbsolute, basename } from 'node:path';
import { readFile, writeFile, mkdir, copyFile, readdir, realpath, stat, rename, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createWriteStream } from 'node:fs';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const runFile = promisify(execFile), require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const packageRoot = dirname(require.resolve('@janhapke/libraw/package.json'));
const target = `${process.platform}-${process.arch}`;
const prebuild = join(packageRoot, 'prebuilds', target), addon = join(prebuild, 'node.napi.node');
const runtimeRoot = join(root, 'build', 'runtime', target);
const flags = new Set(process.argv.slice(2));
const allowed = new Set(['--help', '--verify-only', '--verify-electron', '--with-sources', '--archive-sources', '--smoke-packaged']);
for (const flag of flags) if (!allowed.has(flag)) throw new Error(`Unknown option: ${flag}`);
const MS_DOCS = 'https://learn.microsoft.com/en-us/cpp/windows/redistributing-visual-cpp-files?view=msvc-170';
const MS_REDIST = 'https://learn.microsoft.com/en-us/visualstudio/releases/2022/redistribution';
const MS_LICENSE = 'https://visualstudio.microsoft.com/wp-content/uploads/2021/09/Visual-C-Runtime-2015-2022-License-1.docx';
const GCC_EXCEPTION = 'https://raw.githubusercontent.com/gcc-mirror/gcc/releases/gcc-12.3.0/COPYING.RUNTIME';

function inside(base, candidate) {
  const difference = relative(base, candidate);
  return !isAbsolute(difference) && difference !== '..' && !difference.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
}
async function exists(path) { try { return (await stat(path)).isFile(); } catch { return false; } }
async function hash(path) { return createHash('sha256').update(await readFile(path)).digest('hex'); }
async function command(file, args, options = {}) {
  const { stdout, stderr } = await runFile(file, args, { cwd: root, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true, ...options });
  return (stdout + (stderr ? '\n' + stderr : '')).trim();
}
async function json(path, value) { await writeFile(path, JSON.stringify(value, null, 2) + '\n'); }
async function download(url, destination, { sha256, size, maximum = 350_000_000 } = {}) {
  if (await exists(destination)) {
    if ((!sha256 || await hash(destination) === sha256) && (!size || (await stat(destination)).size === size)) return;
    throw new Error(`Existing download has an unexpected hash/size: ${destination}`);
  }
  const response = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!response.ok || !response.body) throw new Error(`Cannot retrieve official source (${response.status}): ${url}`);
  let received = 0;
  const digest = createHash('sha256');
  const guard = new Transform({ transform(chunk, encoding, callback) {
    received += chunk.length;
    if (received > maximum) { callback(new Error('Official source download exceeded the size limit.')); return; }
    digest.update(chunk); callback(null, chunk);
  } });
  const temporary = destination + '.atelier-download';
  try {
    await pipeline(Readable.fromWeb(response.body), guard, createWriteStream(temporary, { flags: 'wx' }));
    const actual = digest.digest('hex');
    if ((sha256 && actual !== sha256) || (size && received !== size)) throw new Error(`Official source hash/size mismatch: ${url}`);
    await rename(temporary, destination);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}
async function commonNotices() {
  await mkdir(join(runtimeRoot, 'licenses'), { recursive: true });
  await mkdir(join(prebuild, 'licenses'), { recursive: true });
  for (const name of ['LICENSE', 'THIRD_PARTY_NOTICES.md']) {
    await copyFile(join(packageRoot, name), join(runtimeRoot, 'licenses', `libraw-${name}`));
    await copyFile(join(packageRoot, name), join(prebuild, 'licenses', `libraw-${name}`));
  }
}
async function copyNotice(source, name) {
  await copyFile(source, join(runtimeRoot, 'licenses', name));
  await copyFile(source, join(prebuild, 'licenses', name));
}

async function linuxSources(sourcePackage, sourceVersion) {
  const version = sourceVersion.replace(/^\d+:/, '');
  if (!/^gcc-\d+$/.test(sourcePackage) || !/^[\w.+~:-]+$/.test(version)) throw new Error('Unexpected Ubuntu source identity.');
  const sourceBase = `https://archive.ubuntu.com/ubuntu/pool/main/g/${sourcePackage}/`;
  const dscName = `${sourcePackage}_${version}.dsc`, sourceDirectory = join(root, 'build', 'native-sources', 'libgomp');
  await mkdir(sourceDirectory, { recursive: true });
  await download(sourceBase + dscName, join(sourceDirectory, dscName), { maximum: 2_000_000 });
  const dsc = await readFile(join(sourceDirectory, dscName), 'utf8');
  const section = dsc.match(/^Checksums-Sha256:\r?\n((?:[ \t].*\r?\n)+)/m)?.[1];
  if (!section) throw new Error('Ubuntu source descriptor does not provide SHA-256 hashes.');
  const files = [];
  for (const line of section.trim().split(/\r?\n/)) {
    const match = line.trim().match(/^([a-f0-9]{64})\s+(\d+)\s+([\w.+~:-]+)$/);
    if (!match || basename(match[3]) !== match[3]) throw new Error('Invalid Ubuntu source descriptor.');
    const [, sha256, byteCount, name] = match;
    await download(sourceBase + name, join(sourceDirectory, name), { sha256, size: Number(byteCount) });
    files.push({ name, sha256, size: Number(byteCount), url: sourceBase + name });
  }
  await json(join(sourceDirectory, 'PROVENANCE.json'), { sourcePackage, sourceVersion, descriptor: sourceBase + dscName,
    descriptorSha256: await hash(join(sourceDirectory, dscName)), files,
    rebuild: 'On Ubuntu 22.04, unpack the .dsc with dpkg-source -x and use the accompanying Debian packaging/build instructions.' });
  return { descriptor: sourceBase + dscName, files, archive: 'AtelierPhoto-Linux-native-sources.tar.xz' };
}

async function prepareLinux() {
  if (process.arch !== 'x64') throw new Error('Linux release preparation is validated only for x64.');
  const osRelease = await readFile('/etc/os-release', 'utf8');
  if (!/^ID=ubuntu$/m.test(osRelease) || !/^VERSION_ID="?22\.04"?$/m.test(osRelease)) throw new Error('Release runtimes must be taken from the Ubuntu 22.04 baseline.');
  const query = await command('dpkg-query', ['--show', '--showformat=${binary:Package}\t${Version}\t${source:Package}\t${source:Version}\t${Architecture}\n', 'libgomp1']);
  const [binaryPackage, version, sourcePackage, sourceVersion, architecture] = query.split('\t');
  if (architecture !== 'amd64' || !version || !sourceVersion) throw new Error('Unexpected Ubuntu libgomp package metadata.');
  if (process.env.ATELIER_LIBGOMP_VERSION && version !== process.env.ATELIER_LIBGOMP_VERSION) throw new Error('libgomp version differs from ATELIER_LIBGOMP_VERSION.');
  const installed = (await command('dpkg-query', ['--listfiles', 'libgomp1'])).split(/\r?\n/).filter(path => /\/libgomp\.so\.1(?:\.|$)/.test(path));
  const link = installed.find(path => path.endsWith('/libgomp.so.1'));
  if (!link) throw new Error('Official Ubuntu libgomp1 does not contain libgomp.so.1.');
  const library = await realpath(link);
  if (!library.startsWith('/usr/lib/') && !library.startsWith('/lib/')) throw new Error('libgomp is outside the Ubuntu library directories.');
  const owner = await command('dpkg-query', ['--search', library]);
  if (!/^libgomp1(?::amd64)?: /.test(owner)) throw new Error('libgomp is not owned by the Ubuntu libgomp1 package.');
  await copyFile(library, join(prebuild, 'libgomp.so.1'));
  await copyFile(library, join(runtimeRoot, 'libgomp.so.1'));
  await copyNotice('/usr/share/doc/libgomp1/copyright', 'libgomp-COPYRIGHT');
  await copyNotice('/usr/share/common-licenses/GPL-3', 'GPL-3.0.txt');
  await download(GCC_EXCEPTION, join(runtimeRoot, 'licenses', 'GCC-Runtime-Library-Exception-3.1.txt'), { maximum: 100_000 });
  if (!(await readFile(join(runtimeRoot, 'licenses', 'GCC-Runtime-Library-Exception-3.1.txt'), 'utf8')).includes('GCC RUNTIME LIBRARY EXCEPTION')) throw new Error('Unexpected GCC exception document.');
  await copyFile(join(runtimeRoot, 'licenses', 'GCC-Runtime-Library-Exception-3.1.txt'), join(prebuild, 'licenses', 'GCC-Runtime-Library-Exception-3.1.txt'));
  const beforePatchSha256 = await hash(addon);
  await command('patchelf', ['--set-rpath', '$ORIGIN', addon]);
  const dynamic = await command('readelf', ['--dynamic', addon]);
  if (!/\(RUNPATH\).*\[\$ORIGIN\]/.test(dynamic)) throw new Error('LibRaw RUNPATH is not $ORIGIN.');
  const ldd = await command('ldd', [addon]);
  if (/not found/.test(ldd)) throw new Error(`Missing native dependency:\n${ldd}`);
  const resolvedGomp = ldd.match(/libgomp\.so\.1\s+=>\s+(.*?)\s+\(/)?.[1];
  if (!resolvedGomp || await realpath(resolvedGomp) !== await realpath(join(prebuild, 'libgomp.so.1'))) throw new Error('LibRaw did not resolve its bundled libgomp.');
  const symbols = await command('readelf', ['--version-info', addon]);
  const sources = flags.has('--with-sources') ? await linuxSources(sourcePackage, sourceVersion) : {
    descriptor: `https://archive.ubuntu.com/ubuntu/pool/main/g/${sourcePackage}/${sourcePackage}_${sourceVersion.replace(/^\d+:/, '')}.dsc`,
    status: 'Run --with-sources before a public release.'
  };
  return { baseline: 'Ubuntu 22.04 / glibc 2.35', binaryPackage, version, sourcePackage, sourceVersion, architecture,
    installedSource: library, sha256: await hash(library), patch: { command: 'patchelf --set-rpath $ORIGIN node.napi.node', beforePatchSha256, afterPatchSha256: await hash(addon) },
    licenses: { copyright: '/usr/share/doc/libgomp1/copyright', gpl: '/usr/share/common-licenses/GPL-3', exception: GCC_EXCEPTION }, sources, dynamic, ldd, symbolVersions: symbols };
}

function numericVersion(a, b) { return b.localeCompare(a, 'en', { numeric: true }); }
async function findMSVCRedist() {
  const installer = join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const installation = await command(installer, ['-latest', '-products', '*', '-version', '[17.0,18.0)', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath']);
  if (!installation || installation.includes('\n')) throw new Error('Visual Studio 2022 C++ installation was not found.');
  const redist = await realpath(join(installation, 'VC', 'Redist', 'MSVC'));
  let versions = (await readdir(redist)).filter(name => /^14\.\d+\.\d+(?:\.\d+)?$/.test(name)).sort(numericVersion);
  if (process.env.ATELIER_MSVC_REDIST_VERSION) versions = versions.filter(version => version === process.env.ATELIER_MSVC_REDIST_VERSION);
  for (const version of versions) {
    const x64 = join(redist, version, 'x64');
    const folders = (await readdir(x64, { withFileTypes: true }).catch(() => [])).filter(entry => entry.isDirectory());
    const crt = folders.find(entry => /^Microsoft\.VC\d+\.CRT$/i.test(entry.name));
    const omp = folders.find(entry => /^Microsoft\.VC\d+\.OpenMP$/i.test(entry.name));
    if (crt && omp) return { installation, redist, version, crt: await realpath(join(x64, crt.name)), omp: await realpath(join(x64, omp.name)) };
  }
  throw new Error('No matching x64 CRT + OpenMP release folders in Visual Studio VC/Redist/MSVC. System32 is deliberately not a fallback.');
}
async function microsoftSignature(file) {
  // A literal environment value avoids interpreting a path as PowerShell code.
  const script = "$s=Get-AuthenticodeSignature -LiteralPath $env:ATELIER_RUNTIME_FILE; $v=(Get-Item -LiteralPath $env:ATELIER_RUNTIME_FILE).VersionInfo; [pscustomobject]@{status=[string]$s.Status;subject=[string]$s.SignerCertificate.Subject;fileVersion=[string]$v.FileVersion;productVersion=[string]$v.ProductVersion}|ConvertTo-Json -Compress";
  const result = JSON.parse((await command('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { env: { ...process.env, ATELIER_RUNTIME_FILE: file } })).replace(/^\uFEFF/, ''));
  if (result.status !== 'Valid' || !/Microsoft Corporation/i.test(result.subject)) throw new Error(`Microsoft signature verification failed: ${basename(file)}`);
  const data = await readFile(file), peOffset = data.length >= 64 ? data.readUInt32LE(60) : -1;
  if (data.toString('ascii', 0, 2) !== 'MZ' || peOffset < 0 || peOffset + 6 > data.length || data.readUInt32LE(peOffset) !== 0x4550 || data.readUInt16LE(peOffset + 4) !== 0x8664) throw new Error(`Runtime DLL is not a PE x64 image: ${basename(file)}`);
  return result;
}
async function prepareWindows() {
  if (process.arch !== 'x64') throw new Error('Windows release preparation is validated only for x64.');
  const selected = await findMSVCRedist(), files = [];
  for (const directory of [selected.crt, selected.omp]) {
    if (!inside(selected.redist, directory)) throw new Error('MSVC runtime path leaves VC/Redist/MSVC.');
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isFile() || !/\.dll$/i.test(entry.name)) continue;
      const source = await realpath(join(directory, entry.name));
      if (!inside(directory, source)) throw new Error('MSVC DLL points outside its release folder.');
      const signature = await microsoftSignature(source);
      await copyFile(source, join(runtimeRoot, entry.name));
      await copyFile(source, join(prebuild, entry.name));
      files.push({ name: entry.name, source, sha256: await hash(source), ...signature });
    }
  }
  for (const expected of ['vcomp140.dll', 'msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll']) {
    if (!files.some(file => file.name.toLowerCase() === expected)) throw new Error(`Required Microsoft runtime is missing: ${expected}`);
  }
  for (const [name, url] of [['Microsoft-Visual-C-Runtime-License.docx', MS_LICENSE], ['Microsoft-REDIST-list.html', MS_REDIST]]) {
    await download(url, join(runtimeRoot, 'licenses', name), { maximum: 5_000_000 });
    const content = await readFile(join(runtimeRoot, 'licenses', name));
    if (name.endsWith('.docx') && content.readUInt32LE(0) !== 0x04034b50) throw new Error('Microsoft licence download is not a DOCX document.');
    if (name.endsWith('.html') && !content.toString('utf8').includes('Visual C++ Runtime Files')) throw new Error('Microsoft REDIST page did not contain its runtime list.');
    await copyFile(join(runtimeRoot, 'licenses', name), join(prebuild, 'licenses', name));
  }
  return { visualStudio: selected.installation, redistRoot: selected.redist, redistVersion: selected.version, architecture: 'x64', files,
    documentation: MS_DOCS, redistributionList: MS_REDIST, license: MS_LICENSE,
    rights: 'Public redistribution requires the applicable Visual Studio licence rights; runner availability alone does not establish those rights.' };
}

async function prepareMac() {
  const linkage = await command('otool', ['-L', addon]);
  const dependencies = linkage.split('\n').slice(1).map(line => line.trim().split(' (')[0]).filter(Boolean);
  if (dependencies.some(path => !path.startsWith('/usr/lib/') && !path.startsWith('/System/Library/'))) throw new Error('The Mac LibRaw addon depends on a non-system library; it must be bundled explicitly.');
  return { linkage, dependencies, openmp: 'Statically linked by upstream; see the included libraw THIRD_PARTY_NOTICES.md.' };
}

async function verifyNative() {
  const sharp = require('sharp'), libraw = require('@janhapke/libraw');
  const version = libraw.version(), cameras = libraw.cameraCount();
  if (!/0\.22\.2/.test(version) || cameras < 1000) throw new Error('Unexpected native LibRaw backend.');
  const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#426891' } }).png().toBuffer();
  const metadata = await sharp(png).metadata();
  if (metadata.width !== 2 || metadata.height !== 2) throw new Error('sharp native encode/decode failed.');
  const result = { platform: process.platform, arch: process.arch, node: process.versions.node, electron: process.versions.electron ?? null,
    libraw: version, cameras, sharp: sharp.versions.sharp, vips: sharp.versions.vips };
  console.log('ATELIER_NATIVE_OK ' + JSON.stringify(result));
  return result;
}
async function verifyElectron() {
  const electron = require('electron');
  if (typeof electron !== 'string') throw new Error('Run --verify-electron using Node.js, outside Electron.');
  const options = { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, timeout: 180_000 };
  console.log(await command(electron, [fileURLToPath(import.meta.url), '--verify-only'], options));
  console.log(await command(electron, ['--test', join(root, 'Tests', 'raw-decoder.test.mjs')], options));
}
async function packagedSmoke() {
  const packageJSON = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
  const product = packageJSON.build.productName;
  let executable;
  if (process.platform === 'win32') executable = join(root, 'release', 'win-unpacked', `${product}.exe`);
  else if (process.platform === 'darwin') {
    const directory = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
    executable = join(root, 'release', directory, `${product}.app`, 'Contents', 'MacOS', product);
  } else executable = join(root, 'release', 'linux-unpacked', packageJSON.build.linux.executableName ?? packageJSON.name);
  if (!await exists(executable)) throw new Error(`Packaged executable not found: ${executable}`);
  // Use the actual GUI executable, not ELECTRON_RUN_AS_NODE: this verifies asar
  // resolution, adjacent DLLs, and the application's real startup branch.
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
  const verifyExecutable = async (file, environment) => {
    const output = await command(file, ['--test-native-backend'], { env: environment, timeout: 90_000 });
    // Windows GUI executables may not attach stdout; their non-zero exit still
    // fails execFile. macOS/Linux must provide the positive success marker.
    if (process.platform !== 'win32' && !output.includes('ATELIER_NATIVE_OK ')) throw new Error('Packaged native smoke did not report success.');
    console.log(output || 'Packaged Windows native smoke exited successfully (GUI stdout may be unavailable).');
  };
  await verifyExecutable(executable, env);
  if (process.platform === 'linux') {
    const appImage = join(root, 'release', `AtelierPhoto-${packageJSON.version}-linux-x86_64.AppImage`);
    if (!await exists(appImage)) throw new Error('The final Linux AppImage was not produced.');
    // Official AppImage extract-and-run mode tests the delivered file without
    // requiring FUSE on the CI host. The runtime removes its temporary files.
    await verifyExecutable(appImage, { ...env, APPIMAGE_EXTRACT_AND_RUN: '1' });
  }
}

try {
  if (flags.has('--help')) console.log('node scripts/prepare-native.mjs [--verify-electron] [--with-sources]\n  --verify-only     Read-only native sharp/LibRaw check\n  --smoke-packaged  Run the packaged application native self-test\n  --archive-sources Archive downloaded Linux GCC sources into release/');
  else if (flags.has('--smoke-packaged')) await packagedSmoke();
  else if (flags.has('--archive-sources')) {
    if (process.platform !== 'linux') throw new Error('Source archive creation is a Linux release step.');
    await mkdir(join(root, 'release'), { recursive: true });
    const epoch = process.env.SOURCE_DATE_EPOCH ?? '0';
    if (!/^\d+$/.test(epoch)) throw new Error('SOURCE_DATE_EPOCH must be an integer.');
    await command('tar', ['--sort=name', `--mtime=@${epoch}`, '--owner=0', '--group=0', '--numeric-owner', '-cJf', join(root, 'release', 'AtelierPhoto-Linux-native-sources.tar.xz'), '-C', join(root, 'build', 'native-sources'), 'libgomp'], { timeout: 600_000 });
  } else if (flags.has('--verify-only')) await verifyNative();
  else {
    if (!await exists(addon)) throw new Error(`No native LibRaw prebuild exists for ${target}.`);
    await commonNotices();
    const details = process.platform === 'linux' ? await prepareLinux() : process.platform === 'win32' ? await prepareWindows() : process.platform === 'darwin' ? await prepareMac() : (() => { throw new Error(`Unsupported release platform: ${process.platform}`); })();
    const native = await verifyNative();
    const manifest = { schema: 1, target, sourceDateEpoch: process.env.SOURCE_DATE_EPOCH ?? null, package: '@janhapke/libraw@0.1.0', addonSha256: await hash(addon), native, details };
    await json(join(runtimeRoot, 'PROVENANCE.json'), manifest);
    await json(join(prebuild, 'PROVENANCE.json'), manifest);
    if (flags.has('--verify-electron')) await verifyElectron();
    console.log(`Prepared ${target}: ${relative(root, runtimeRoot)}`);
  }
} catch (error) {
  console.error('Native runtime preparation failed:', error.message);
  process.exitCode = 1;
}
