import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline";

import { ConflictError, HttpError } from "../errors";
import { emit } from "../lifecycle/control";
import { platformProcess } from "../platform/nativeHelper";
import { EXIT_CODES, logHelperTimeout } from "../startupErrors";
import { regularPath } from "./pathSafety";

/** Losing the guard must stop the app: no file may change without it. The launcher shows its own explanation. */
function stopForStorageProtection(message: string): never {
  console.error(message);
  emit("error", { code: "STORAGE_PROTECTION" });
  process.exit(EXIT_CODES.STORAGE_PROTECTION);
}

/**
 * Windows refused access (installer finding: Controlled Folder Access, report §5.6). The native helper reports this
 * case; Node reports it as EPERM. Names the programs to allow instead of a generic storage message.
 */
export function accessDeniedError(): HttpError {
  return new HttpError(
    409,
    "Windows denied Coherence access to this folder. If Controlled Folder Access is on (Windows Security > Virus & threat protection > Ransomware protection), allow Coherence.exe, runtime\\node.exe and CoherencePlatform.exe from the Coherence program folder, or keep projects in a folder it does not protect. Nothing unverified was changed.",
    "ACCESS_DENIED",
  );
}

// No paths, credentials or source supplied by HTTP are interpolated into code.
// Directory handles deny DELETE sharing, preventing ancestor rename/reparse swaps.
// Removal is by the verified file HANDLE, not a check followed by path-based unlink.
export const STORAGE_GUARD_SCRIPT = String.raw`
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using Microsoft.Win32.SafeHandles;
public static class CoherenceStorageGuard {
 [StructLayout(LayoutKind.Sequential)] public struct Info {
  public uint Attributes,CreatedLow,CreatedHigh,AccessLow,AccessHigh,WriteLow,WriteHigh,Volume,SizeHigh,SizeLow,Links,IndexHigh,IndexLow;
 }
 [StructLayout(LayoutKind.Sequential)] struct Disposition { [MarshalAs(UnmanagedType.Bool)] public bool Delete; }
 [StructLayout(LayoutKind.Sequential)] struct UnicodeName { public ushort Length,MaximumLength; public IntPtr Buffer; }
 [StructLayout(LayoutKind.Sequential)] struct ObjectAttributes { public int Length; public IntPtr RootDirectory,ObjectName; public uint Attributes; public IntPtr SecurityDescriptor,SecurityQualityOfService; }
 [StructLayout(LayoutKind.Sequential)] struct IoStatus { public IntPtr Status,Information; }
 [DllImport("ntdll.dll")] static extern int NtCreateFile(out SafeFileHandle h,uint access,ref ObjectAttributes attributes,out IoStatus status,IntPtr allocation,uint fileAttributes,uint sharing,uint disposition,uint options,IntPtr ea,uint eaLength);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFile(string name,uint access,uint sharing,IntPtr security,uint creation,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle handle,out Info info);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool SetFileInformationByHandle(SafeFileHandle handle,int kind,ref Disposition info,uint size);
 [DllImport("kernel32.dll",EntryPoint="SetFileInformationByHandle",SetLastError=true)] static extern bool SetRename(SafeFileHandle handle,int kind,IntPtr info,uint size);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern uint GetDriveType(string root);
 static string Native(string p) {
  if(p.StartsWith(@"\\") || GetDriveType(Path.GetPathRoot(p))==4)throw new IOException("Network storage is not supported");
  return @"\\?\"+p;
 }
 static Info Inspect(SafeFileHandle h) { Info i; if(h.IsInvalid || !GetFileInformationByHandle(h,out i) || (i.Attributes&0x400)!=0)throw new IOException("Unsafe storage handle"); return i; }
 static string Id(Info i) { return (((ulong)i.IndexHigh<<32)|i.IndexLow).ToString(); }
 public static string OpenIdentity(SafeFileHandle handle){return Id(Inspect(handle));}
 public static SafeFileHandle CreateOwned(string p) {
  Native(p);var text=@"\??\"+p;var bytes=System.Text.Encoding.Unicode.GetByteCount(text);
  var name=new UnicodeName {Length=checked((ushort)bytes),MaximumLength=checked((ushort)(bytes+2)),Buffer=Marshal.StringToHGlobalUni(text)};
  var pointer=Marshal.AllocHGlobal(Marshal.SizeOf(typeof(UnicodeName)));
  try {
   Marshal.StructureToPtr(name,pointer,false);
   var attributes=new ObjectAttributes {Length=Marshal.SizeOf(typeof(ObjectAttributes)),ObjectName=pointer,Attributes=0x40};
   SafeFileHandle h;IoStatus io;
   // FILE_CREATE + DIRECTORY + synchronous I/O: creation and no-DELETE-sharing
   // ownership are one kernel operation; an existing directory is never adopted.
   int status=NtCreateFile(out h,0x120081,ref attributes,out io,IntPtr.Zero,0x10,3,2,0x21,IntPtr.Zero,0);
   if(status<0){if(h!=null)h.Dispose();throw new IOException("Cannot exclusively create project directory");}
   try{var info=Inspect(h);if((info.Attributes&0x10)==0)throw new IOException();return h;}catch{h.Dispose();throw;}
  }finally{Marshal.FreeHGlobal(pointer);Marshal.FreeHGlobal(name.Buffer);}
 }
 public static SafeFileHandle Pin(string p) {
  var h=CreateFile(Native(p),0x80000000,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero);
  try {var i=Inspect(h); if((i.Attributes&0x10)==0)throw new IOException();return h;}catch{h.Dispose();throw;}
 }
 public static void VerifyIdentity(string p,string id){using(var h=Pin(p)){if(Id(Inspect(h))!=id)throw new IOException("Storage identity mismatch");}}
 public static string Identity(string p){using(var h=CreateFile(Native(p),0x80,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero)){return Id(Inspect(h));}}
 public static void VerifyFile(string p,string id) {using(var h=CreateFile(Native(p),0x80,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero)){var i=Inspect(h);if((i.Attributes&0x10)!=0||i.Links!=1||Id(i)!=id)throw new IOException("Unsafe file identity");}}
 public static void Rename(string from,string to,string id) {Move(from,to,id,false);}
 public static void Replace(string from,string to,string id) {Move(from,to,id,true);}
 static void Move(string from,string to,string id,bool replace) {
  using(var h=CreateFile(Native(from),0x10080,3,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
   var i=Inspect(h);if(Id(i)!=id || ((i.Attributes&0x10)==0 && i.Links!=1))throw new IOException("Folder identity mismatch");
   var bytes=System.Text.Encoding.Unicode.GetBytes(Native(to));
   int offset=IntPtr.Size==8?20:12;var buffer=Marshal.AllocHGlobal(offset+bytes.Length+2);
   try {
    for(int n=0;n<offset+bytes.Length+2;n++)Marshal.WriteByte(buffer,n,0);
    if(replace)Marshal.WriteByte(buffer,0,1);
    Marshal.WriteInt32(buffer,IntPtr.Size==8?16:8,bytes.Length);
    Marshal.Copy(bytes,0,IntPtr.Add(buffer,offset),bytes.Length);
    if(!SetRename(h,3,buffer,(uint)(offset+bytes.Length+2)))throw new IOException("Cannot move owned folder");
   }finally{Marshal.FreeHGlobal(buffer);}
  }
 }
 public static void Remove(string p,string id,string hash,bool directory) {
  using(var h=CreateFile(Native(p),directory?0x10080u:0x80010080u,1,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) {
   var i=Inspect(h);
   if(Id(i)!=id || (((i.Attributes&0x10)!=0)!=directory) || (!directory&&i.Links!=1))throw new IOException("Storage identity mismatch");
   if(!directory) {
    using(var stream=new FileStream(h,FileAccess.Read)) {
     using(var sha=SHA256.Create())if(BitConverter.ToString(sha.ComputeHash(stream)).Replace("-","").ToLowerInvariant()!=hash)throw new IOException("Content changed");
     var d=new Disposition {Delete=true};if(!SetFileInformationByHandle(h,4,ref d,(uint)Marshal.SizeOf(typeof(Disposition))))throw new IOException("Cannot remove reviewed file");
    }
   } else {var d=new Disposition {Delete=true};if(!SetFileInformationByHandle(h,4,ref d,(uint)Marshal.SizeOf(typeof(Disposition))))throw new IOException("Directory is not empty or is locked");}
  }
 }
}
'@
$leases=@{}
try {
 while($null -ne ($line=[Console]::ReadLine())) {
  $r=$line|ConvertFrom-Json
  try {
   if($r.action -eq 'lock') {
    $handles=New-Object 'System.Collections.Generic.List[System.IDisposable]'
    try {foreach($p in $r.paths){$handles.Add([CoherenceStorageGuard]::Pin($p))};$leases[$r.token]=$handles}
    catch {foreach($h in $handles){$h.Dispose()};throw}
   } elseif($r.action -eq 'create-directory') {
    $handles=New-Object 'System.Collections.Generic.List[System.IDisposable]'
    $handles.Add([CoherenceStorageGuard]::CreateOwned($r.path));$leases[$r.token]=$handles
   } elseif($r.action -eq 'unlock') {
    foreach($h in $leases[$r.token]){$h.Dispose()};$leases.Remove($r.token)
   } elseif($r.action -eq 'remove') {
    [CoherenceStorageGuard]::Remove($r.path,$r.identity,$r.hash,[bool]$r.directory)
   } elseif($r.action -eq 'rename') {
    [CoherenceStorageGuard]::Rename($r.from,$r.to,$r.identity)
   } elseif($r.action -eq 'replace') {
    [CoherenceStorageGuard]::Replace($r.from,$r.to,$r.identity)
   } elseif($r.action -eq 'verify-file') {
    [CoherenceStorageGuard]::VerifyFile($r.path,$r.identity)
   } elseif($r.action -eq 'queue') {
    $handles=New-Object 'System.Collections.Generic.List[System.IDisposable]'
    try {
     foreach($p in $r.paths){$handles.Add([CoherenceStorageGuard]::Pin($p))}
     [CoherenceStorageGuard]::VerifyIdentity($r.root,$r.rootIdentity)
     [IO.Directory]::CreateDirectory($r.directory)|Out-Null
     $handles.Add([CoherenceStorageGuard]::Pin($r.directory))
     $temporary=$r.target+'.tmp-'+[guid]::NewGuid().ToString('N')
     $stream=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
     try {$bytes=[Text.Encoding]::UTF8.GetBytes($r.content);$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true);$temporaryIdentity=[CoherenceStorageGuard]::OpenIdentity($stream.SafeFileHandle)}finally{$stream.Dispose()}
     [CoherenceStorageGuard]::Rename($temporary,$r.target,$temporaryIdentity)
    }finally{foreach($h in $handles){$h.Dispose()}}
   } else {throw 'Unknown storage operation'}
   [Console]::WriteLine((@{id=$r.id;ok=$true}|ConvertTo-Json -Compress))
  } catch {[Console]::WriteLine((@{id=$r.id;ok=$false}|ConvertTo-Json -Compress))}
 }
} finally {foreach($handles in $leases.Values){foreach($h in $handles){$h.Dispose()}}}
`;

