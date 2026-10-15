import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, writeFile, copyFile, chmod, symlink, realpath, stat, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createRequire} from 'node:module';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const runFile=promisify(execFile);
const require=createRequire(import.meta.url);
const launcher=join(root,'build','linux','AppRun');
const skip=process.platform==='win32'?'POSIX launcher runs on Linux and macOS':false;

async function fixture(check){
  const directory=await realpath(await mkdtemp(join(tmpdir(),'atelier-apprun-')));
  try{
    const appDir=join(directory,'Application avec espaces et apostrophe\'s');
    const tools=join(directory,'host-tools');
    await mkdir(appDir);await mkdir(tools);
    await copyFile(launcher,join(appDir,'AppRun'));await chmod(join(appDir,'AppRun'),0o755);
    const capture=join(directory,'captured.json'),probe=join(directory,'unshare-called');
    // The stub records the actual process arguments and environment, without Electron.
    await writeFile(join(appDir,'atelier-photo'),`#!${process.execPath}\nconst fs=require('node:fs');fs.writeFileSync(process.env.ATELIER_CAPTURE,JSON.stringify({args:process.argv.slice(2),env:{APPDIR:process.env.APPDIR,PATH:process.env.PATH,XDG_DATA_DIRS:process.env.XDG_DATA_DIRS,LD_LIBRARY_PATH:process.env.LD_LIBRARY_PATH}}));process.exit(Number(process.env.ATELIER_STUB_EXIT||0));\n`);
    await chmod(join(appDir,'atelier-photo'),0o755);
    await writeFile(join(tools,'unshare'),'#!/bin/sh\nprintf called > "$ATELIER_PROBE"\nexit 1\n');
    await chmod(join(tools,'unshare'),0o755);
    const env={...process.env,ATELIER_CAPTURE:capture,ATELIER_PROBE:probe,PATH:`${tools}:/usr/bin:/bin`,XDG_DATA_DIRS:'/host/share',LD_LIBRARY_PATH:'/host/lib'};
    delete env.APPDIR;
    await check({directory,appDir,tools,capture,probe,env});
  }finally{await rm(directory,{recursive:true,force:true});}
}

test('AppImage packaging opts out of generated sandbox overrides',async()=>{
  const packageJSON=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  assert.deepEqual(packageJSON.build.appImage.executableArgs,[]);
  assert.ok(packageJSON.build.linux.extraFiles.some(item=>item.from==='build/linux/AppRun'&&item.to==='AppRun'));
  assert.equal(packageJSON.build.linux.executableName??packageJSON.name,'atelier-photo');
});

test('electron-builder generates a desktop entry without extra executable arguments',async()=>{
  const packageJSON=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
  const AppImageTarget=require('app-builder-lib/out/targets/appimage/AppImageTarget.js').default;
  const packager={config:packageJSON.build,platformSpecificBuildOptions:packageJSON.build.linux,appInfo:{buildVersion:packageJSON.version}};
  const helper={computeDesktopEntry:async(options,exec)=>exec};
  const target=new AppImageTarget('AppImage',packager,helper,tmpdir());
  assert.equal(await target.desktopEntry.value,'AppRun %U');
});

test('electron-builder app directory copy replaces its generated AppRun',{skip},async()=>fixture(async({directory,appDir})=>{
  const {copyDir}=require('builder-util');
  const {generateAppRunScript}=require('app-builder-lib/out/targets/appimage/appImageUtil.js');
  const stage=join(directory,'AppImage stage');await mkdir(stage);
  await writeFile(join(stage,'AppRun'),generateAppRunScript({ExecutableName:'atelier-photo',ProductFilename:'Atelier Photo',ProductName:'Atelier Photo'}),{mode:0o755});
  await copyDir(appDir,stage);
  assert.deepEqual(await readFile(join(stage,'AppRun')),await readFile(launcher));
  assert.ok((await stat(join(stage,'AppRun'))).mode&0o111);
}));

test('AppRun preserves arguments and sandbox defaults when host unshare would fail',{skip},async()=>fixture(async({directory,appDir,capture,probe,env})=>{
  const args=['--test-native-backend','photo avec espaces.tiff','',"apostrophe's",'$(touch unexpected)', '--option=value with spaces'];
  await runFile(join(appDir,'AppRun'),args,{cwd:directory,env,timeout:10000});
  const recorded=JSON.parse(await readFile(capture,'utf8'));
  assert.deepEqual(recorded.args,args);
  assert.equal(recorded.env.APPDIR,appDir);
  assert.equal(recorded.env.PATH,`${appDir}:${appDir}/usr/sbin:${env.PATH}`);
  assert.equal(recorded.env.XDG_DATA_DIRS,`${appDir}/usr/share:/host/share:/usr/share/gnome:/usr/local/share:/usr/share`);
  assert.equal(recorded.env.LD_LIBRARY_PATH,`${appDir}/usr/lib:/host/lib`);
  await assert.rejects(readFile(probe),{code:'ENOENT'});
}));

test('AppRun honors APPDIR and does not add arguments on an empty invocation',{skip},async()=>fixture(async({directory,appDir,capture,env})=>{
  const elsewhere=join(directory,'launcher elsewhere');await copyFile(launcher,elsewhere);await chmod(elsewhere,0o755);
  await runFile(elsewhere,[],{cwd:directory,env:{...env,APPDIR:appDir,XDG_DATA_DIRS:'',LD_LIBRARY_PATH:''},timeout:10000});
  const recorded=JSON.parse(await readFile(capture,'utf8'));
  assert.deepEqual(recorded.args,[]);
  assert.equal(recorded.env.LD_LIBRARY_PATH,`${appDir}/usr/lib`);
  assert.equal(recorded.env.XDG_DATA_DIRS,`${appDir}/usr/share:/usr/share/gnome:/usr/local/share:/usr/share`);
}));

test('AppRun resolves relative symlinks from a different working directory',{skip},async()=>fixture(async({directory,appDir,capture,env})=>{
  const links=join(directory,'links');await mkdir(links);
  await symlink(`../${appDir.split('/').at(-1)}/AppRun`,join(links,'atelier-launcher'));
  await runFile(join(links,'atelier-launcher'),['file:///photo%20test.tiff'],{cwd:tmpdir(),env,timeout:10000});
  assert.deepEqual(JSON.parse(await readFile(capture,'utf8')).args,['file:///photo%20test.tiff']);
}));

test('AppRun propagates application failure without retrying with different flags',{skip},async()=>fixture(async({directory,appDir,capture,probe,env})=>{
  await assert.rejects(runFile(join(appDir,'AppRun'),[],{cwd:directory,env:{...env,ATELIER_STUB_EXIT:'42'},timeout:10000}),error=>error.code===42);
  assert.deepEqual(JSON.parse(await readFile(capture,'utf8')).args,[]);
  await assert.rejects(readFile(probe),{code:'ENOENT'});
}));

test('AppRun fails when its application executable is absent',{skip},async()=>fixture(async({directory,appDir,capture,env})=>{
  await rm(join(appDir,'atelier-photo'));
  await assert.rejects(runFile(join(appDir,'AppRun'),[],{cwd:directory,env,timeout:10000}),error=>error.code===127&&error.stderr.includes('executable is missing'));
  await assert.rejects(readFile(capture),{code:'ENOENT'});
}));
