import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  assertOutsideProjects,
  assertProjectPath,
  assertStandaloneProject,
  assertProjectFreeTree,
} from "./projectBoundaries";
let root: string;
/** An old ScreenScribe manifest: recognised by its shape, not by an id alone. */
const legacy = (id: string) =>
  JSON.stringify({
    id,
    formatId: "use-case-bdd",
    outputDir: "specs",
    screens: [],
  });
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "coherence-test-boundaries-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

it("refuses linked ownership markers and rereads an in-place marker change on the next access", () => {
  const a = path.join(root, "a"),
    b = path.join(root, "b");
  marker(a, JSON.stringify({ notes: "Ordinary JSON" }));
  fs.mkdirSync(b);
  fs.linkSync(path.join(a, "project.json"), path.join(b, "project.json"));
  expect(() => assertOutsideProjects(b)).toThrow(/cannot contain/);
  fs.unlinkSync(path.join(b, "project.json"));
  expect(() => assertOutsideProjects(a)).not.toThrow();
  fs.writeFileSync(path.join(a, "project.json"), legacy("legacy"));
  expect(() => assertOutsideProjects(a)).toThrow(/cannot contain/);
});
it("rejects junction ancestry before opening an ownership marker", () => {
  const target = path.join(root, "foreign"),
    link = path.join(root, "linked");
  marker(target);
  fs.symlinkSync(
    fs.realpathSync(target),
    link,
    process.platform === "win32" ? "junction" : "dir",
  );
  const open = vi.spyOn(fs, "openSync");
  expect(() => assertOutsideProjects(path.join(link, "human.md"))).toThrow(
    /symbolic|junction|redirect/i,
  );
  expect(open).not.toHaveBeenCalled();
});
it("refuses a marker changed while its handle is being read instead of accepting stale bytes", () => {
  marker(root, JSON.stringify({ notes: "Ordinary JSON" }));
  const markerFile = path.join(root, "project.json"),
    read = fs.readFileSync;
  let altered = false;
  vi.spyOn(fs, "readFileSync").mockImplementation(((
    file: Parameters<typeof read>[0],
    ...args: unknown[]
  ) => {
    const bytes = Reflect.apply(read, fs, [file, ...args]);
    if (typeof file === "number" && !altered) {
      altered = true;
      fs.writeFileSync(
        markerFile,
        JSON.stringify({ storage: { format: "coherence-project" } }),
      );
    }
    return bytes;
  }) as typeof read);
  expect(() => assertOutsideProjects(root)).toThrow(/cannot contain/);
  expect(altered).toBe(true);
});
function marker(
  folder: string,
  content = JSON.stringify({ storage: { format: "coherence-project" } }),
) {
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(path.join(folder, "project.json"), content);
}
it("rejects an unregistered portable ancestor at any depth, including missing descendants", () => {
  marker(root);
  for (const folder of [
    root,
    path.join(root, "specs"),
    path.join(root, "specs", "not-created", "child"),
  ])
    expect(() => assertOutsideProjects(folder)).toThrow(/cannot contain/);
});
it("refuses either direction of existing nested roots without consulting a registry", () => {
  marker(root);
  const child = path.join(root, "specs", "child");
  marker(child);
  expect(() => assertStandaloneProject(root)).toThrow(/cannot contain/);
  expect(() => assertStandaloneProject(child)).toThrow(/cannot contain/);
});
it("allows siblings, arbitrary specification subdirectories, and non-project JSON", () => {
  marker(path.join(root, "a"));
  marker(path.join(root, "b"));
  fs.mkdirSync(path.join(root, "a", "specs", "human"), { recursive: true });
  marker(
    path.join(root, "a", "notes"),
    JSON.stringify({ notes: "Human JSON" }),
  );
  expect(() => assertStandaloneProject(path.join(root, "a"))).not.toThrow();
  expect(() => assertOutsideProjects(root)).not.toThrow();
  expect(() =>
    assertProjectPath(
      path.join(root, "a"),
      path.join(root, "a", "specs", "human", "rule.md"),
    ),
  ).not.toThrow();
});

