import { spawn } from "node:child_process";
import { platformProcess } from "../platform/nativeHelper";
import { logHelperTimeout } from "../startupErrors";

const SECRET_KEYS = new Set(["apiKey", "apiToken", "token", "pat"]);
interface ProtectedRecord {
  _protectedSecrets?: {
    version: 1;
    scheme: "windows-dpapi-current-user";
    ciphertext: string;
  };
}

/** Secrets travel over stdin, never process arguments or log output. No plaintext fallback. */
async function dpapi(
  mode: "protect" | "unprotect",
  value: string,
): Promise<string> {
  if (process.platform !== "win32")
    throw new Error(
      "Saved secrets require Windows DPAPI. Use V2-prefixed environment credentials on this platform.",
    );
  const method = mode === "protect" ? "Protect" : "Unprotect";
  const script = `$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Security; $inputBytes=[Convert]::FromBase64String([Console]::In.ReadToEnd()); $outputBytes=[System.Security.Cryptography.ProtectedData]::${method}($inputBytes,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($outputBytes))`;
  // The native helper makes the same DPAPI call, so either implementation reads what the other saved.
  const command = platformProcess(mode, ["-Command", script]);
  return new Promise((resolve, reject) => {
    const child = spawn(command.file, command.args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let failed = false;
    const timer = setTimeout(() => {
      child.kill();
      logHelperTimeout(`Credential ${mode}ion`);
      reject(
        new Error(
          "Windows credential protection timed out. Nothing was saved.",
        ),
      );
    }, 15000);
    child.stdout.setEncoding("utf8").on("data", (data) => {
      stdout += data;
      if (stdout.length > 5_000_000) {
        failed = true;
        child.kill();
      }
    });
    // Never include subprocess diagnostics: they may contain data from an external runtime.
    child.stderr.resume();
    child.on("error", () => {
      clearTimeout(timer);
      reject(
        new Error(
          "Windows credential protection is unavailable. Nothing was saved.",
        ),
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0 || failed)
        reject(
          new Error(
            "Windows could not unlock the saved secrets for this account. Restore with the same Windows account or explicitly replace the protected settings file.",
          ),
        );
      else resolve(stdout.trim());
    });
    child.stdin.on("error", () => {});
    child.stdin.end(
      mode === "protect"
        ? Buffer.from(value, "utf8").toString("base64")
        : value,
    );
  });
}

export async function protectSettings<T extends object>(
  settings: T,
): Promise<T & ProtectedRecord> {
  const copy = structuredClone(settings) as T & ProtectedRecord;
  const secrets: Record<string, string> = {};
  function visit(value: Record<string, unknown>, prefix: string[]) {
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_KEYS.has(key) && typeof item === "string" && item) {
        secrets[JSON.stringify([...prefix, key])] = item;
        delete value[key];
      } else if (item && typeof item === "object")
        visit(item as Record<string, unknown>, [...prefix, key]);
    }
  }
  visit(copy as Record<string, unknown>, []);
  if (Object.keys(secrets).length)
    copy._protectedSecrets = {
      version: 1,
      scheme: "windows-dpapi-current-user",
      ciphertext: await dpapi("protect", JSON.stringify(secrets)),
    };
  return copy;
}

export async function unprotectSettings<T extends object>(
  input: T & ProtectedRecord,
): Promise<T> {
  const copy = structuredClone(input);
  const protectedValue = copy._protectedSecrets;
  delete copy._protectedSecrets;
  if (protectedValue) {
    if (
      protectedValue.version !== 1 ||
      protectedValue.scheme !== "windows-dpapi-current-user"
    )
      throw new Error("Unsupported credential protection format.");
    const decoded = Buffer.from(
      await dpapi("unprotect", protectedValue.ciphertext),
      "base64",
    ).toString("utf8");
    const secrets = JSON.parse(decoded) as Record<string, string>;
    for (const [encoded, value] of Object.entries(secrets)) {
      const keys = JSON.parse(encoded) as string[];
      if (
        !keys.length ||
        keys.some((k) =>
          ["__proto__", "constructor", "prototype"].includes(k),
        ) ||
        !SECRET_KEYS.has(keys.at(-1)!)
      )
        throw new Error("Invalid protected credential record.");
      let target = copy as Record<string, unknown>;
      for (const key of keys.slice(0, -1)) {
        if (!target[key] || typeof target[key] !== "object")
          throw new Error("Protected credential owner is missing.");
        target = target[key] as Record<string, unknown>;
      }
      target[keys.at(-1)!] = value;
    }
  }
  return copy;
}
