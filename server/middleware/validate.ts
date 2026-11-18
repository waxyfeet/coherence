/**
 * OWNER: server-core builder.
 * zod request validation → BadRequestError with readable issues.
 */
import type { Request } from "express";
import type { z } from "zod";
import { BadRequestError } from "../errors";

function formatPath(path: PropertyKey[]): string {
  return path
    .map((p) => (typeof p === "number" ? `[${p}]` : String(p)))
    .join(".")
    .replace(/\.\[/g, "[");
}

/** "name: Too small…; screenIds[2]: Invalid input…" */
export function describeIssues(issues: z.core.$ZodIssue[]): string {
  return issues
    .slice(0, 5)
    .map((issue) =>
      issue.path.length
        ? `${formatPath(issue.path)}: ${issue.message}`
        : issue.message,
    )
    .join("; ");
}

/** Parse a value (usually req.body; an absent body counts as {}) or throw BadRequestError. */
export function parseWith<S extends z.ZodType>(
  schema: S,
  value: unknown,
  what = "request",
): z.output<S> {
  const result = schema.safeParse(value ?? {});
  if (!result.success) {
    throw new BadRequestError(
      `Invalid ${what}: ${describeIssues(result.error.issues)}`,
      result.error.issues.map((i) => ({
        path: i.path.map(String),
        message: i.message,
        code: i.code,
      })),
    );
  }
  return result.data;
}

export function parseBody<S extends z.ZodType>(
  schema: S,
  req: Request,
): z.output<S> {
  return parseWith(schema, req.body, "request");
}

export function parseQuery<S extends z.ZodType>(
  schema: S,
  req: Request,
): z.output<S> {
  return parseWith(schema, req.query, "query");
}

/** Route params are strings in Express 5; this keeps handlers tidy. */
export function param(req: Request, name: string): string {
  const value = req.params[name];
  if (typeof value !== "string" || !value)
    throw new BadRequestError(`Missing "${name}" in the URL.`);
  return value;
}
