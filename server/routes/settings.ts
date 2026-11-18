/**
 * OWNER: server-core builder.
 * /api/settings — AI connections, tracker integrations and the Figma token. Secrets never leave the server:
 * every response goes through the public (masked) shapes.
 */
import express from "express";
import { z } from "zod";
import type {
  IntegrationInput,
  ListModelsRequest,
  TestConnectionResponse,
} from "@shared/api";
import { EXTERNAL_SYSTEM_LABEL } from "@shared/api";
import type { ExternalSystem } from "@shared/types";
import { BadRequestError } from "../errors";
import { testModelCapability } from "../llm/capabilities";
import { testIntegration } from "../export/exporter";
import { testFigmaToken } from "../importers/figma";
import {
  listModelsFor,
  testConnection,
  resolveModelSelection,
} from "../llm/registry";
import { param, parseBody, parseWith } from "../middleware/validate";
import {
  createConnection,
  deleteConnection,
  deleteFigmaToken,
  deleteIntegration,
  getConnection,
  getFigmaToken,
  getIntegration,
  getPublicSettings,
  resetLockedKeys,
  resolveConnectionInput,
  resolveIntegrationInput,
  reusableApiKey,
  setDefaultConnection,
  setFigmaToken,
  setIntegration,
  toPublicConnection,
  updateConnection,
  replaceWorkspaceSettings,
} from "../storage/settingsStore";
import {
  connectionUsage,
  reassignConnection,
} from "../storage/connectionUsage";
import {
  connectionInputSchema,
  defaultConnectionSchema,
  reassignSchema,
  externalSystemSchema,
  figmaTestSchema,
  figmaTokenSchema,
  integrationInputSchema,
  listModelsSchema,
  testConnectionSchema,
} from "./schemas";

function systemParam(raw: string): ExternalSystem {
  const parsed = externalSystemSchema.safeParse(raw);
  if (!parsed.success)
    throw new BadRequestError(
      `Unknown integration "${raw}". Use jira, azdo or github.`,
    );
  return parsed.data;
}

/** Body for an integration route; the system comes from the URL when the body omits it. */
function integrationBody(
  system: ExternalSystem,
  body: unknown,
): IntegrationInput {
  const raw = (body && typeof body === "object" ? body : {}) as Record<
    string,
    unknown
  >;
  if (raw.system !== undefined && raw.system !== system) {
    throw new BadRequestError(
      `The body is for "${String(raw.system)}" but the URL is for "${system}".`,
    );
  }
  return parseWith(
    integrationInputSchema,
    { ...raw, system },
    `${EXTERNAL_SYSTEM_LABEL[system]} settings`,
  );
}

