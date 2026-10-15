import os from 'node:os';
import { statfs, readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, resolve, join, win32 } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const GiB = 1024 ** 3, MiB = 1024 ** 2;
const runFile = promisify(execFile);
const unknownGPU = () => ({ kind: 'unknown', name: null, vramBytes: null, accelerationHint: null });
const number = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;
const positive = value => number(value) !== null && value > 0 ? value : null;
const name = value => typeof value === 'string' ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180) || null : null;
const unique = values => [...new Set(values)];
function object(value) {
  if (typeof value === 'string') {
    if (value.length > 1_048_576) return null;
    try { return JSON.parse(value.replace(/^\uFEFF/, '')); } catch { return null; }
  }
  return value && typeof value === 'object' ? value : null;
}
function chooseGPU(candidates) {
  const devices = candidates.filter(Boolean);
  if (!devices.length) return unknownGPU();
  return [...devices].sort((a, b) => {
    const score = gpu => (gpu.accelerationHint ? 100 : 0) + (gpu.kind === 'unified' ? 40 : gpu.kind === 'discrete' ? 30 : gpu.kind === 'integrated' ? 10 : 0);
    return score(b) - score(a) || (b.vramBytes ?? 0) - (a.vramBytes ?? 0);
  })[0];
}
function summary(devices, warnings = []) {
  if (devices.length > 1) warnings.push('gpu_multiple_devices');
  return { gpu: chooseGPU(devices), warnings: unique(warnings) };
}
function byteQuantity(value) {
  const match = typeof value === 'string' && value.trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB|KiB|MiB|GiB|TiB)$/i);
  if (!match) return null;
  const units = { b: 1, kb: 1024, kib: 1024, mb: MiB, mib: MiB, gb: GiB, gib: GiB, tb: 1024 ** 4, tib: 1024 ** 4 };
  return positive(Number(match[1]) * units[match[2].toLowerCase()]);
}

/** Only selected display-adapter fields survive; serials/monitor data are discarded. */
export function parseMacDisplays(input, arch = 'arm64') {
  const report = object(input), devices = [], warnings = [];
  const entries = Array.isArray(report?.SPDisplaysDataType) ? report.SPDisplaysDataType.slice(0, 16) : [];
  for (const entry of entries) {
    const label = name(entry?.sppci_model ?? entry?._name);
    if (!label) continue;
    const vendor = name(entry.spdisplays_vendor) ?? '';
    const apple = arch === 'arm64' && /\bApple\b/i.test(label + ' ' + vendor);
    const integrated = !apple && /\bIntel\b/i.test(label + ' ' + vendor) && !/\bArc\b/i.test(label);
    const dedicated = byteQuantity(entry.spdisplays_vram);
    const kind = apple ? 'unified' : integrated ? 'integrated' : dedicated ? 'discrete' : 'unknown';
    const metalFields = [entry.spdisplays_metal, entry.spdisplays_mtlgpufamilysupport, entry.spdisplays_metal_featureset, entry.spdisplays_metalsupport];
    const metal = metalFields.some(value => typeof value === 'string' && !/unsupported|not supported|unavailable/i.test(value) && /supported|metal|gpufamily|feature_set/i.test(value));
    devices.push({ kind, name: label, vramBytes: apple || integrated ? null : dedicated, accelerationHint: metal ? 'metal' : null });
    if (apple) warnings.push('gpu_unified_memory_shared');
  }
  return summary(devices, warnings);
}

function csvLine(line) {
  const fields = []; let field = '', quoted = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') { field += '"'; index++; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) { fields.push(field.trim()); field = ''; }
    else field += char;
  }
  if (quoted) return [];
  fields.push(field.trim()); return fields;
}

/** nvidia-smi memory.total is MiB, not host RAM. Multiple GPUs are never summed.
 * https://docs.nvidia.com/deploy/nvidia-smi/index.html */
export function parseNvidiaSMI(input) {
  if (typeof input !== 'string' || input.length > 262_144) return summary([]);
  const devices = [];
  for (const line of input.split(/\r?\n/).slice(0, 32)) {
    const fields = csvLine(line);
    if (fields.length !== 3 || !name(fields[0]) || !/\d/.test(fields[2]) || /not found|error|failed/i.test(fields[0])) continue;
    const memory = /^\d+(?:\.\d+)?$/.test(fields[1]) ? positive(Number(fields[1]) * MiB) : null;
    devices.push({ kind: 'discrete', name: name(fields[0]), vramBytes: memory, accelerationHint: 'cuda' });
  }
  return summary(devices);
}

/** AdapterRAM is uint32 and can truncate larger adapters: never use it as capacity.
 * https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-videocontroller */