it("rechecks foreign boundaries introduced after enrollment, including access to the marker itself", () => {
  marker(root);
  const child = path.join(root, "specs", "late");
  const file = path.join(child, "specs", "human.md");
  expect(() => assertProjectPath(root, file)).not.toThrow();
  marker(child);
  for (const target of [child, path.join(child, "project.json"), file])
    expect(() => assertProjectPath(root, target)).toThrow(/cannot contain/);
});
it("treats damaged, null or unsupported storage metadata as a boundary rather than a grant", () => {
  for (const content of [
    "{damaged",
    '{"storage":null}',
    '{"storage":{"version":999}}',
  ]) {
    marker(path.join(root, "foreign"), content);
    expect(() =>
      assertOutsideProjects(path.join(root, "foreign", "specs")),
    ).toThrow(/cannot contain/);
    expect(() => assertStandaloneProject(root)).toThrow(/cannot contain/);
  }
});

it("housekeeping includes its root while whole-project checks allow the nominated root's own marker", () => {
  for (const content of [
    legacy("legacy"),
    JSON.stringify({ storage: { format: "coherence-project" } }),
  ]) {
    marker(root, content);
    expect(() => assertStandaloneProject(root)).not.toThrow();
    expect(() => assertProjectFreeTree(root)).toThrow(/cannot contain/);
  }
});

it("housekeeping allows an ordinary subtree of its owning project but retains damaged root markers", () => {
  marker(root, legacy("owner"));
  const cache = path.join(root, "analysis-cache");
  fs.mkdirSync(cache);
  expect(() => assertProjectFreeTree(cache)).not.toThrow();
  marker(cache, "{damaged");
  expect(() => assertProjectFreeTree(cache)).toThrow(/cannot contain/);
});

// The specs-folder marker, current and from before the visible rename: both mark requirements the same way.
const OWNER_MARKERS = [".coherence.json", ".screenscribe.json"];

it.each(OWNER_MARKERS)(
  "housekeeping protects marked requirements at the root and below it without rejecting owned specs in whole-project checks (%s)",
  (name) => {
    marker(root, legacy("owner"));
    const specs = path.join(root, "specs");
    fs.mkdirSync(specs);
    fs.writeFileSync(
      path.join(specs, name),
      JSON.stringify({ projectId: "owner" }),
    );
    expect(() => assertStandaloneProject(root)).not.toThrow();
    expect(() => assertProjectFreeTree(specs)).toThrow(/cannot contain/);
    const cache = path.join(root, "analysis-cache");
    const child = path.join(cache, "foreign-output");
    fs.mkdirSync(child, { recursive: true });
    fs.writeFileSync(
      path.join(child, name),
      JSON.stringify({ projectId: "other" }),
    );
    expect(() => assertProjectFreeTree(cache)).toThrow(/cannot contain/);
  },
);

it.each(OWNER_MARKERS)(
  "housekeeping fails closed on damaged or uncertain output-owner markers at root or descendant (%s)",
  (marker) => {
    for (const name of ["root", "descendant"]) {
      const tree = path.join(root, name);
      const at = name === "root" ? tree : path.join(tree, "child");
      fs.mkdirSync(at, { recursive: true });
      for (const content of ["{damaged", '{"projectId":null}']) {
        fs.writeFileSync(path.join(at, marker), content);
        expect(() => assertProjectFreeTree(tree)).toThrow(/cannot contain/);
      }
    }
  },
);

it("ignores another tool's well-formed project.json above a folder, but not a damaged one or a ScreenScribe one", () => {
  const nested = path.join(
    root,
    "Users",
    "someone",
    "Documents",
    "Coherence",
    "Projects",
  );
  fs.mkdirSync(nested, { recursive: true });
  for (const content of [
    JSON.stringify({ id: "some-other-tool" }),
    JSON.stringify({ name: "web-app", version: "1.0.0", dependencies: {} }),
    "[]",
  ]) {
    marker(path.join(root, "Users"), content);
    expect(() => assertOutsideProjects(nested), content).not.toThrow();
  }
  for (const content of ["{ not json", legacy("old-screenscribe")]) {
    marker(path.join(root, "Users"), content);
    expect(() => assertOutsideProjects(nested), content).toThrow(
      /cannot contain/,
    );
  }
});
