import test from 'node:test';
import assert from 'node:assert/strict';
import { createHardwareInspector, parseMacDisplays, parseNvidiaSMI, parseWindowsControllers, parseLinuxAMD, assessLocalModel } from '../desktop/hardware-profile.mjs';

const GiB = 1024 ** 3, MiB = 1024 ** 2;
const missing = () => { throw Object.assign(new Error('Unavailable'), { code: 'ENOENT' }); };
const base = (overrides = {}) => ({ platform: 'linux', arch: 'x64', release: () => '6.8.0-fixture',
  cpus: () => [{ model: 'Test CPU\u0000 model' }, { model: 'Test CPU model' }], parallelism: () => 8,
  totalmem: () => 32 * GiB, freemem: () => 24 * GiB, homedir: () => '/home/test',
  statfs: async () => ({ bavail: 100n * BigInt(GiB), bsize: 1n }), readdir: async () => [], readFile: async () => missing(), stat: async () => missing(),
  command: async () => missing(), env: {}, ...overrides });
const hardware = (overrides = {}) => ({ memory: { totalBytes: 32 * GiB, freeBytes: 24 * GiB }, storage: { freeBytes: 100 * GiB },
  gpu: { kind: 'discrete', name: 'NVIDIA test', vramBytes: 12 * GiB, accelerationHint: 'cuda' }, ...overrides });
const model = (overrides = {}) => ({ downloadBytes: 3 * GiB, estimatedWorkingBytes: 8 * GiB, minTotalMemoryBytes: 16 * GiB,
  recommendedMemoryBytes: 24 * GiB, requiresGPU: false, ...overrides });

test('Apple Silicon reports unified memory without inventing a VRAM capacity or retaining serials', () => {
  const result = parseMacDisplays({ SPDisplaysDataType: [{ _name: 'Apple M3 Pro', sppci_model: 'Apple M3 Pro',
    spdisplays_vendor: 'sppci_vendor_Apple', spdisplays_vram_shared: '36 GB', spdisplays_vram: '36 GB',
    spdisplays_metal: 'spdisplays_supported', serial_number: 'PRIVATE-SERIAL', spdisplays_ndrvs: [{ _spdisplays_displayID: 'PRIVATE-DISPLAY' }] }] }, 'arm64');
  assert.deepEqual(result.gpu, { kind: 'unified', name: 'Apple M3 Pro', vramBytes: null, accelerationHint: 'metal' });
  assert.ok(result.warnings.includes('gpu_unified_memory_shared'));
  assert.ok(!JSON.stringify(result).includes('PRIVATE'));
});

test('Intel Mac shared memory and a discrete AMD Mac retain different semantics', () => {
  const result = parseMacDisplays(JSON.stringify({ SPDisplaysDataType: [
    { sppci_model: 'Intel Iris Plus Graphics 655', spdisplays_vram_shared: '1536 MB', spdisplays_metal: 'spdisplays_supported' },
    { sppci_model: 'AMD Radeon Pro 5500M', spdisplays_vram: '8 GB', spdisplays_mtlgpufamilysupport: 'spdisplays_metal_feature_set_osx_gpufamily2_v1' }
  ] }), 'x64');
  assert.equal(result.gpu.kind, 'discrete'); assert.equal(result.gpu.vramBytes, 8 * GiB); assert.equal(result.gpu.accelerationHint, 'metal');
  assert.ok(result.warnings.includes('gpu_multiple_devices'));
  const integrated = parseMacDisplays({ SPDisplaysDataType: [{ sppci_model: 'Intel HD Graphics', spdisplays_vram_shared: '1536 MB', spdisplays_metal: 'spdisplays_unsupported' }] }, 'x64');
  assert.equal(integrated.gpu.kind, 'integrated'); assert.equal(integrated.gpu.vramBytes, null); assert.equal(integrated.gpu.accelerationHint, null);
});