let worker: ChildProcessWithoutNullStreams | undefined;
let intentionalClose = false;
let closing = false;
/** Stop new commits before releasing project/global ownership at shutdown. */
export function beginFilesystemShutdown() {
  closing = true;
}
let nextId = 0;
const requests = new Map<
  number,
  { resolve: () => void; reject: (error: Error) => void }
>();
function request(payload: Record<string, unknown>): Promise<void> {
  if (closing && payload.action !== "unlock")
    throw new ConflictError(
      "Coherence is closing. Reopen it before changing files.",
    );
  // The guard is being released (its input is closed): a late request must not write to it. Its handles close with
  // it, so an unlock is already done; anything else is refused.
  if (worker && intentionalClose)
    return payload.action === "unlock"
      ? Promise.resolve()
      : Promise.reject(
          new ConflictError(
            "Coherence is closing. Reopen it before changing files.",
          ),
        );
  if (!worker) {
    intentionalClose = false;
    // The installed app runs the native helper's port of this script (same protocol); developer runs use PowerShell.
    const guard = platformProcess("guard", ["-Command", STORAGE_GUARD_SCRIPT]);
    worker = spawn(guard.file, guard.args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Never forward native/raw errors or filesystem paths into diagnostics.
    worker.stderr.resume();
    // A guard that died mid-write is handled by "close" below; the pipe error itself must not crash the app.
    worker.stdin.on("error", () => {});
    createInterface({ input: worker.stdout }).on("line", (line) => {
      try {
        const response = JSON.parse(line);
        const pending = requests.get(response.id);
        if (pending) {
          requests.delete(response.id);
          response.ok
            ? pending.resolve()
            : pending.reject(
                // Only the helper says why; PowerShell refusals stay generic.
                response.error === "access-denied"
                  ? accessDeniedError()
                  : new ConflictError(
                      "Storage is locked, changed or unsafe. No unverified file will be removed. Close editors or reconnect the project and retry.",
                    ),
              );
        }
      } catch {
        /* nonprotocol native startup output is ignored */
      }
    });
    const failed = () => {
      for (const pending of requests.values())
        pending.reject(
          new Error(
            "The Windows storage guard stopped. Restart Coherence before changing files.",
          ),
        );
      requests.clear();
      worker = undefined;
      if (!intentionalClose)
        stopForStorageProtection(
          "Coherence lost its filesystem safety guard and must stop.",
        );
    };
    worker.once("error", failed);
    worker.once("close", failed);
  }
  const id = ++nextId;
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      logHelperTimeout("Storage guard");
      stopForStorageProtection(
        "Windows storage protection stopped responding; Coherence must stop safely.",
      );
    }, 15000);
    requests.set(id, {
      resolve: () => {
        clearTimeout(timer);
        resolve();
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
    worker!.stdin.write(JSON.stringify({ ...payload, id }) + "\n");
  });
}
export async function withDirectoryGuard<T>(
  folder: string,
  action: () => Promise<T>,
): Promise<T> {
  if (process.platform !== "win32")
    throw Error(
      "Portable writable workspaces currently require Windows handle protection.",
    );
  regularPath(folder);
  const dirs: string[] = [];
  let current = path.resolve(folder);
  while (true) {
    if (fs.existsSync(current)) {
      if (!fs.lstatSync(current).isDirectory())
        throw Error("A folder was replaced with a file.");
      dirs.unshift(current);
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const token = randomUUID();
  await request({ action: "lock", token, paths: dirs });
  try {
    regularPath(folder);
    return await action();
  } finally {
    await request({ action: "unlock", token });
  }
}
export async function removeReviewedPath(
  file: string,
  identity: string,
  hash: string,
  directory: boolean,
) {
  return withDirectoryGuard(path.dirname(file), () =>
    request({ action: "remove", path: file, identity, hash, directory }),
  );
}

/** Atomically create a new directory and keep its original identity pinned. */
export async function createOwnedDirectory(
  root: string,
): Promise<() => Promise<void>> {
  regularPath(root);
  const token = randomUUID();
  await withDirectoryGuard(path.dirname(root), () =>
    request({ action: "create-directory", path: root, token }),
  );
  return () => request({ action: "unlock", token });
}
export async function verifyRegularFile(file: string, identity: string) {
  return request({ action: "verify-file", path: file, identity });
}
export async function replaceOwnedFile(
  from: string,
  to: string,
  identity: string,
) {
  const { assertV2Path } = await import("./boundary");
  assertV2Path(from);
  assertV2Path(to);
  return request({ action: "replace", from, to, identity });
}
export async function renameOwnedDirectory(
  from: string,
  to: string,
  identity: string,
) {
  for (let attempt = 0; ; attempt++)
    try {
      return await withDirectoryGuard(path.dirname(from), () =>
        withDirectoryGuard(path.dirname(to), async () => {
          const { assertNoNestedProjects } =
            await import("./projectBoundaries");
          if (fs.lstatSync(from).isDirectory()) assertNoNestedProjects(from);
          return request({ action: "rename", from, to, identity });
        }),
      );
    } catch (error) {
      if (attempt === 3) throw error;
      await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
    }
}
/** Pin existing project roots and synchronous job-record directory until maintenance/shutdown. */
export async function pinProjectDirectories(
  root: string,
): Promise<() => Promise<void>> {
  if (process.platform !== "win32")
    throw Error("Portable writable workspaces require Windows.");
  const dirs = [root, path.join(root, "jobs")].filter((p) => fs.existsSync(p));
  dirs.forEach((p) => regularPath(p, false));
  const token = randomUUID();
  await request({ action: "lock", token, paths: dirs });
  return () => request({ action: "unlock", token });
}
export async function releaseFilesystemGuard() {
  intentionalClose = true;
  const child = worker;
  if (!child) return;
  await new Promise<void>((resolve) => {
    child.once("close", () => resolve());
    child.stdin.end();
  });
  worker = undefined;
}
/**
 * A job's queued record is durable before its ID is exposed. Installer finding RT-17: this used to start and compile a
 * new PowerShell guard for every job, synchronously; it now goes through the long-lived guard like every other write.
 */
export async function writeQueuedRecord(
  root: string,
  file: string,
  content: string,
): Promise<void> {
  if (closing)
    throw new ConflictError(
      "Coherence is closing. No new generation was started.",
    );
  regularPath(root, false);
  regularPath(file);
  if (
    path.dirname(path.dirname(file)) !== root ||
    path.basename(path.dirname(file)) !== "jobs" ||
    !/^job_[A-Za-z0-9_-]+\.json$/.test(path.basename(file))
  )
    throw new ConflictError("Invalid queued job location.");
  const dirs: string[] = [];
  let at = root;
  while (true) {
    dirs.unshift(at);
    const parent = path.dirname(at);
    if (parent === at) break;
    at = parent;
  }
  const rootIdentity = fs.statSync(root, { bigint: true }).ino.toString();
  try {
    await request({
      action: "queue",
      paths: dirs,
      root,
      rootIdentity,
      directory: path.dirname(file),
      target: file,
      content,
    });
  } catch (error) {
    if (error instanceof HttpError && error.code === "ACCESS_DENIED")
      throw error;
    throw new ConflictError(
      "The queued job could not be safely recorded. No generation was started.",
    );
  }
}
