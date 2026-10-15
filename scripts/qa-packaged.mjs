/** Final-delivery QA, restricted to disposable GitHub Actions runners.
 * --check-plan verifies path/argument plans without installing, GUI or sockets.
 * Windows: final ZIP + RAW/local AI; actual NSIS install + RAW; app-local CRT DLLs.
 * Linux: actual DEB install + RAW/local AI, followed by package purge.
 * Run the Linux command through xvfb-run; no sandbox/security bypass is added.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, basename, isAbsolute, win32, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const packageJSON=JSON.parse(await readFile(join(root,'package.json'),'utf8'));
const flags=new Set(process.argv.slice(2));

function plan({platform=process.platform,arch=process.arch,directory=root,manifest=packageJSON}={}){
  const path=platform==='win32'?win32:posix;
  assert.ok(path.isAbsolute(directory),'The repository path must be absolute.');
  assert.match(manifest.version,/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  const product=manifest.build?.productName;
  assert.ok(typeof product==='string'&&product.length>0&&!/[\\/\x00-\x1f]/.test(product));
  if(platform==='darwin')return {skip:true,reason:'Mac GUI delivery QA is performed separately.'};
  assert.ok(['win32','linux'].includes(platform),'Final package QA supports Windows and Linux runners.');
  assert.equal(arch,'x64','Only the validated Windows/Linux x64 delivery targets are covered.');
  const prefix=`AtelierPhoto-${manifest.version}-${platform==='win32'?'win':'linux'}-x64`;
  return platform==='win32'?{platform,product,zip:path.join(directory,'release',prefix+'.zip'),installer:path.join(directory,'release',prefix+'.exe'),executable:product+'.exe'}
    :{platform,product,deb:path.join(directory,'release',`AtelierPhoto-${manifest.version}-linux-amd64.deb`),appImage:path.join(directory,'release',`AtelierPhoto-${manifest.version}-linux-x86_64.AppImage`),packageName:manifest.name,executable:manifest.build.linux.executableName||manifest.name};
}
function nsisArguments(directory,uninstall=false){
  assert.ok(win32.isAbsolute(directory)&&!/["\r\n\0]/.test(directory),'NSIS needs an absolute unquoted destination.');
  // NSIS requires /D= and _?= last, with no surrounding quotes, even with spaces.
  // https://nsis.sourceforge.io/Docs/Chapter3.html#installerusage
  return uninstall?['/S','/KEEP_APP_DATA',`_?=${directory}`]:['/S',`/D=${directory}`];
}
async function run(file,args,{environment=process.env,timeout=300000,verbatim=false,quiet=false,workingDirectory=root}={}){
  const options={cwd:workingDirectory,env:environment,timeout,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe']};
  if(verbatim){options.windowsVerbatimArguments=true;options.argv0=`"${file}"`;}
  // spawn forwards argv0; execFile does not. This keeps the executable itself
  // quoted when its path has spaces, while leaving NSIS's final /D or _?= raw.
  return new Promise((resolveRun,reject)=>{
    const child=spawn(file,args,options),stdout=[],stderr=[];let length=0,settled=false;
    const fail=error=>{if(!settled){settled=true;reject(error);}};
    const collect=target=>chunk=>{length+=chunk.length;if(length>16*1024*1024){child.kill();fail(new Error(`${basename(file)} produced too much output.`));}else target.push(Buffer.from(chunk));};
    child.stdout.on('data',collect(stdout));child.stderr.on('data',collect(stderr));child.once('error',fail);
    child.once('close',(code,signal)=>{
      if(settled)return;settled=true;
      const out=Buffer.concat(stdout).toString('utf8').trim(),err=Buffer.concat(stderr).toString('utf8').trim();
      if(!quiet){if(out)console.log(out);if(err)console.error(err);}
      if(code!==0)reject(new Error(`${basename(file)} failed (${code??signal??'unknown'}).`));else resolveRun(out);
    });
  });
}
async function exists(path){try{return(await stat(path)).isFile();}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function deliveredFile(path){assert.ok(isAbsolute(path)&&await exists(path),`Final package not found: ${path}`);return realpath(path);}
function qaEnvironment(executable,verifyDLLs=false){
  const environment={...process.env,ATELIER_PACKAGED_EXE:executable};
  for(const name of ['ELECTRON_RUN_AS_NODE','ATELIER_TEST_DATA','ATELIER_VERIFY_NATIVE_DLLS','OPENAI_API_KEY','GEMINI_API_KEY','GOOGLE_API_KEY','ANTHROPIC_API_KEY','CLAUDE_API_KEY'])delete environment[name];
  if(verifyDLLs)environment.ATELIER_VERIFY_NATIVE_DLLS='1';
  return environment;
}
async function exercise(executable,{localAI=true,verifyDLLs=false,label}={}){
  executable=await deliveredFile(executable);
  console.log(`Checking ${label}: ${executable}`);
  await run(process.execPath,[join(root,'Tests','raw-electron.mjs')],{environment:qaEnvironment(executable,verifyDLLs)});
  if(localAI)await run(process.execPath,[join(root,'Tests','local-ai-electron.mjs')],{environment:qaEnvironment(executable)});
}

async function windowsQA(target,temporary){
  const archive=await deliveredFile(target.zip),installer=await deliveredFile(target.installer);
  const extracted=join(temporary,'zip'),installed=join(temporary,'nsis',target.product);
  await mkdir(extracted);
  const powershell=join(process.env.SystemRoot||'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe');
  const ensureFresh=()=>run(powershell,['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; $atelierRoots=@('HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall'); foreach($atelierRoot in $atelierRoots){ if(Test-Path -LiteralPath $atelierRoot){ foreach($atelierKey in Get-ChildItem -LiteralPath $atelierRoot){ $atelierItem=Get-ItemProperty -LiteralPath $atelierKey.PSPath; if($atelierItem.DisplayName -eq $env:ATELIER_QA_PRODUCT){ throw 'An existing Atelier Photo installation must not be replaced by package QA.' } } } }"],{environment:{...process.env,ATELIER_QA_PRODUCT:target.product},timeout:30000});
  await ensureFresh();
  // Parameters are passed as environment values, never interpolated into code.
  await run(powershell,['-NoProfile','-NonInteractive','-Command',"$ErrorActionPreference='Stop'; Expand-Archive -LiteralPath $env:ATELIER_QA_ARCHIVE -DestinationPath $env:ATELIER_QA_EXTRACTED"],{
    environment:{...process.env,ATELIER_QA_ARCHIVE:archive,ATELIER_QA_EXTRACTED:extracted},timeout:180000});
  await exercise(join(extracted,target.executable),{verifyDLLs:true,label:'final Windows ZIP'});
  let installStarted=false,failure;
  try{
    installStarted=true;
    await run(installer,nsisArguments(installed),{verbatim:true,timeout:180000});
    await exercise(join(installed,target.executable),{localAI:false,verifyDLLs:true,label:'installed Windows NSIS'});
  }catch(error){failure=error;}
  finally{
    if(installStarted){
      try{
        const uninstallers=(await readdir(installed)).filter(name=>/^Uninstall .+\.exe$/i.test(name));
        assert.equal(uninstallers.length,1,'The installed package must provide exactly one uninstaller.');
        await run(join(installed,uninstallers[0]),nsisArguments(installed,true),{verbatim:true,timeout:180000});
        await ensureFresh();
      }catch(error){failure=failure?new AggregateError([failure,error],'NSIS QA and cleanup failed.'):error;}
    }
  }
  if(failure)throw failure;
}
async function inspectFinalAppImage(target,temporary){
  const appImage=await deliveredFile(target.appImage),extracted=join(temporary,'appimage');
  await mkdir(extracted);
  await run(appImage,['--appimage-extract'],{workingDirectory:extracted,quiet:true,timeout:180000});
  const appDirectory=join(extracted,'squashfs-root');
  assert.deepEqual(await readFile(join(appDirectory,'AppRun')),await readFile(join(root,'build','linux','AppRun')),'The delivered AppImage must contain the reviewed AppRun byte-for-byte.');
  const desktops=(await readdir(appDirectory)).filter(name=>name.endsWith('.desktop'));
  assert.equal(desktops.length,1,'The final AppImage must have exactly one root desktop entry.');
  const desktop=await readFile(join(appDirectory,desktops[0]),'utf8');
  const launchLines=[...desktop.matchAll(/^\s*Exec\s*=\s*(.+)$/gm)].map(match=>match[1]);
  assert.ok(launchLines.length>0,'The delivered desktop entry must define its launch command.');
  assert.ok(launchLines.every(line=>!line.includes('--no-sandbox')),'The final desktop entry must preserve the Chromium sandbox.');
  console.log('ATELIER_FINAL_APPIMAGE_ENTRY_OK '+desktops[0]);
}
async function linuxQA(target,temporary){
  await inspectFinalAppImage(target,temporary);
  const deb=await deliveredFile(target.deb);
  const packageName=await run('dpkg-deb',['--field',deb,'Package'],{quiet:true});
  assert.match(packageName,/^[a-z0-9][a-z0-9+.-]*$/);assert.equal(packageName,target.packageName);
  let alreadyInstalled=false;
  try{await run('dpkg-query',['--status',packageName],{quiet:true});alreadyInstalled=true;}catch{}
  assert.equal(alreadyInstalled,false,'Refusing to replace an existing package, even on this runner.');
  let installStarted=false,failure;
  try{
    installStarted=true;
    await run('sudo',['apt-get','install','-y','--no-install-recommends',deb],{timeout:180000});
    const files=(await run('dpkg-query',['--listfiles',packageName],{quiet:true})).split(/\r?\n/);
    const candidates=[];
    for(const file of files){
      if(!isAbsolute(file)||basename(file)!==target.executable||!await exists(file))continue;
      const candidate=await realpath(file);if(!candidates.includes(candidate))candidates.push(candidate);
    }
    assert.equal(candidates.length,1,'The installed DEB must own one unambiguous application executable.');
    await exercise(candidates[0],{label:'installed Linux DEB'});
  }catch(error){failure=error;}
  finally{
    if(installStarted){try{await run('sudo',['apt-get','purge','-y',packageName],{timeout:180000});}catch(error){failure=failure?new AggregateError([failure,error],'DEB QA and cleanup failed.'):error;}}
  }
  if(failure)throw failure;
}

try{
  if(flags.has('--help'))console.log('node scripts/qa-packaged.mjs\n  Windows: final ZIP GUI + DLL provenance, NSIS installation/RAW/uninstall.\n  Linux: run under xvfb-run; DEB install, GUI RAW/local AI, purge.\n  --check-plan: safe cross-platform path and command assertions, no installation/GUI/socket.\n  Actual installation requires CI=true and GITHUB_ACTIONS=true; Mac is skipped.');
  else if(flags.has('--check-plan')){
    const windows=plan({platform:'win32',arch:'x64',directory:'C:\\runner workspace\\atelier-photo'});
    assert.equal(windows.zip,`C:\\runner workspace\\atelier-photo\\release\\AtelierPhoto-${packageJSON.version}-win-x64.zip`);
    assert.equal(windows.executable,'Atelier Photo.exe');
    const destination='C:\\runner temp\\atelier-package-qa-test\\nsis';
    assert.deepEqual(nsisArguments(destination),['/S',`/D=${destination}`]);
    assert.deepEqual(nsisArguments(destination,true),['/S','/KEEP_APP_DATA',`_?=${destination}`]);
    assert.throws(()=>nsisArguments('relative'));assert.throws(()=>nsisArguments('C:\\bad"path'));
    const linux=plan({platform:'linux',arch:'x64',directory:'/tmp/runner workspace/atelier-photo'});
    assert.equal(linux.deb,`/tmp/runner workspace/atelier-photo/release/AtelierPhoto-${packageJSON.version}-linux-amd64.deb`);
    assert.equal(linux.appImage,`/tmp/runner workspace/atelier-photo/release/AtelierPhoto-${packageJSON.version}-linux-x86_64.AppImage`);
    assert.equal(plan({platform:'darwin',arch:'arm64',directory:'/tmp/project'}).skip,true);
    assert.throws(()=>plan({platform:'linux',arch:'arm64',directory:'/tmp/project'}));
    console.log('Packaged QA plans verified for native Windows paths, spaces, NSIS argument order, Linux DEB, architecture limits and explicit Mac skip. No GUI, socket or installation launched.');
  }else{
    assert.equal(flags.size,0,'Unknown packaged QA option.');
    const target=plan();
    if(target.skip)console.log(target.reason);
    else{
      assert.equal(process.env.CI,'true','Package installation QA is restricted to disposable CI runners.');
      assert.equal(process.env.GITHUB_ACTIONS,'true','Package installation QA is restricted to GitHub Actions.');
      const temporary=await mkdtemp(join(process.env.RUNNER_TEMP||tmpdir(),'atelier-package-qa-'));
      try{if(target.platform==='win32')await windowsQA(target,temporary);else await linuxQA(target,temporary);}
      finally{await rm(temporary,{recursive:true,force:true,maxRetries:10,retryDelay:500});}
      console.log('ATELIER_FINAL_PACKAGES_OK '+target.platform);
    }
  }
}catch(error){console.error('Final package QA failed:',error.message);if(error instanceof AggregateError)for(const item of error.errors)console.error(item.message);process.exitCode=1;}