test('NVIDIA CSV handles quoted names and selects one measured GPU without summing VRAM', () => {
  const result = parseNvidiaSMI('NVIDIA GeForce RTX 4060, 8192, 550.54\n"NVIDIA workstation, adapter", 24576, 551.02\n');
  assert.equal(result.gpu.name, 'NVIDIA workstation, adapter'); assert.equal(result.gpu.vramBytes, 24576 * MiB);
  assert.equal(result.gpu.accelerationHint, 'cuda'); assert.equal(result.gpu.kind, 'discrete');
  assert.ok(result.warnings.includes('gpu_multiple_devices'));
  assert.equal(parseNvidiaSMI('NVIDIA GPU, [N/A], 551.02').gpu.vramBytes, null);
  for (const invalid of ['', 'NVIDIA-SMI has failed', 'name, memory.total, driver_version', '"unclosed,8192,550.54']) assert.equal(parseNvidiaSMI(invalid).gpu.kind, 'unknown');
});

test('Windows CIM AdapterRAM is never mistaken for a reliable dedicated VRAM measurement', () => {
  const result = parseWindowsControllers(JSON.stringify([{ Name: 'Intel Iris Xe Graphics', AdapterRAM: 1024 * MiB },
    { Name: 'NVIDIA GeForce RTX 4090', AdapterRAM: 4 * GiB - 1, ConfigManagerErrorCode: 0, PNPDeviceID: 'PRIVATE-ID' }]));
  assert.equal(result.gpu.name, 'NVIDIA GeForce RTX 4090'); assert.equal(result.gpu.kind, 'discrete');
  assert.equal(result.gpu.vramBytes, null); assert.equal(result.gpu.accelerationHint, null);
  assert.ok(result.warnings.includes('gpu_vram_unreliable')); assert.ok(!JSON.stringify(result).includes('PRIVATE'));
  for (const memory of [0, 2 * GiB, 8 * GiB, 24 * GiB, NaN]) assert.equal(parseWindowsControllers({ Name: 'AMD Radeon RX 7900 XTX', AdapterRAM: memory }).gpu.vramBytes, null);
  assert.equal(parseWindowsControllers([{ Name: 'Microsoft Basic Display Adapter' }, { Name: 'NVIDIA RTX', ConfigManagerErrorCode: 22 }]).gpu.kind, 'unknown');
});

test('AMD sysfs VRAM is measured only from its explicit heap; classification and ROCm remain cautious', () => {
  const result = parseLinuxAMD([{ vendor: '0x1002', productName: 'AMD test GPU', vramBytes: String(16 * GiB), driver: 'amdgpu' }], { kfd: true });
  assert.equal(result.gpu.vramBytes, 16 * GiB); assert.equal(result.gpu.kind, 'unknown'); assert.equal(result.gpu.accelerationHint, 'rocm');
  assert.ok(result.warnings.includes('gpu_classification_unknown'));
  assert.equal(parseLinuxAMD([{ vendor: '0x1002', driver: 'amdgpu' }]).gpu.vramBytes, null);
  assert.equal(parseLinuxAMD([{ vendor: '0x1002', vramBytes: '-1', driver: 'amdgpu' }]).gpu.accelerationHint, null);
  assert.equal(parseLinuxAMD([{ vendor: '0x8086', vramBytes: String(32 * GiB) }]).gpu.kind, 'unknown');
});

