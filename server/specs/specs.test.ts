import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Project, SolutionModel, UseCase } from "@shared/types";
import { fixtureModel } from "../graph/testFixtures";
import { makePng, removeDir, useTempDataDir } from "../storage/testUtils";
import { diffUseCases, hasContentChanges } from "./useCaseDiff";

type SpecStore = typeof import("./specStore");
type Search = typeof import("./search");
type ProjectStore = typeof import("../storage/projectStore");

let dataDir: string;
let specs: SpecStore;
let search: Search;
let store: ProjectStore;

beforeAll(async () => {
  dataDir = await useTempDataDir("specs");
  vi.resetModules();
  store = await import("../storage/projectStore");
  specs = await import("./specStore");
  search = await import("./search");
  await store.ensureDataDirs();
});

afterAll(async () => {
  await removeDir(dataDir);
});

/* ------------------------------------------------------------------ */
/* useCaseDiff                                                         */
/* ------------------------------------------------------------------ */

describe("diffUseCases", () => {
  const before = fixtureModel().useCases[0];

  it("reports no changes for formatting-only edits", () => {
    const after: UseCase = {
      ...before,
      title: `  ${before.title}  `,
      preconditions: before.preconditions.map(
        (p) => `${p.replace(/ /g, "  ")} `,
      ),
    };
    const diff = diffUseCases(before, after);
    expect(diff.changedSections).toEqual([]);
    expect(diff.summary).toBe("No changes");
    expect(hasContentChanges(diff)).toBe(false);
  });

  it("describes rule, scenario, list and structural changes in section order", () => {
    const after: UseCase = structuredClone(before);
    after.title = "Sign in securely";
    after.businessRules[1].rules = ["Mandatory", "Minimum 12 characters"];
    after.businessRules = after.businessRules.filter((r) => r.id !== "BR-03");
    after.businessRules.push({
      id: "BR-05",
      element: "Lockout",
      elementType: "general",
      description: "",
      rules: ["Lock after 5 failures"],
    });
    after.scenarios[0].then = [
      ...after.scenarios[0].then,
      "A welcome toast is shown",
    ];
    after.scenarios.push({
      id: "SC-04",
      title: "Account locked",
      type: "edge",
      given: ["x"],
      when: ["y"],
      then: ["z"],
      elementIds: [],
    });
    after.assumptions = ["SSO is out of scope"];
    after.dependsOn = ["UC-002"];
    after.elementIds = after.elementIds.filter(
      (id) => id !== "login.remember_me",
    );
    after.status = "edited";

    const diff = diffUseCases(before, after);
    expect(diff.useCaseId).toBe("UC-001");
    expect(diff.changedSections).toEqual([
      "title",
      "rules",
      "scenarios",
      "assumptions",
      "dependencies",
      "elements",
      "status",
    ]);
    expect(diff.details).toContain(
      "BR-02 rules changed: 'Minimum 8 characters' → 'Minimum 12 characters'",
    );
    expect(diff.details).toContain("Removed BR-03 'Remember me — Checkbox'");
    expect(diff.details).toContain("Added BR-05 'Lockout — General'");
    expect(diff.details).toContain(
      "SC-01 THEN added: 'A welcome toast is shown'",
    );
    expect(diff.details).toContain("Added SC-04 'Account locked'");
    expect(diff.details).toContain("Added assumption 'SSO is out of scope'");
    expect(diff.details).toContain("Now depends on UC-002");
    expect(diff.details).toContain(
      "No longer covers element login.remember_me",
    );
    expect(diff.details).toContain("Status changed: generated → edited");
    expect(diff.summary).toMatch(
      /^Title changed: 'Sign in with email and password' → 'Sign in securely'; /,
    );
    expect(diff.summary).toMatch(/; and \d+ more changes$/);
    expect(hasContentChanges(diff)).toBe(true);
  });

  it("treats a status-only change as no content change", () => {
    const diff = diffUseCases(before, { ...before, status: "approved" });
    expect(diff.changedSections).toEqual(["status"]);
    expect(hasContentChanges(diff)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* resolveSpecPath                                                     */
/* ------------------------------------------------------------------ */

describe("resolveSpecPath", () => {
  let outDir: string;
  let project: Project;

  beforeAll(async () => {
    project = await store.createProject({
      name: "Path boundary",
      description: "Synthetic",
    });
    outDir = project.outputDir;
    await fs.mkdir(path.join(outDir, "use-cases"), { recursive: true });
  });

  afterAll(async () => {
    await removeDir(outDir);
  });

  it("resolves plain relative paths inside the output folder", () => {
    expect(specs.resolveSpecPath(project, "use-cases/UC-001-x.md")).toBe(
      path.join(outDir, "use-cases", "UC-001-x.md"),
    );
    expect(specs.resolveSpecPath(project, "./README.md")).toBe(
      path.join(outDir, "README.md"),
    );
    expect(specs.resolveSpecPath(project, "use-cases\\UC-001-x.md")).toBe(
      path.join(outDir, "use-cases", "UC-001-x.md"),
    );
    expect(specs.resolveSpecPath(project, "not-there/new.md")).toBe(
      path.join(outDir, "not-there", "new.md"),
    );
  });

  it.each([
    ["../secrets.md"],
    ["use-cases/../../secrets.md"],
    ["..\\..\\secrets.md"],
    ["use-cases/.."],
    ["/etc/passwd"],
    ["\\\\server\\share\\x.md"],
    ["C:\\Windows\\win.ini"],
    ["C:secrets.md"],
    ["c:/x.md"],
    ["a\0b.md"],
    [""],
    ["   "],
    ["."],
    ["./"],
  ])("rejects %j", (input) => {
    expect(() => specs.resolveSpecPath(project, input)).toThrow(
      expect.objectContaining({ status: 400 }),
    );
  });

  it("rejects a link inside the folder that points outside it", async () => {
    const outside = await fs.mkdtemp(
      path.join(
        path.join(process.cwd(), ".cache", "test-temp"),
        "screenscribe-outside-",
      ),
    );
    await fs.writeFile(path.join(outside, "secret.md"), "secret");
    const link = path.join(outDir, "escape");
    try {
      await fs.symlink(outside, link, "junction");
    } catch {
      await removeDir(outside);
      return; // the platform does not allow creating links here — nothing to test
    }
    try {
      expect(() => specs.resolveSpecPath(project, "escape/secret.md")).toThrow(
        /outside the output folder/,
      );
      expect(() =>
        specs.resolveSpecPath(project, "escape/new-file.md"),
      ).toThrow(/outside the output folder/);
    } finally {
      await fs
        .rm(link, { recursive: false, force: true })
        .catch(() => fs.rmdir(link));
      await removeDir(outside);
    }
  });

  it("refuses a forged output folder outside canonical requirements", () => {
    expect(() =>
      specs.resolveSpecPath(
        { ...project, outputDir: "relative/specs" },
        "README.md",
      ),
    ).toThrow(/requirements cannot be redirected/);
  });
});

/* ------------------------------------------------------------------ */
/* Spec store against a real project on disk                           */
/* ------------------------------------------------------------------ */

/** The graph fixture model, re-pointed at the screens of a real project. */
function modelFor(project: Project): SolutionModel {
  const fixture = fixtureModel();
  const map: Record<string, string> = {
    scr_login: project.screens[0].id,
    scr_dash: project.screens[1].id,
    scr_orders: project.screens[2].id,
  };
  const json = JSON.stringify({ ...fixture, projectId: project.id }).replace(
    /scr_(login|dash|orders)/g,
    (m) => map[m],
  );
  const model = JSON.parse(json) as SolutionModel;
  for (const uc of model.useCases) delete uc.filePath;
  return model;
}

describe("spec store", () => {
  let project: Project;
  let model: SolutionModel;
  const ucFile = (id: string) =>
    model.useCases.find((u) => u.id === id)!.filePath!;
  const read = (rel: string) =>
    fs.readFile(path.join(project.outputDir, ...rel.split("/")), "utf8");
  const write = (rel: string, content: string) =>
    fs.writeFile(path.join(project.outputDir, ...rel.split("/")), content);

  beforeAll(async () => {
    const created = await store.createProject({
      name: "Spec Store Test",
      description: "Orders portal",
    });
    const png = await makePng(64, 48);
    await store.addScreens(
      created.id,
      ["Login", "Dashboard", "Orders"].map((name) => ({
        originalName: `${name}.png`,
        mimeType: "image/png",
        buffer: png,
      })),
    );
    project = await store.getProject(created.id);
    model = modelFor(project);
    const result = await specs.writeSpecs(project, model, {
      preserveEdited: true,
      embedScreenImages: true,
    });
    await store.saveModel(project.id, model);
    expect(result.preserved).toEqual([]);
    expect(result.written).toEqual(
      expect.arrayContaining([
        "README.md",
        "BUILD-PLAN.md",
        "REVIEW.md",
        "CHANGELOG.md",
        "screens/login.md",
        "screens/images/login.png",
        `use-cases/UC-001-${model.useCases[0].slug}.md`,
        `features/UC-001-${model.useCases[0].slug}.feature`,
      ]),
    );
  });

  it("writes every use case file and records its path in the model", async () => {
    for (const uc of model.useCases) {
      expect(uc.filePath).toBe(`use-cases/${uc.id}-${uc.slug}.md`);
      const parsed = (await import("../formats/registry"))
        .getFormat("use-case-bdd")
        .parseUseCase(await read(uc.filePath!));
      expect(parsed.errors).toEqual([]);
      expect(parsed.useCase.id).toBe(uc.id);
    }
    const image = await fs.readFile(
      path.join(project.outputDir, "screens", "images", "login.png"),
    );
    expect(image.length).toBeGreaterThan(0);
  });

  it("lists the folder as a tree in reading order", async () => {
    const tree = await specs.listSpecTree(project, model);
    const names = tree.children!.map((c) => c.name);
    expect(names.slice(0, 4)).toEqual([
      "README.md",
      "BUILD-PLAN.md",
      "use-cases",
      "screens",
    ]);
    expect(names).toContain("features");
    const useCases = tree.children!.find((c) => c.name === "use-cases")!;
    expect(useCases.children!.map((c) => c.useCaseId)).toEqual(
      model.useCases.map((u) => u.id),
    );
    expect(useCases.children![0].kind).toBe("use-case");
    expect(tree.children!.find((c) => c.name === "README.md")!.kind).toBe(
      "index",
    );
    const screens = tree.children!.find((c) => c.name === "screens")!;
    expect(
      screens.children!.find((c) => c.name === "images")!.children![0].kind,
    ).toBe("image");
  });

  it("reads files with their use case id and refuses other file types", async () => {
    const file = await specs.readSpecFile(project, ucFile("UC-002"));
    expect(file.useCaseId).toBe("UC-002");
    expect(file.content).toContain("# UC-002 · Reset forgotten password");
    await expect(
      specs.readSpecFile(project, "screens/images/login.png"),
    ).rejects.toThrow(/Only markdown/);
    await expect(
      specs.readSpecFile(project, "use-cases/UC-999-missing.md"),
    ).rejects.toThrow(/does not exist/);
    const raw = await specs.readSpecRaw(project, "screens/images/login.png");
    expect(raw.mimeType).toBe("image/png");
    await expect(specs.readSpecRaw(project, "README.md")).rejects.toThrow(
      /Only images/,
    );
  });

  it("merges a BA edit into the model, returns a diff and refreshes derived files", async () => {
    const rel = ucFile("UC-001");
    const current = await specs.readSpecFile(project, rel);
    const edited = current.content.replace(
      "- Minimum 8 characters",
      "- Minimum 12 characters",
    );
    expect(edited).not.toBe(current.content);
    const res = await specs.saveSpecFile(project, {
      path: rel,
      content: edited,
      baseMtimeMs: current.mtimeMs,
    });
    expect(res.parsed).toBe(true);
    expect(res.useCaseId).toBe("UC-001");
    expect(res.diff?.changedSections).toEqual(["rules", "status"]);
    expect(res.diff?.details).toEqual([
      "BR-02 rules changed: 'Minimum 8 characters' → 'Minimum 12 characters'",
      "Status changed: generated → edited",
    ]);
    // The front matter now states the new status/revision; the body is exactly what the BA saved.
    const onDisk = await read(rel);
    expect(onDisk).toMatch(/\nstatus: edited\b/);
    expect(onDisk).toMatch(/\nrevision: 2\n/);
    expect(onDisk.split("\n---\n")[1]).toBe(edited.split("\n---\n")[1]);
    expect(res.mtimeMs).toBe(
      (await fs.stat(path.join(project.outputDir, ...rel.split("/")))).mtimeMs,
    );

    const saved = (await store.loadModel(project.id))!;
    const uc = saved.useCases.find((u) => u.id === "UC-001")!;
    expect(uc.status).toBe("edited");
    expect(uc.revision).toBe(2);
    expect(uc.businessRules[1].rules).toEqual([
      "Mandatory",
      "Minimum 12 characters",
    ]);
    expect(uc.scenarios[0].elementIds).toEqual(
      model.useCases[0].scenarios[0].elementIds,
    );
    expect(saved.changeLog.at(-1)?.kind).toBe("edited");
    expect(await read("CHANGELOG.md")).toContain("BR-02 rules changed");
    expect(
      await read(
        `features/${rel.split("/").pop()!.replace(/\.md$/, "")}.feature`,
      ),
    ).toBeTruthy();
    model = saved;
  });

  it("answers 409 when the file changed on disk after it was opened", async () => {
    const rel = ucFile("UC-002");
    const opened = await specs.readSpecFile(project, rel);
    await new Promise((r) => setTimeout(r, 20));
    await write(rel, `${opened.content}\n`);
    const later = Date.now() + 5000;
    await fs.utimes(
      path.join(project.outputDir, ...rel.split("/")),
      later / 1000,
      later / 1000,
    );
    await expect(
      specs.saveSpecFile(project, {
        path: rel,
        content: opened.content,
        baseMtimeMs: opened.mtimeMs,
      }),
    ).rejects.toThrow(expect.objectContaining({ status: 409 }));
  });

  it("saves non-use-case markdown without touching the model and refuses .feature edits", async () => {
    const res = await specs.saveSpecFile(project, {
      path: "notes/meeting.md",
      content: "# Meeting\n\nDecisions.",
    });
    expect(res.parsed).toBe(false);
    expect(res.parseErrors).toEqual([]);
    expect(await read("notes/meeting.md")).toBe("# Meeting\n\nDecisions.");
    await expect(
      specs.saveSpecFile(project, {
        path: "features/x.feature",
        content: "Feature: x",
      }),
    ).rejects.toThrow(/generated from the use case/);
    await expect(
      specs.saveSpecFile(project, { path: "../evil.md", content: "x" }),
    ).rejects.toThrow(/leave the output folder/);
  });

  it("syncs edits made outside the app and reports missing files", async () => {
    const rel = ucFile("UC-004");
    const content = await read(rel);
    await write(
      rel,
      content.replace(
        "- Shows revenue for the last 12 months",
        "- Shows revenue for the last 24 months",
      ),
    );
    const removedRel = ucFile("UC-006");
    const removedContent = await read(removedRel);
    await fs.rm(path.join(project.outputDir, ...removedRel.split("/")));

    const result = await specs.syncFromDisk(project);
    expect(result.changed.map((d) => d.useCaseId)).toContain("UC-004");
    expect(
      result.changed.find((d) => d.useCaseId === "UC-004")!.details[0],
    ).toContain("24 months");
    expect(result.missingFiles).toEqual([
      { useCaseId: "UC-006", path: removedRel },
    ]);
    const saved = (await store.loadModel(project.id))!;
    expect(saved.useCases.find((u) => u.id === "UC-004")!.status).toBe(
      "edited",
    );
    expect(await read(rel)).toMatch(/\nstatus: edited\b/);
    // The use case edited earlier in the app keeps its status (its file is not read back as "generated").
    expect(saved.useCases.find((u) => u.id === "UC-001")!.status).toBe(
      "edited",
    );
    expect(saved.changeLog.at(-1)?.kind).toBe("synced");
    await write(removedRel, removedContent);
    model = saved;
  });

  it("keeps edited files on re-render unless forced", async () => {
    const editedRel = ucFile("UC-004");
    await write(editedRel, `${await read(editedRel)}\n<!-- BA marker -->\n`);
    const kept = await specs.rerenderSpecs(project, false);
    expect(kept.preservedFiles).toEqual(
      expect.arrayContaining([ucFile("UC-001"), editedRel]),
    );
    expect(await read(editedRel)).toContain("<!-- BA marker -->");
    // Forcing replaces edits that were never synced (the Re-render dialog warns about this).
    await write(
      editedRel,
      `${await read(editedRel)}\n<!-- unsynced marker -->\n`,
    );
    const forced = await specs.rerenderSpecs(project, true);
    expect(forced.preservedFiles).toEqual([]);
    expect(await read(editedRel)).not.toContain("<!-- unsynced marker -->");
  });

  it("picks up edits made outside the app before a re-render instead of overwriting them", async () => {
    const rel = ucFile("UC-002");
    const before = await read(rel);
    expect(before).toMatch(/\nstatus: generated\b/);
    // Edited in another editor: the front matter still says "generated".
    await write(
      rel,
      before.replace(
        /## Assumptions\n\n(?:- None\n)?/,
        "## Assumptions\n\n- Picked up before the re-render.\n",
      ),
    );
    const result = await specs.rerenderSpecs(project, false);
    expect(result.preservedFiles).toContain(rel);
    const after = await read(rel);
    expect(after).toContain("- Picked up before the re-render.");
    expect(after).toMatch(/\nstatus: edited\b/);
    const saved = (await store.loadModel(project.id))!;
    expect(
      saved.useCases.find((u) => u.id === "UC-002")!.assumptions,
    ).toContain("Picked up before the re-render.");
    model = saved;
  });

  it("changes a status in the model and the front matter only", async () => {
    const rel = ucFile("UC-003");
    const before = await read(rel);
    const uc = await specs.setUseCaseStatus(project, "UC-003", "approved");
    expect(uc.status).toBe("approved");
    const after = await read(rel);
    expect(after).toMatch(/status: approved/);
    expect(after.split("\n---\n")[1]).toBe(before.split("\n---\n")[1]);
    await expect(
      specs.setUseCaseStatus(project, "UC-404", "approved"),
    ).rejects.toThrow(/UC-404 was not found/);
  });

  it("removes generated files of use cases that left the model but never BA files", async () => {
    const current = (await store.loadModel(project.id))!;
    const goneRel = current.useCases.find((u) => u.id === "UC-006")!.filePath!;
    current.useCases = current.useCases.filter((u) => u.id !== "UC-006");
    for (const uc of current.useCases)
      uc.dependsOn = uc.dependsOn.filter((d) => d !== "UC-006");
    await write("use-cases/my-own-notes.md", "# Notes the BA keeps here\n");
    await specs.writeSpecs(project, current, {
      preserveEdited: true,
      embedScreenImages: true,
    });
    await expect(read(goneRel)).rejects.toThrow();
    await expect(
      read(
        `features/${goneRel.split("/").pop()!.replace(/\.md$/, "")}.feature`,
      ),
    ).rejects.toThrow();
    expect(await read("use-cases/my-own-notes.md")).toContain(
      "Notes the BA keeps here",
    );
    await store.saveModel(project.id, current);
  });

  it("searches .md and .feature files case-insensitively", async () => {
    expect(await search.searchSpecs(project, "x")).toEqual([]);
    expect(await search.searchSpecs(project, "   ")).toEqual([]);

    const hits = await search.searchSpecs(project, "MINIMUM 12");
    expect(hits.length).toBeGreaterThan(0);
    const ucHit = hits.find((h) => h.path === ucFile("UC-001"))!;
    expect(ucHit.useCaseId).toBe("UC-001");
    expect(ucHit.title).toBe("UC-001 · Sign in with email and password");
    expect(ucHit.preview).toBe("- Minimum 12 characters");
    const lines = (await read(ucHit.path)).split("\n");
    expect(lines[ucHit.line - 1]).toContain("Minimum 12 characters");

    const gherkin = await search.searchSpecs(
      project,
      "scenario: sc-01 successful",
    );
    expect(
      gherkin.some(
        (h) =>
          h.path.startsWith("features/") &&
          h.useCaseId === "UC-001" &&
          h.title.startsWith("UC-001"),
      ),
    ).toBe(true);
    // Use case files come before the derived reports.
    const order = (
      await search.searchSpecs(project, "Reset forgotten password")
    ).map((h) => h.path);
    expect(order[0]).toBe("README.md");
    expect(order.findIndex((p) => p.startsWith("use-cases/"))).toBeLessThan(
      order.findIndex((p) => p.startsWith("features/")),
    );
  });

  it("caps search hits at 100 and trims long lines around the match", async () => {
    const long = `${"lorem ipsum ".repeat(40)}NEEDLE-in-a-haystack ${"dolor sit ".repeat(40)}`;
    await write(
      "notes/long.md",
      `# Long\n\n${long}\n${Array.from({ length: 150 }, (_, i) => `needle-in-a-haystack ${i}`).join("\n")}\n`,
    );
    const hits = await search.searchSpecs(project, "needle-in-a-haystack");
    expect(hits.length).toBe(100);
    const first = hits.find((h) => h.line === 3)!;
    expect(first.title).toBe("Long");
    expect(first.preview.length).toBeLessThanOrEqual(202);
    expect(first.preview).toContain("NEEDLE-in-a-haystack");
    expect(first.preview.startsWith("…")).toBe(true);
    expect(first.preview.endsWith("…")).toBe(true);
  });

  it("returns no hits when the output folder does not exist yet", async () => {
    expect(
      await search.searchSpecs(
        { ...project, outputDir: path.join(dataDir, "nowhere") },
        "anything",
      ),
    ).toEqual([]);
  });

  it("keeps front-matter keys the BA added when a save or a re-render rewrites the front matter", async () => {
    const rel = ucFile("UC-004");
    const opened = await specs.readSpecFile(project, rel);
    const edited = opened.content
      .replace(
        /\nsize:/,
        "\npriority: Must have # MoSCoW\nowner: Jane Cooper\nlabels: [mvp, security]\nsize:",
      )
      .replace(
        /## Assumptions\n\n(?:- None\n)?/,
        "## Assumptions\n\n- Revenue is shown in the account currency.\n",
      );
    const res = await specs.saveSpecFile(project, {
      path: rel,
      content: edited,
      baseMtimeMs: opened.mtimeMs,
    });
    expect(res.parsed).toBe(true);
    const saved = await read(rel);
    expect(saved).toMatch(/\nrevision: \d+\n/);
    expect(saved).not.toBe(edited); // the revision went up, so the front matter was rewritten
    expect(saved).toContain(
      "\npriority: Must have # MoSCoW\nowner: Jane Cooper\nlabels: [mvp, security]\n",
    );

    await specs.rerenderSpecs(project, true);
    expect(await read(rel)).toContain(
      "\npriority: Must have # MoSCoW\nowner: Jane Cooper\nlabels: [mvp, security]\n",
    );
    model = (await store.loadModel(project.id))!;
  });

  it("refreshes front matter and links of kept files when asked, leaving their content alone", async () => {
    const current = (await store.loadModel(project.id))!;
    const kept = current.useCases.find((u) => u.id === "UC-003")!; // approved earlier in this suite
    const rel = kept.filePath!;
    await write(
      rel,
      (await read(rel)).replace(
        "## Assumptions\n\n- None",
        "## Assumptions\n\n- Kept by the BA.",
      ),
    );
    const before = await read(rel);
    expect(before).toContain("[UC-005](");
    // A generation renumbered UC-005 (which depends on UC-003) to UC-009.
    current.useCases.find((u) => u.id === "UC-005")!.id = "UC-009";
    for (const f of current.features)
      f.useCaseIds = f.useCaseIds.map((id) =>
        id === "UC-005" ? "UC-009" : id,
      );

    const plain = await specs.writeSpecs(project, current, {
      preserveEdited: true,
      embedScreenImages: true,
    });
    expect(plain.preserved).toContain(rel);
    expect(await read(rel)).toBe(before);

    const refreshed = await specs.writeSpecs(project, current, {
      preserveEdited: true,
      embedScreenImages: true,
      refreshPreserved: true,
    });
    expect(refreshed.preserved).toContain(rel);
    const after = await read(rel);
    expect(after).toContain("leadsTo: [UC-009]");
    expect(after).toContain("status: approved");
    expect(after).toMatch(/\[UC-009\]\(UC-009-[a-z0-9-]+\.md\)/);
    expect(after).not.toContain("UC-005");
    expect(after.slice(after.indexOf("**Scope:**"))).toBe(
      before.slice(before.indexOf("**Scope:**")),
    );
    expect(after).toContain("- Kept by the BA.");
  });
});

/* ------------------------------------------------------------------ */
/* An output folder the BA pointed at an existing folder              */
/* ------------------------------------------------------------------ */

describe("spec store in a folder that already holds other files", () => {
  let outDir: string;
  let project: Project;
  let model: SolutionModel;
  const read = (rel: string) =>
    fs.readFile(path.join(outDir, ...rel.split("/")), "utf8");
  const write = async (rel: string, content: string | Buffer) => {
    await fs.mkdir(path.dirname(path.join(outDir, ...rel.split("/"))), {
      recursive: true,
    });
    await fs.writeFile(path.join(outDir, ...rel.split("/")), content);
  };
  const exists = (rel: string) =>
    fs.stat(path.join(outDir, ...rel.split("/"))).then(
      () => true,
      () => false,
    );

  beforeAll(async () => {
    const created = await store.createProject({
      name: "Team docs",
      description: "Orders portal",
    });
    outDir = created.outputDir;
    await write("README.md", "# My team's repo README\n");
    await write("CHANGELOG.md", "# Our changelog\n");
    await write(
      "screens/images/login.jpg",
      Buffer.from("the team's own login mock-up"),
    );
    const png = await makePng(64, 48);
    await store.addScreens(
      created.id,
      ["Login", "Dashboard", "Orders"].map((name) => ({
        originalName: `${name}.png`,
        mimeType: "image/png",
        buffer: png,
      })),
    );
    project = await store.getProject(created.id);
    // A copy of the Dashboard screen in another format, as left by an earlier write before the screen was replaced.
    await write(
      "screens/images/dashboard.webp",
      await fs.readFile(
        path.join(
          project.projectPath!,
          "screens",
          ...project.screens[1].fileName.split("/"),
        ),
      ),
    );
    model = modelFor(project);
  });

  afterAll(async () => {
    await removeDir(outDir);
  });

  it("leaves files Coherence did not write untouched and reports them", async () => {
    const result = await specs.writeSpecs(project, model, {
      preserveEdited: true,
      embedScreenImages: true,
    });
    await store.saveModel(project.id, model);
    expect(await read("README.md")).toBe("# My team's repo README\n");
    expect(await read("CHANGELOG.md")).toBe("# Our changelog\n");
    expect(result.written).not.toContain("README.md");
    expect(result.written).toEqual(
      expect.arrayContaining(["BUILD-PLAN.md", "REVIEW.md", ucFile("UC-001")]),
    );
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^README\.md already exists and was not written by Coherence/,
        ),
        expect.stringMatching(
          /^CHANGELOG\.md already exists and was not written by Coherence/,
        ),
      ]),
    );
    expect(await read("screens/images/login.jpg")).toBe(
      "the team's own login mock-up",
    );
    expect(await exists("screens/images/dashboard.webp")).toBe(false); // Coherence's own copy of the screen
    expect(JSON.parse(await read(specs.FOLDER_OWNER_FILE)).projectId).toBe(
      project.id,
    );
  });

  it("still treats files and the folder marker written before the rename as its own", async () => {
    // A folder claimed and written under the old name: the old marker, and a derived file with the old banner.
    await fs.rm(path.join(outDir, specs.FOLDER_OWNER_FILE));
    await write(
      specs.LEGACY_FOLDER_OWNER_FILE,
      JSON.stringify({ generator: "ScreenScribe", projectId: project.id }),
    );
    await write(
      "BUILD-PLAN.md",
      "<!-- Generated by ScreenScribe: this file is rewritten every time the specs are written. -->\n# Old plan\n",
    );
    const result = await specs.writeSpecs(project, model, {
      preserveEdited: true,
      embedScreenImages: true,
    });
    expect(result.written).toContain("BUILD-PLAN.md");
    expect(await read("BUILD-PLAN.md")).toContain("Generated by Coherence");
    // The folder is already this project's: the old marker stays, and no second marker is written.
    expect(await exists(specs.FOLDER_OWNER_FILE)).toBe(false);
    expect(
      JSON.parse(await read(specs.LEGACY_FOLDER_OWNER_FILE)).projectId,
    ).toBe(project.id);
  });

  function ucFile(id: string): string {
    return model.useCases.find((u) => u.id === id)!.filePath!;
  }

  it("never removes a use case file whose id the model does not know", async () => {
    // A teammate's use case, pulled from git before anyone pressed "Sync from disk".
    const theirs = (await read(ucFile("UC-002")))
      .replace(/\nid: UC-002\n/, "\nid: UC-099\n")
      .replace(/\nstatus: \w+/, "\nstatus: approved")
      .replace("# UC-002 ·", "# UC-099 ·");
    await write("use-cases/UC-099-partner-sign-in.md", theirs);

    const forced = await specs.rerenderSpecs(project, true);
    expect(await read("use-cases/UC-099-partner-sign-in.md")).toBe(theirs);
    expect(forced.warnings).toContain(
      'use-cases/UC-099-partner-sign-in.md (UC-099) is not in the solution model and was left as it is — use "Sync from disk" to add it as a use case.',
    );

    const current = (await store.loadModel(project.id))!;
    await specs.writeSpecs(project, current, {
      preserveEdited: false,
      embedScreenImages: true,
      useCaseIds: ["UC-001"],
    });
    expect(await read("use-cases/UC-099-partner-sign-in.md")).toBe(theirs);
  });

  it("moves the file of a use case that left the model out of the folder, where it can be recovered", async () => {
    const current = (await store.loadModel(project.id))!;
    const goneRel = current.useCases.find((u) => u.id === "UC-006")!.filePath!;
    const gone = await read(goneRel);
    current.useCases = current.useCases.filter((u) => u.id !== "UC-006");
    for (const uc of current.useCases)
      uc.dependsOn = uc.dependsOn.filter((d) => d !== "UC-006");

    const result = await specs.writeSpecs(project, current, {
      preserveEdited: true,
      embedScreenImages: true,
    });
    expect(await exists(goneRel)).toBe(false);
    expect(
      result.warnings.some(
        (w) => w.startsWith("Moved 1 old use case file") && w.includes(goneRel),
      ),
    ).toBe(true);
    const removedDir = path.join(project.projectPath!, specs.REMOVED_FILES_DIR);
    const [batch] = await fs.readdir(removedDir);
    expect(
      await fs.readFile(
        path.join(removedDir, batch, ...goneRel.split("/")),
        "utf8",
      ),
    ).toBe(gone);
    expect(await exists("use-cases/UC-099-partner-sign-in.md")).toBe(true);
    await store.saveModel(project.id, current);
  });

  it("refuses an attempt to share or redirect another project's canonical specifications", async () => {
    const before = await read("README.md");
    await expect(
      store.createProject({
        name: "Shared output",
        description: "",
        outputDir: outDir,
      }),
    ).rejects.toMatchObject({ status: 400 });
    const other = await store.createProject({
      name: "Independent specs",
      description: "",
    });
    await expect(
      store.updateProject(other.id, { outputDir: outDir }),
    ).rejects.toMatchObject({ status: 400 });
    expect((await store.getProject(other.id)).outputDir).not.toBe(outDir);
    expect(await read("README.md")).toBe(before);
  });
});