export function settingsRouter(): express.Router {
  const router = express.Router();

  router.get("/settings", async (_req, res) => {
    res.set("Cache-Control", "no-store").json(await getPublicSettings());
  });
  // Saved keys Windows cannot unlock for this account: keep that file aside and continue without its keys.
  router.post("/settings/keys/reset", async (_req, res) => {
    await resetLockedKeys();
    res.json(await getPublicSettings());
  });
  router.put("/settings/workspace", async (req, res) => {
    const preferences = z.object({
      theme: z.enum([
        "dark",
        "light",
        "system",
        "ocean",
        "cyberpunk",
        "retrowave",
        "terminal",
        "forest",
        "cute",
      ]),
      density: z.enum(["comfortable", "compact"]),
      reduceMotion: z.boolean(),
      backgroundEffects: z.boolean().optional(),
      visionId: z.string(),
      textId: z.string(),
      thoroughness: z.string(),
      granularity: z.string(),
      preserveEdits: z.boolean(),
      embedImages: z.boolean(),
      reuseAnalysis: z.boolean(),
    });
    const schema = z.object({
      baseRevision: z.number().int().nonnegative(),
      connections: z
        .array(
          connectionInputSchema.extend({
            id: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
          }),
        )
        .min(1)
        .max(100),
      defaultConnectionId: z.string(),
      analysisDefaults: z
        .object({
          visionConnectionId: z.string().max(100),
          visionModelId: z.string().max(300),
          textConnectionId: z.string().max(100),
          textModelId: z.string().max(300),
        })
        .optional(),
      integrations: z.array(integrationInputSchema).max(3),
      figmaToken: z.string().max(10000).optional(),
      clearFigma: z.boolean().optional(),
      preferences,
    });
    res.json(
      await replaceWorkspaceSettings(
        parseWith(schema, req.body, "Workspace settings"),
      ),
    );
  });

  /* ── AI connections ── */

  router.post("/settings/connections/capabilities/test", async (req, res) => {
    const body = parseWith(
      z
        .object({
          connectionId: z
            .string()
            .regex(/^[A-Za-z0-9_-]{1,100}$/)
            .optional(),
          connection: connectionInputSchema.optional(),
          modelId: z.string().trim().min(1).max(300),
          capability: z.enum(["text", "image", "structured", "metadata"]),
          mode: z.enum(["native", "prompt"]).optional(),
        })
        .refine(
          (v) => v.connectionId || v.connection,
          "Choose a connection to test",
        ),
      req.body,
      "Model test",
    );
    const connection = body.connection
      ? await resolveConnectionInput(body.connection, body.connectionId)
      : await getConnection(body.connectionId!);
    const controller = new AbortController();
    const cancel = () => {
      if (!res.writableEnded) controller.abort();
    };
    res.once("close", cancel);
    try {
      const result = await testModelCapability(
        connection,
        body.modelId,
        body.capability,
        body.mode,
        controller.signal,
      );
      if (!controller.signal.aborted)
        res.set("Cache-Control", "no-store").json(result);
    } finally {
      res.off("close", cancel);
    }
  });

  router.post("/settings/connections/test", async (req, res) => {
    const body = parseBody(testConnectionSchema, req);
    const connection = body.connection
      ? await resolveConnectionInput(body.connection, body.connectionId)
      : await getConnection(body.connectionId!);
    const result: TestConnectionResponse = await testConnection(
      resolveModelSelection(
        connection,
        body.modelId ?? body.connection?.model,
        { test: true },
      ),
    );
    res.json(result);
  });

  router.post("/settings/connections/models", async (req, res) => {
    const { connectionId, ...body } = parseBody(listModelsSchema, req);
    const request: ListModelsRequest = { ...body };
    // Reuse the stored key (and endpoint) of an existing connection when the form left them empty — but only
    // for the URL the key was saved with (reusableApiKey throws otherwise). connectionId is passed on only once
    // vetted here, so listModelsFor cannot pick the stored key up by itself.
    if (connectionId) {
      const stored = await getConnection(connectionId);
      if (stored && stored.provider === body.provider) {
        request.baseUrl ||= stored.baseUrl;
        request.azureApiVersion ||= stored.azureApiVersion;
        if (!request.apiKey && !request.clearApiKey)
          request.apiKey = reusableApiKey(
            stored,
            body.provider,
            request.baseUrl,
          );
        request.connectionId = connectionId;
        if (request.presetId === undefined) request.presetId = stored.presetId;
      }
    }
    // A key reused from storage is only sent to the address it was saved with (no /v1 retry).
    const savedKey = !body.apiKey?.trim() && !!request.apiKey;
    res.json(await listModelsFor(request, { savedKey }));
  });

  router.post("/settings/connections", async (req, res) => {
    const connection = await createConnection(
      parseBody(connectionInputSchema, req),
    );
    res.status(201).json(toPublicConnection(connection));
  });

  router.put("/settings/connections/:connId", async (req, res) => {
    const connection = await updateConnection(
      param(req, "connId"),
      parseBody(connectionInputSchema, req),
    );
    res.json(toPublicConnection(connection));
  });

  router.get("/settings/connections/:connId/usage", async (req, res) => {
    const connId = param(req, "connId");
    await getConnection(connId);
    res.set("Cache-Control", "no-store").json(await connectionUsage(connId));
  });

  router.post("/settings/connections/:connId/reassign", async (req, res) => {
    const { to } = parseBody(reassignSchema, req);
    res.json(await reassignConnection(param(req, "connId"), to));
  });

  router.delete("/settings/connections/:connId", async (req, res) => {
    await deleteConnection(param(req, "connId"));
    res.json({ ok: true });
  });

  router.put("/settings/default-connection", async (req, res) => {
    const { connectionId } = parseBody(defaultConnectionSchema, req);
    await setDefaultConnection(connectionId);
    res.json(await getPublicSettings());
  });

  /* ── Integrations ── */

  router.put("/settings/integrations/:system", async (req, res) => {
    const system = systemParam(param(req, "system"));
    await setIntegration(integrationBody(system, req.body));
    res.json(await getPublicSettings());
  });

  router.delete("/settings/integrations/:system", async (req, res) => {
    await deleteIntegration(systemParam(param(req, "system")));
    res.json(await getPublicSettings());
  });

  router.post("/settings/integrations/:system/test", async (req, res) => {
    const system = systemParam(param(req, "system"));
    const raw = (
      req.body && typeof req.body === "object" ? req.body : {}
    ) as Record<string, unknown>;
    const hasForm = Object.keys(raw).some((k) => k !== "system");
    let settings;
    if (hasForm) {
      settings = await resolveIntegrationInput(integrationBody(system, raw));
    } else {
      settings = await getIntegration(system);
      if (!settings)
        throw new BadRequestError(
          `${EXTERNAL_SYSTEM_LABEL[system]} is not set up yet — fill in the form first.`,
        );
    }
    res.json(await testIntegration(system, settings));
  });

  /* ── Figma ── */

  router.put("/settings/figma", async (req, res) => {
    const { token } = parseBody(figmaTokenSchema, req);
    await setFigmaToken(token);
    res.json(await getPublicSettings());
  });

  router.delete("/settings/figma", async (_req, res) => {
    await deleteFigmaToken();
    res.json(await getPublicSettings());
  });

  router.post("/settings/figma/test", async (req, res) => {
    const { token } = parseBody(figmaTestSchema, req);
    const effective = token ?? (await getFigmaToken());
    if (!effective) {
      const result: TestConnectionResponse = {
        ok: false,
        message: "No Figma token yet — paste a personal access token first.",
      };
      res.json(result);
      return;
    }
    res.json(await testFigmaToken(effective));
  });

  return router;
}
