/**
 * OWNER: server-core builder.
 * Spec files in project.outputDir: tree, read, save, raw images, sync from disk, re-render, search.
 * Path safety (no traversal / symlink escape) is enforced by specStore.resolveSpecPath.
 */
import express from "express";
import { BadRequestError } from "../errors";
import { param, parseBody } from "../middleware/validate";
import { getProject, loadModel } from "../storage/projectStore";
import { searchSpecs } from "../specs/search";
import {
  listSpecTree,
  readSpecFile,
  readSpecRaw,
  rerenderSpecs,
  saveSpecFile,
  syncFromDisk,
} from "../specs/specStore";
import { assertNoActiveJob, queryString } from "./helpers";
import { rerenderSchema, saveSpecFileSchema } from "./schemas";

function requiredPath(value: unknown): string {
  const relPath = queryString(value);
  if (!relPath)
    throw new BadRequestError('Missing "path" — which file should be opened?');
  return relPath;
}

export function filesRouter(): express.Router {
  const router = express.Router();

  router.get("/projects/:pid/files", async (req, res) => {
    const projectId = param(req, "pid");
    const project = await getProject(projectId);
    res
      .set("Cache-Control", "no-store")
      .json(await listSpecTree(project, await loadModel(projectId)));
  });

  router.get("/projects/:pid/files/content", async (req, res) => {
    const project = await getProject(param(req, "pid"));
    res
      .set("Cache-Control", "no-store")
      .json(await readSpecFile(project, requiredPath(req.query.path)));
  });

  router.put("/projects/:pid/files/content", async (req, res) => {
    const projectId = param(req, "pid");
    const body = parseBody(saveSpecFileSchema, req);
    const project = await getProject(projectId);
    // These jobs rewrite use case files and the model from what they read before their AI calls when they
    // finish — an edit saved meanwhile would be silently overwritten.
    assertNoActiveJob(projectId, "save changes to the spec files", [
      "generate",
      "revise",
      "impact-apply",
    ]);
    res.json(await saveSpecFile(project, body));
  });

  router.get("/projects/:pid/files/raw", async (req, res) => {
    const project = await getProject(param(req, "pid"));
    const { buffer, mimeType } = await readSpecRaw(
      project,
      requiredPath(req.query.path),
    );
    res.set({
      "Content-Type": mimeType,
      // Do not allow a private file to survive the session in a shared HTTP cache.
      "Cache-Control": "no-store",
      // SVGs from the output folder must never run script on this origin.
      "Content-Security-Policy":
        "default-src 'none'; style-src 'unsafe-inline'; sandbox",
    });
    res.send(buffer);
  });

  router.post("/projects/:pid/sync", async (req, res) => {
    const projectId = param(req, "pid");
    const project = await getProject(projectId);
    assertNoActiveJob(projectId, "sync the specs from disk");
    res.json(await syncFromDisk(project));
  });

  router.post("/projects/:pid/rerender", async (req, res) => {
    const projectId = param(req, "pid");
    const { force } = parseBody(rerenderSchema, req);
    const project = await getProject(projectId);
    assertNoActiveJob(projectId, "re-render the specs");
    res.json(await rerenderSpecs(project, force ?? false));
  });

  router.get("/projects/:pid/search", async (req, res) => {
    const project = await getProject(param(req, "pid"));
    const q = (queryString(req.query.q) ?? "").trim();
    res.set("Cache-Control", "no-store").json(await searchSpecs(project, q));
  });

  return router;
}
