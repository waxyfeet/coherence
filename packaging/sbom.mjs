/**
 * CycloneDX SBOM for the staged app: npm's offline SBOM of the production packages (bundled into the backend or
 * compiled into the UI), plus what npm cannot see — the Node.js runtime, libvips and the libraries inside
 * libvips-42.dll, the adapted Odysseus themes and the Fira Code fonts.
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const SPDX = {
  "mit license": "MIT",
  lgplv3: "LGPL-3.0-or-later",
  "bsd 2-clause": "BSD-2-Clause",
  "bsd 3-clause": "BSD-3-Clause",
  "new bsd license": "BSD-3-Clause",
  "mozilla public license 1.1": "MPL-1.1",
};
// versions.json key -> name in the sharp-libvips licence table.
const LIBRARY_NAMES = {
  archive: "libarchive",
  exif: "libexif",
  ffi: "libffi",
  heif: "libheif",
  imagequant: "libimagequant",
  png: "libpng",
  rsvg: "librsvg",
  tiff: "libtiff",
  uhdr: "libultrahdr",
  vips: "libvips",
  webp: "libwebp",
  xml2: "libxml2",
};

function licence(text) {
  const plain = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").trim();
  const id = SPDX[plain.toLowerCase()];
  return id ? { license: { id } } : { license: { name: plain } };
}

export function buildSbom({ root, pkg, nodePin }) {
  const npm = JSON.parse(
    execFileSync(
      "npm",
      [
        "sbom",
        "--omit=dev",
        "--sbom-format=cyclonedx",
        "--sbom-type=application",
        "--offline",
      ],
      { cwd: root, encoding: "utf8", shell: true, maxBuffer: 64 * 1024 * 1024 },
    ),
  );
  const sharpPackage = path.join(
    root,
    "node_modules",
    "@img",
    "sharp-win32-x64",
  );
  const versions = JSON.parse(
    fs.readFileSync(path.join(sharpPackage, "versions.json"), "utf8"),
  );
  const table = new Map(
    [
      ...fs
        .readFileSync(path.join(sharpPackage, "README.md"), "utf8")
        .matchAll(/^\|\s*([a-z0-9-]+)\s*\|\s*(.+?)\s*\|$/gm),
    ]
      .filter(([, name]) => name !== "Library")
      .map(([, name, terms]) => [name, terms]),
  );
  const extra = [
    {
      type: "application",
      "bom-ref": `node@${nodePin.version}`,
      name: "node",
      version: nodePin.version,
      description: "Node.js runtime (official Windows x64 build, unmodified)",
      purl: `pkg:generic/node@${nodePin.version}?download_url=${encodeURIComponent(nodePin.source + nodePin.zip)}`,
      hashes: [{ alg: "SHA-256", content: nodePin.sha256 }],
      licenses: [{ license: { id: "MIT" } }],
    },
    ...Object.entries(versions).map(([key, version]) => {
      const name = LIBRARY_NAMES[key] ?? key;
      return {
        type: "library",
        "bom-ref": `libvips-component:${name}@${version}`,
        name,
        version,
        description:
          "Statically linked into libvips-42.dll (@img/sharp-win32-x64)",
        licenses: table.has(name) ? [licence(table.get(name))] : [],
      };
    }),
    {
      type: "library",
      "bom-ref": "odysseus-themes@8877273e195a90d51bc6a37f3a1b60dc3414c431",
      name: "odysseus (adapted themes)",
      version: "8877273e195a90d51bc6a37f3a1b60dc3414c431",
      licenses: [
        {
          license: {
            name: "MIT, by written permission (licenses/Odysseus-themes-permission.md)",
          },
        },
      ],
      externalReferences: [
        { type: "vcs", url: "https://github.com/odysseus-dev/odysseus" },
      ],
    },
    {
      type: "file",
      "bom-ref": "fira-code-fonts",
      name: "Fira Code (fonts)",
      licenses: [{ license: { id: "OFL-1.1" } }],
    },
  ];
  npm.metadata = {
    ...npm.metadata,
    component: {
      type: "application",
      "bom-ref": `coherence@${pkg.version}`,
      name: "Coherence",
      version: pkg.version,
      licenses: [{ license: { id: "MIT" } }],
    },
  };
  npm.components = [...(npm.components ?? []), ...extra];
  // No timestamp or random serial: two builds of one commit must produce identical files.
  delete npm.serialNumber;
  delete npm.metadata.timestamp;
  return npm;
}