test('Mac inspector uses only fixed commands, mini privacy level, and the actual macOS product version', async () => {
  const commands = [];
  const inspect = createHardwareInspector(base({ platform: 'darwin', arch: 'arm64', release: () => '25.0.0', command: async (file, args, timeout) => {
    commands.push({ file, args, timeout });
    if (file === '/usr/bin/sw_vers') return '15.6.1\n';
    if (file === '/usr/sbin/system_profiler') return JSON.stringify({ SPDisplaysDataType: [{ sppci_model: 'Apple M3 Pro', spdisplays_metal: 'spdisplays_supported' }] });
    return missing();
  } }));
  const result = await inspect({ storagePath: '/models' });
  assert.equal(result.osVersion, '15.6.1'); assert.equal(result.gpu.kind, 'unified'); assert.equal(result.gpu.vramBytes, null);
  assert.equal(result.cpu.name, 'Test CPU model'); assert.equal(result.cpu.cores, 8); assert.equal(result.storage.path, '/models');
  assert.ok(commands.every(value => value.timeout <= 6000));
  assert.deepEqual(commands.find(value => value.file.endsWith('system_profiler')).args, ['SPDisplaysDataType', '-json', '-detailLevel', 'mini', '-timeout', '5']);
  assert.equal(commands.find(value => value.file.endsWith('sw_vers')).timeout, 2000);
  const unavailable = await createHardwareInspector(base({ platform: 'darwin', release: () => '25.0.0' }))();
  assert.equal(unavailable.osVersion, null, 'Darwin version must not masquerade as macOS');
  assert.ok(unavailable.warnings.includes('os_version_unavailable'));
});

test('Linux inspector reads bounded AMD sysfs fields and reports the kernel without inventing a distribution', async () => {
  const paths = [];
  const inspect = createHardwareInspector(base({ readdir: async () => ['card0', 'card0-DP-1', 'card../escape', 'renderD128'],
    readFile: async path => { paths.push(path); if (path.endsWith('/vendor')) return '0x1002\n'; if (path.endsWith('/mem_info_vram_total')) return String(12 * GiB); if (path.endsWith('/product_name')) return 'AMD Radeon test'; if (path.endsWith('/uevent')) return 'DRIVER=amdgpu\n'; return missing(); },
    stat: async () => ({ isCharacterDevice: () => true }) }));
  const result = await inspect();
  assert.equal(result.osVersion, '6.8.0-fixture'); assert.equal(result.gpu.vramBytes, 12 * GiB); assert.equal(result.gpu.accelerationHint, 'rocm');
  assert.ok(paths.every(path => path.startsWith('/sys/class/drm/card0/device/')));
  assert.ok(paths.every(path => !/serial|unique_id/.test(path)));
});

