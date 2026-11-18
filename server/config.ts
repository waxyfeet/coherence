import path from "node:path";
import { fileURLToPath } from "node:url";
import { storageLocations } from "./storage/locations";
import { registeredProjectRoot } from "./storage/projectRegistry";
// The one version source, shared with the packaged build and the installer (inlined when bundled).
import packageJson from "../package.json" with { type: "json" };

const here = path.dirname(fileURLToPath(import.meta.url));

/** Repository root (one level above /server); in the packaged app, the install folder. */
export const ROOT_DIR = path.resolve(here, "..");
/** Running from the packaged single bundle (packaging/build-app.mjs), where every module shares its URL. */
export const PACKAGED = import.meta.url.endsWith("/server/index.mjs");

export const APP_VERSION: string = packageJson.version;

/** SCREENSCRIBE_V2_PORT may list fallbacks ("41234,41235"); the launcher passes its candidates this way. */
const portCandidates = (process.env.SCREENSCRIBE_V2_PORT ?? "4417")
  .split(",")
  .map((port) => Number(port.trim()));

export const config = {
  // The installed app owns the standard folders; every developer run defaults to separate ones (D6).
  ...storageLocations(ROOT_DIR, PACKAGED ? "Coherence" : "Coherence-Dev"),
  /** Server binds to loopback only — this is a single-user local tool. */
  host: "127.0.0.1",
  port: portCandidates[0],
  /** Ports tried in order when the preferred one is taken. */
  portCandidates,
  /** Explicit development proxy port; defaults remain 5417. Also isolates browser tests. */
  devPort: Number(process.env.SCREENSCRIBE_V2_DEV_PORT ?? 5417),
  /** Built web UI (vite build output). */
  webDistDir: path.join(ROOT_DIR, "dist"),
  /** Open the browser on start (`--open`). */
  openBrowser: process.argv.includes("--open"),
};

export const paths = {
  settingsFile: () => path.join(config.dataDir, "settings.json"),
  projectDir: (projectId: string) => registeredProjectRoot(projectId),
  /** project.json — the Project record. */
  projectFile: (projectId: string) =>
    path.join(paths.projectDir(projectId), "project.json"),
  /** Screen images: screens/<screenId>/v<version>.<ext> */
  screensDir: (projectId: string) =>
    path.join(paths.projectDir(projectId), "screens"),
  /** model.json — the SolutionModel (source of truth for the graph). */
  modelFile: (projectId: string) =>
    path.join(paths.projectDir(projectId), "model.json"),
  /** Previous model snapshots: history/model-<timestamp>.json */
  historyDir: (projectId: string) =>
    path.join(paths.projectDir(projectId), "history"),
  /** impact/<reportId>.json */
  impactDir: (projectId: string) =>
    path.join(paths.projectDir(projectId), "impact"),
  /** jobs/<jobId>.json — finished job records (logs, usage, result). */
  jobsDir: (projectId: string) =>
    path.join(paths.projectDir(projectId), "jobs"),
  /** Default output dir for .md specs. */
  defaultSpecsDir: (projectId: string) =>
    path.join(paths.projectDir(projectId), "specs"),
};