export function parseWindowsControllers(input) {
  const parsed = object(input), entries = Array.isArray(parsed) ? parsed.slice(0, 16) : parsed ? [parsed] : [];
  const devices = [], warnings = [];
  for (const entry of entries) {
    const label = name(entry?.Name);
    if (!label || /Microsoft Basic|Remote Display|Virtual|VMware|Hyper-V|Citrix/i.test(label) || (Number.isInteger(entry.ConfigManagerErrorCode) && entry.ConfigManagerErrorCode !== 0)) continue;
    const integrated = /\bIntel\b.*\b(?:UHD|HD|Iris)\b|\bIris\b/i.test(label);
    const discrete = /\b(?:RTX|GTX|Quadro|Tesla|Titan)\b|\bArc\s+[AB]\d{3}\b/i.test(label);
    devices.push({ kind: integrated ? 'integrated' : discrete ? 'discrete' : 'unknown', name: label, vramBytes: null, accelerationHint: null });
    warnings.push('gpu_vram_unreliable');
  }
  return summary(devices, warnings);
}

/** AMD sysfs reports the driver's VRAM heap. It does not identify an APU as discrete. */
export function parseLinuxAMD(entries, { kfd = false } = {}) {
  const devices = [], warnings = [];
  for (const entry of Array.isArray(entries) ? entries.slice(0, 16) : []) {
    if (String(entry?.vendor).trim().toLowerCase() !== '0x1002') continue;
    const raw = String(entry.vramBytes ?? '').trim();
    const capacity = /^\d+$/.test(raw) ? positive(Number(raw)) : null;
    devices.push({ kind: 'unknown', name: name(entry.productName) ?? 'AMD GPU', vramBytes: capacity, accelerationHint: kfd && entry.driver === 'amdgpu' ? 'rocm' : null });
    warnings.push('gpu_classification_unknown');
    if (!capacity) warnings.push('gpu_vram_unavailable');
  }
  return summary(devices, warnings);
}

const bounded = async (operation, milliseconds) => {
  let timer;
  try { return await Promise.race([Promise.resolve().then(operation), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('hardware_timeout')), milliseconds); })]); }
  finally { clearTimeout(timer); }
};
const command = async (file, args, timeout = 3500) => {
  const { stdout } = await runFile(file, args, { timeout, maxBuffer: 262_144, encoding: 'utf8', windowsHide: true, shell: false });
  return stdout;
};
const defaults = () => ({ platform: os.platform(), arch: os.arch(), release: os.release, cpus: os.cpus,
  parallelism: os.availableParallelism, totalmem: os.totalmem, freemem: os.freemem, homedir: os.homedir,
  statfs, readFile, readdir, stat, command, env: process.env });

async function linuxAMD(deps) {
  const cards = (await deps.readdir('/sys/class/drm')).filter(value => typeof value === 'string' && /^card\d+$/.test(value)).slice(0, 16);
  const text = async path => { try { return (await deps.readFile(path, 'utf8')).trim().slice(0, 1024); } catch { return ''; } };
  const entries = await Promise.all(cards.map(async card => {
    const device = join('/sys/class/drm', card, 'device');
    const vendor = await text(join(device, 'vendor'));
    if (vendor !== '0x1002') return null;
    const [vramBytes, productName, uevent] = await Promise.all([text(join(device, 'mem_info_vram_total')), text(join(device, 'product_name')), text(join(device, 'uevent'))]);
    return { vendor, vramBytes, productName, driver: uevent.match(/^DRIVER=(\w+)$/m)?.[1] ?? '' };
  }));
  let kfd = false; try { kfd = (await deps.stat('/dev/kfd')).isCharacterDevice(); } catch { /* A missing node is not evidence of ROCm support. */ }
  return parseLinuxAMD(entries.filter(Boolean), { kfd });
}

async function gpuProfile(deps) {
  if (deps.platform === 'darwin') {
    try { return parseMacDisplays(await deps.command('/usr/sbin/system_profiler', ['SPDisplaysDataType', '-json', '-detailLevel', 'mini', '-timeout', '5'], 6000), deps.arch); }
    catch { return { gpu: unknownGPU(), warnings: ['gpu_detection_unavailable'] }; }
  }
  if (!['linux', 'win32'].includes(deps.platform)) return { gpu: unknownGPU(), warnings: ['gpu_detection_unavailable'] };
  const nvidia = async () => {
    try { return parseNvidiaSMI(await deps.command('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'], 3500)); }
    catch { return summary([]); }
  };
  const fallback = async () => {
    try {
      if (deps.platform === 'linux') return await bounded(() => linuxAMD(deps), 1800);
      const executable = win32.join(deps.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
      const query = "$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); Get-CimInstance -ClassName Win32_VideoController | Select-Object Name,AdapterCompatibility,AdapterRAM,VideoProcessor,ConfigManagerErrorCode | ConvertTo-Json -Depth 3 -Compress";
      return parseWindowsControllers(await deps.command(executable, ['-NoProfile', '-NonInteractive', '-Command', query], 3500));
    } catch { return summary([]); }
  };
  const [primary, secondary] = await Promise.all([nvidia(), fallback()]);
  if (primary.gpu.name) {
    // Prefer measured VRAM over CIM, while noting a separate adapter if found.
    if (secondary.warnings.includes('gpu_multiple_devices') || (secondary.gpu.name && secondary.gpu.name.toLowerCase() !== primary.gpu.name.toLowerCase())) primary.warnings = unique([...primary.warnings, 'gpu_multiple_devices']);
    return primary;
  }
  if (secondary.gpu.name) return secondary;
  return { gpu: unknownGPU(), warnings: ['gpu_detection_unavailable'] };
}