test('Windows inspector prefers nvidia-smi VRAM, preserves drive paths and returns the NT build', async () => {
  let measuredPath; const calls = [];
  const inspect = createHardwareInspector(base({ platform: 'win32', release: () => '10.0.19045', homedir: () => 'C:\\Users\\Test',
    statfs: async path => { measuredPath = path; return { bavail: 4096n, bsize: 4096n }; },
    command: async (file, args, timeout) => { calls.push({ file, args, timeout }); if (file === 'nvidia-smi') return 'NVIDIA GeForce RTX 4090, 24576, 573.49'; return JSON.stringify({ Name: 'NVIDIA GeForce RTX 4090', AdapterRAM: 4 * GiB - 1 }); } }));
  const result = await inspect({ storagePath: 'D:\\Models' });
  assert.equal(measuredPath, 'D:\\Models'); assert.equal(result.storage.path, 'D:\\Models'); assert.equal(result.storage.freeBytes, 16 * MiB);
  assert.equal(result.osVersion, '10.0.19045'); assert.equal(result.gpu.vramBytes, 24 * GiB);
  assert.ok(!result.warnings.includes('gpu_vram_unreliable'));
  const cim = calls.find(value => value.file.endsWith('powershell.exe'));
  assert.ok(cim.args.includes('-NoProfile') && cim.args.includes('-NonInteractive')); assert.ok(!cim.args.join(' ').includes('PNPDeviceID'));
  assert.deepEqual(calls.find(value => value.file === 'nvidia-smi').args, ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits']);
});

test('missing, invalid and overflowing resource measurements remain unknown', async () => {
  const result = await createHardwareInspector(base({ totalmem: () => NaN, freemem: () => Infinity,
    statfs: async () => ({ bavail: 2n ** 80n, bsize: 4096n }) }))({ storagePath: '../../invalid' });
  assert.equal(result.memory.totalBytes, null); assert.equal(result.memory.freeBytes, null); assert.equal(result.storage.freeBytes, null);
  assert.equal(result.storage.path, '/home/test'); assert.equal(result.gpu.kind, 'unknown'); assert.equal(result.gpu.vramBytes, null);
  for (const code of ['storage_path_invalid', 'storage_detection_unavailable', 'memory_detection_unavailable', 'gpu_detection_unavailable']) assert.ok(result.warnings.includes(code));
  const unavailable = await createHardwareInspector(base({ parallelism: missing, freemem: () => 64 * GiB, statfs: missing }))();
  assert.equal(unavailable.cpu.cores, 2); assert.equal(unavailable.memory.freeBytes, null); assert.equal(unavailable.storage.freeBytes, null);
});

test('a stalled filesystem measurement cannot leave the hardware snapshot pending indefinitely', async () => {
  const started = performance.now();
  const result = await createHardwareInspector(base({ statfs: () => new Promise(() => {}) }))();
  assert.equal(result.storage.freeBytes, null);
  assert.ok(result.warnings.includes('storage_detection_unavailable'));
  assert.ok(performance.now() - started < 8000);
});

test('model recommendation uses supplied estimates and a two-download-plus-one-GiB disk budget', () => {
  const result = assessLocalModel(hardware(), model());
  assert.equal(result.status, 'recommended'); assert.equal(result.requiredDiskBytes, 7 * GiB);
  assert.ok(result.reasons.includes('resource_estimates_only')); assert.ok(result.reasons.includes('gpu_backend_unverified'));
  assert.equal(assessLocalModel(hardware({ storage: { freeBytes: 7 * GiB - 1 } }), model()).status, 'insufficient');
  assert.equal(assessLocalModel(hardware({ storage: { freeBytes: 0 } }), model()).status, 'insufficient');
});

test('an 8-GiB computer cannot be falsely offered a 20-GiB working model', () => {
  const result = assessLocalModel(hardware({ memory: { totalBytes: 8 * GiB, freeBytes: 7 * GiB } }), model({ estimatedWorkingBytes: 20 * GiB, minTotalMemoryBytes: 24 * GiB }));
  assert.equal(result.status, 'insufficient'); assert.ok(result.reasons.includes('memory_below_minimum')); assert.ok(result.reasons.includes('working_memory_above_total'));
  const tiny = assessLocalModel(hardware({ memory: { totalBytes: 8 * GiB, freeBytes: 6 * GiB } }), model({ estimatedWorkingBytes: 4 * GiB, minTotalMemoryBytes: 8 * GiB, recommendedMemoryBytes: 8 * GiB }));
  assert.equal(tiny.status, 'recommended', 'Thresholds come from each model, not universal hard-coded capacities');
});

test('free-memory pressure, optional CPU inference and unknown measurements never claim sufficient resources', () => {
  const pressure = assessLocalModel(hardware({ memory: { totalBytes: 64 * GiB, freeBytes: 2 * GiB } }), model());
  assert.equal(pressure.status, 'slow'); assert.ok(pressure.reasons.includes('free_memory_low'));
  const cpu = assessLocalModel(hardware({ gpu: { kind: 'unknown', name: null, vramBytes: null, accelerationHint: null } }), model());
  assert.equal(cpu.status, 'slow'); assert.ok(cpu.reasons.includes('cpu_only_slow'));
  assert.equal(assessLocalModel(hardware({ gpu: { kind: 'unknown' } }), model({ requiresGPU: true })).status, 'unknown');
  assert.equal(assessLocalModel(hardware({ memory: { totalBytes: 64 * GiB, freeBytes: null } }), model()).status, 'unknown');
  assert.equal(assessLocalModel(hardware({ storage: { freeBytes: null } }), model()).status, 'unknown');
  assert.equal(assessLocalModel({}, {}).status, 'unknown');
  assert.equal(assessLocalModel(hardware(), model({ downloadBytes: Infinity })).requiredDiskBytes, null);
});
