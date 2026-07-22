#!/usr/bin/env node
// A minimal REAL downstream MCP server (stdio, line-delimited JSON-RPC 2.0).
//
// This is the "tools" side the kcp-harness proxy sits in front of. It is NOT a
// mock of governance — it is exactly the kind of untrusted tool server the
// harness is designed to police. It exposes two filesystem tools rooted at a
// sandbox directory (SANDBOX_ROOT). The harness spawns it, lists its tools, and
// forwards only the calls that survive governance.
//
// Tools:
//   read_file  { path }            → returns file contents (sandbox-relative)
//   write_file { path, content }   → writes a file (sandbox-relative)
//
// Absolute paths (e.g. /etc/shadow) resolve OUTSIDE the sandbox — the server
// itself has no guardrail; containment is the harness's job, which is the point.

import { createInterface } from "node:readline";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, dirname, isAbsolute, join } from "node:path";

const ROOT = process.env.SANDBOX_ROOT ?? process.cwd();
const resolvePath = (p) => (isAbsolute(p) ? p : join(ROOT, p));

const TOOLS = [
  {
    name: "read_file",
    description: "Read a file (sandbox-relative unless absolute).",
    inputSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  },
  {
    name: "write_file",
    description: "Write a file (sandbox-relative unless absolute).",
    inputSchema: {
      type: "object",
      properties: { path: { type: "string" }, content: { type: "string" } },
      required: ["path", "content"],
    },
  },
  {
    // The built-in KCP "Skill" invocation tool. The harness intercepts this,
    // runs skill_eligibility, and (on pass) records the active skill BEFORE the
    // call reaches us — so all we do is acknowledge the load.
    name: "Skill",
    description: "Load a governed skill/procedure by unit id.",
    inputSchema: { type: "object", properties: { skill: { type: "string" } }, required: ["skill"] },
  },
];

function callTool(name, args) {
  if (name === "read_file") {
    const abs = resolvePath(String(args.path));
    const text = existsSync(abs) ? readFileSync(abs, "utf8") : `[downstream] no such file: ${args.path}`;
    return { content: [{ type: "text", text }], isError: false };
  }
  if (name === "write_file") {
    const abs = resolvePath(String(args.path));
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, String(args.content ?? ""));
    return { content: [{ type: "text", text: `[downstream] wrote ${args.path}` }], isError: false };
  }
  if (name === "Skill") {
    return { content: [{ type: "text", text: `[downstream] skill "${args.skill}" loaded` }], isError: false };
  }
  return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
}

const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
const rl = createInterface({ input: process.stdin, terminal: false });

rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return;
  }
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "demo-downstream-fs", version: "1.0.0" },
      },
    });
  } else if (method === "notifications/initialized") {
    // notification — no response
  } else if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
  } else if (method === "tools/call") {
    try {
      send({ jsonrpc: "2.0", id, result: callTool(params?.name, params?.arguments ?? {}) });
    } catch (e) {
      send({ jsonrpc: "2.0", id, error: { code: -32000, message: String(e?.message ?? e) } });
    }
  } else if (id !== undefined && id !== null) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } });
  }
});