/** Internal dependency injection permits cross-platform fixtures without running foreign commands. */
export function createHardwareInspector(overrides = {}) {
  const deps = { ...defaults(), ...overrides };
  return async function inspect({ storagePath } = {}) {
    const warnings = []; let cpuName = null, cores = null, totalBytes = null, freeBytes = null;
    let cpus;
    try { cpus = deps.cpus(); cpuName = name(cpus?.[0]?.model); } catch { warnings.push('cpu_detection_unavailable'); }
    try { cores = positive(deps.parallelism?.()); } catch { /* Fall back to the logical processor list. */ }
    if (!Number.isInteger(cores)) cores = positive(cpus?.length);
    try { totalBytes = positive(deps.totalmem()); } catch { /* Unknown stays unknown. */ }
    try { freeBytes = number(deps.freemem()); } catch { /* Unknown stays unknown. */ }
    if (freeBytes !== null && totalBytes !== null && freeBytes > totalBytes) freeBytes = null;
    if (totalBytes === null || freeBytes === null) warnings.push('memory_detection_unavailable');
    let path = deps.homedir();
    if (storagePath !== undefined) {
      const pathAPI = deps.platform === 'win32' ? win32 : { isAbsolute, resolve };
      if (typeof storagePath === 'string' && storagePath.length <= 32768 && pathAPI.isAbsolute(storagePath)) path = pathAPI.resolve(storagePath);
      else warnings.push('storage_path_invalid');
    }
    const storage = async () => {
      try {
        const value = await bounded(() => deps.statfs(path, { bigint: true }), 1800);
        const blocks = BigInt(value.bavail), size = BigInt(value.bsize);
        const bytes = blocks >= 0n && size > 0n ? blocks * size : -1n;
        const measured = bytes >= 0n && bytes <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(bytes) : null;
        if (measured === null) warnings.push('storage_detection_unavailable');
        return { freeBytes: measured, path };
      } catch { warnings.push('storage_detection_unavailable'); return { freeBytes: null, path }; }
    };
    const version = async () => {
      try {
        // A Darwin kernel release is never substituted for a macOS product version.
        return name(deps.platform === 'darwin' ? await deps.command('/usr/bin/sw_vers', ['-productVersion'], 2000) : deps.release());
      } catch { warnings.push('os_version_unavailable'); return null; }
    };
    const [disk, gpu, osVersion] = await Promise.all([storage(), gpuProfile(deps), version()]);
    return { platform: deps.platform, arch: deps.arch, osVersion, cpu: { name: cpuName, cores },
      memory: { totalBytes, freeBytes }, storage: disk, gpu: gpu.gpu, warnings: unique([...warnings, ...gpu.warnings]) };
  };
}

/** One local snapshot; no persistence, networking, installation, or backend launch. */
export const inspectHardware = createHardwareInspector();

/** Recommendation from caller-supplied model estimates, never a runtime guarantee. */
export function assessLocalModel(hardware, requirements = {}) {
  const reasons = ['resource_estimates_only']; let insufficient = false, unknown = false, slow = false;
  const download = number(requirements.downloadBytes), working = positive(requirements.estimatedWorkingBytes);
  const minimum = positive(requirements.minTotalMemoryBytes), recommended = positive(requirements.recommendedMemoryBytes);
  const total = positive(hardware?.memory?.totalBytes), free = number(hardware?.memory?.freeBytes);
  const disk = number(hardware?.storage?.freeBytes);
  const requiredDiskBytes = download !== null && download <= (Number.MAX_SAFE_INTEGER - GiB) / 2 ? Math.ceil(download * 2 + GiB) : null;
  if (requiredDiskBytes === null) { reasons.push('model_download_size_unknown'); unknown = true; }
  else if (disk === null) { reasons.push('storage_unknown'); unknown = true; }
  else if (disk < requiredDiskBytes) { reasons.push('storage_below_required'); insufficient = true; }
  if (total === null || minimum === null || working === null) { reasons.push('memory_requirements_unknown'); unknown = true; }
  else {
    if (total < minimum) { reasons.push('memory_below_minimum'); insufficient = true; }
    if (total < working) { reasons.push('working_memory_above_total'); insufficient = true; }
    if (recommended !== null && total < Math.max(minimum, recommended)) { reasons.push('memory_below_recommended'); slow = true; }
    if (free === null || free > total) { reasons.push('free_memory_unknown'); unknown = true; }
    else if (free < working) { reasons.push('free_memory_low'); slow = true; }
  }
  const hint = ['metal', 'cuda', 'rocm'].includes(hardware?.gpu?.accelerationHint) ? hardware.gpu.accelerationHint : null;
  if (hint) reasons.push('gpu_backend_unverified');
  else if (requirements.requiresGPU === true) { reasons.push('gpu_requirement_unverified'); unknown = true; }
  else { reasons.push('cpu_only_slow'); slow = true; }
  return { status: insufficient ? 'insufficient' : unknown ? 'unknown' : slow ? 'slow' : 'recommended', reasons: unique(reasons), requiredDiskBytes };
}
