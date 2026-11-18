import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

// npm ls --omit=dev --all --parseable > .cache/notices/runtime-packages.txt
const root = process.cwd();
const packagePaths = (
  await readFile(path.join(root, ".cache/notices/runtime-packages.txt"), "utf8")
)
  .replace(/^\uFEFF/, "")
  .split(/\r?\n/)
  .filter((p) => p && p !== root);
const records = [];
const missing = [];
for (const packagePath of packagePaths) {
  if (
    !path
      .resolve(packagePath)
      .startsWith(path.join(root, "node_modules") + path.sep)
  )
    throw Error("Unexpected package path");
  const pkg = JSON.parse(
    await readFile(path.join(packagePath, "package.json"), "utf8"),
  );
  const packageFiles = await readdir(packagePath);
  const files = packageFiles.filter((f) => /^licen[cs]e(?:\.[^.]+)?$/i.test(f));
  const notices = await Promise.all(
    files.map(async (f) =>
      (await readFile(path.join(packagePath, f), "utf8")).trim(),
    ),
  );
  // This package's npm tarball omits its license file; retain the upstream MIT license alongside its declared MIT metadata.
  if (!files.length && pkg.name === "react-remove-scroll-bar")
    notices.push(
      (
        await readFile(
          path.join(root, "docs/licenses/react-remove-scroll-bar-LICENSE.txt"),
          "utf8",
        )
      ).trim(),
    );
  if (!files.length && pkg.name === "data-uri-to-buffer") {
    const readme = await readFile(path.join(packagePath, "README.md"), "utf8");
    notices.push(
      readme
        .slice(readme.indexOf("(The MIT License)"))
        .split("[rfc]:")[0]
        .trim(),
    );
  }
  if (!files.length && pkg.name === "standardwebhooks")
    notices.push(
      (
        await readFile(
          path.join(root, "docs/licenses/standardwebhooks-LICENSE.txt"),
          "utf8",
        )
      ).trim(),
    );
  if (!notices.length) missing.push(pkg.name);
  // NOTICE files can carry additional upstream attribution beyond LICENSE.
  const noticeFiles = packageFiles.filter((f) =>
    /^notice(?:\.[^.]+)?$/i.test(f),
  );
  notices.push(
    ...(await Promise.all(
      noticeFiles.map(async (f) =>
        (await readFile(path.join(packagePath, f), "utf8")).trim(),
      ),
    )),
  );
  records.push({
    name: pkg.name,
    version: pkg.version,
    license:
      typeof pkg.license === "string"
        ? pkg.license
        : (pkg.licenses?.map((l) => l.type).join(" OR ") ??
          (pkg.name === "khroma"
            ? "MIT (installed license text)"
            : JSON.stringify(pkg.license))),
    notices,
  });
}
records.sort((a, b) => a.name.localeCompare(b.name));
const heading =
  "Coherence — third-party notices\n\nThe desktop interface and Northstar prototype artwork were independently authored. The Home hero is adapted from the author's own design. Backend and domain modules and the Acme sample screenshots are adapted from the author's own earlier application, ScreenScribe. The six themes (their colours, renderers and effects) are adapted from Odysseus (https://github.com/odysseus-dev/odysseus, revision 8877273e195a90d51bc6a37f3a1b60dc3414c431). Odysseus is licensed under AGPL-3.0 (notices/Odysseus-AGPL-3.0.txt); its copyright holders gave written permission, on 2 November 2026, for the adapted themes to be distributed under the MIT License or any licence the recipient chooses, including modification and redistribution by anyone (recorded in the Coherence repository at docs/licenses/Odysseus-themes-permission.md). The bundled Fira Code fonts are under the SIL Open Font License 1.1 (notices/Odysseus-FiraCode-OFL-1.1.txt).\n\nThe following runtime dependency notices are reproduced from the installed packages. These include transitive dependencies; some modules are removed from the browser bundle by tree shaking. Development tooling is not included in this runtime notice list.\n";
await writeFile(
  path.join(root, "public/THIRD_PARTY_NOTICES.txt"),
  heading +
    records
      .map(
        (r) =>
          `\n${"=".repeat(70)}\n${r.name} ${r.version} — ${r.license}\n${"=".repeat(70)}\n\n${r.notices.join("\n\n")}`,
      )
      .join("\n"),
);
await writeFile(
  path.join(root, ".cache/notices/dependency-licenses.json"),
  JSON.stringify(
    {
      runtimeDependencies: records.map(({ notices, ...r }) => r),
      missingLicenseFiles: missing,
    },
    null,
    2,
  ),
);
console.log(
  `Collected ${records.length} runtime package notices. Missing license files: ${missing.length}.`,
);
if (missing.length) console.log(missing.join(", "));
