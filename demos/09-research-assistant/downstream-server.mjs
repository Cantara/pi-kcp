#!/usr/bin/env node
// A minimal REAL downstream MCP server (stdio, line-delimited JSON-RPC 2.0) for
// demo 9 — a READ-ONLY research corpus. This is the untrusted "tools" side the
// kcp-harness proxy sits in front of; it exposes NO write tools at all.
//
// Tools:
//   read_file    { path }            → file contents (sandbox-relative)
//   search_files { path, query }     → lines matching `query` under `path`
//   Skill        { skill }           → acknowledge a governed skill load
//
// Containment is the harness's job: this server has no guardrail of its own.

import { createInterface } from "node:readline";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { resolve, isAbsolute, join, relative } from "node:path";

const ROOT = process.env.SANDBOX_ROOT ?? process.cwd();
const resolvePath = (p) => (isAbsolute(p) ? p : join(ROOT, p));

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const abs = join(dir, name);
    if (statSync(abs).isDirectory()) out.push(...walk(abs));
    else out.push(abs);
  }
  return out;
}

const TOOLS = [
  { name: "read_file", description: "Read a file (sandbox-relative).",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } },
  { name: "search_files", description: "Search files under a directory for a query string.",
    inputSchema: { type: "object", properties: { path: { type: "string" }, query: { type: "string" } }, required: ["path"] } },
  { name: "Skill", description: "Load a governed skill/procedure by unit id.",
    inputSchema: { type: "object", properties: { skill: { type: "string" } }, required: ["skill"] } },
];

function callTool(name, args) {
  if (name === "read_file") {
    const abs = resolvePath(String(args.path));
    const text = existsSync(abs) ? readFileSync(abs, "utf8") : `[downstream] no such file: ${args.path}`;
    return { content: [{ type: "text", text }], isError: false };
  }
  if (name === "search_files") {
    const abs = resolvePath(String(args.path));
    const query = String(args.query ?? "").toLowerCase();
    const base = existsSync(abs) && statSync(abs).isDirectory() ? abs : ROOT;
    const hits = [];
    for (const f of walk(base)) {
      const rel = relative(ROOT, f);
      for (const line of readFileSync(f, "utf8").split("\n")) {
        if (!query || line.toLowerCase().includes(query)) hits.push(`${rel}: ${line.trim()}`);
      }
    }
    const capped = hits.slice(0, 12);
    return { content: [{ type: "text", text: capped.length ? capped.join("\n") : "[downstream] no matches" }], isError: false };
  }
  if (name === "Skill") {
    return { content: [{ type: "text", text: `[downstream] skill "${args.skill}" loaded` }], isError: false };
  }
  return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
}

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  const t = line.trim();
  if (!t) return;
  let msg; try { msg = JSON.parse(t); } catch { return; }
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "demo-research-corpus", version: "1.0.0" } } });
  } else if (method === "notifications/initialized") {
    // notification — no response
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  } else if (method === "tools/call") {
    try { send({ jsonrpc: "2.0", id, result: callTool(params?.name, params?.arguments ?? {}) }); }
    catch (e) { send({ jsonrpc: "2.0", id, error: { code: -32000, message: String(e?.message ?? e) } }); }
  } else if (id !== undefined && id !== null) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
});
