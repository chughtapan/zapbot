#!/usr/bin/env bun
import { createHmac } from "crypto";

const BRIDGE_PORT = Number(process.env.ZAPBOT_BRIDGE_PORT) || 3000;
const AO_PORT = Number(process.env.ZAPBOT_AO_PORT) || 3001;
const SECRET = process.env.GITHUB_WEBHOOK_SECRET;
const APPROVE_LABEL = process.env.ZAPBOT_APPROVE_LABEL || "plan-approved";

if (!SECRET) {
  console.error("[bridge] GITHUB_WEBHOOK_SECRET is required. Set it in .env or export it.");
  process.exit(1);
}

// --- Token store (in-memory, one-time use, 24h expiry) ---
const tokens = new Map<string, { issueNumber: number; createdAt: number }>();
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

setInterval(() => {
  const now = Date.now();
  for (const [key, val] of tokens) {
    if (now - val.createdAt > TOKEN_TTL_MS) tokens.delete(key);
  }
}, 60 * 60 * 1000);

// --- Spawned issues tracker (dedup) ---
const spawnedIssues = new Set<number>();

function verifyHmac(payload: string, signature: string): boolean {
  const expected = "sha256=" + createHmac("sha256", SECRET!).update(payload).digest("hex");
  return expected.length === signature.length &&
    Buffer.from(expected).equals(Buffer.from(signature));
}

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: code, message }, { status });
}

async function decompress(b64: string): Promise<unknown> {
  const base64 = b64.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const stream = new DecompressionStream("deflate-raw");
  const writer = stream.writable.getWriter();
  writer.write(bytes);
  writer.close();
  const buffer = await new Response(stream.readable).arrayBuffer();
  return JSON.parse(new TextDecoder().decode(buffer));
}

function formatAnnotations(annotations: any[]): string {
  if (!annotations || annotations.length === 0) return "No annotations.";
  return annotations
    .map((a: any, i: number) => {
      const type = a.type || a.action || "comment";
      const text = a.text || a.content || a.body || JSON.stringify(a);
      const line = a.line != null ? ` (line ${a.line})` : "";
      return `${i + 1}. **[${type}]**${line}: ${text}`;
    })
    .join("\n");
}

async function proxyToAO(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const target = `http://localhost:${AO_PORT}${url.pathname}${url.search}`;
  try {
    const headers = new Headers(req.headers);
    headers.delete("host");
    const resp = await fetch(target, {
      method: req.method,
      headers,
      body: req.method !== "GET" && req.method !== "HEAD" ? await req.arrayBuffer() : undefined,
      signal: AbortSignal.timeout(10000),
    });
    return new Response(resp.body, {
      status: resp.status,
      headers: resp.headers,
    });
  } catch {
    return jsonError("ao_unreachable", `AO not responding on port ${AO_PORT}`, 502);
  }
}

async function handleGitHubWebhook(req: Request, body: string): Promise<Response> {
  const sig = req.headers.get("x-hub-signature-256") || "";
  if (!verifyHmac(body, sig)) {
    return jsonError("hmac_invalid", "HMAC signature mismatch. Check GITHUB_WEBHOOK_SECRET.", 401);
  }

  const event = req.headers.get("x-github-event");
  const payload = JSON.parse(body);

  if (event === "issues" && payload.action === "labeled") {
    const label = payload.label?.name;
    const issueNum = payload.issue?.number;

    if (label === APPROVE_LABEL && typeof issueNum === "number" && issueNum > 0) {
      if (spawnedIssues.has(issueNum)) {
        console.log(`[bridge] Issue #${issueNum} already spawned, skipping`);
        return Response.json({ ok: true, action: "skipped", reason: "already_spawned" }, { status: 200 });
      }

      console.log(`[bridge] ${APPROVE_LABEL} on issue #${issueNum}, spawning...`);
      spawnedIssues.add(issueNum);

      const proc = Bun.spawn(["ao", "spawn", String(issueNum)], {
        stdout: "pipe",
        stderr: "pipe",
      });
      proc.exited.then((code) => {
        if (code !== 0) {
          console.error(`[bridge] ao spawn ${issueNum} failed with code ${code}`);
          spawnedIssues.delete(issueNum);
        } else {
          console.log(`[bridge] ao spawn ${issueNum} succeeded`);
        }
      });

      return Response.json({ ok: true, action: "spawning", issue: issueNum }, { status: 202 });
    }
  }

  // Forward all other GitHub events to AO
  const target = `http://localhost:${AO_PORT}/api/webhooks/github`;
  try {
    const resp = await fetch(target, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": sig,
        "x-github-event": event || "",
        "x-github-delivery": req.headers.get("x-github-delivery") || "",
      },
      body,
      signal: AbortSignal.timeout(10000),
    });
    return new Response(resp.body, { status: resp.status, headers: resp.headers });
  } catch {
    return jsonError("ao_unreachable", "Could not forward event to AO", 502);
  }
}

async function handlePlannotatorCallback(req: Request, issueNum: number): Promise<Response> {
  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return jsonError("invalid_body", "Request body must be valid JSON", 400);
  }

  const { token, annotated_url, action } = payload;
  if (!token || typeof token !== "string") {
    return jsonError("missing_token", "callback token (ct) is required", 400);
  }

  const stored = tokens.get(token);
  if (!stored) {
    return jsonError("invalid_token", "Token is invalid or already used", 403);
  }
  if (stored.issueNumber !== issueNum) {
    return jsonError("token_mismatch", "Token does not match this issue", 403);
  }
  tokens.delete(token);

  // Decompress annotations from the annotated URL
  let commentBody = `**Plannotator review feedback** (${action || "feedback"})`;
  if (annotated_url && typeof annotated_url === "string") {
    try {
      const hashIdx = annotated_url.indexOf("#");
      if (hashIdx !== -1) {
        let hash = annotated_url.slice(hashIdx + 1);
        const qIdx = hash.indexOf("?");
        if (qIdx !== -1) hash = hash.slice(0, qIdx);
        const data = (await decompress(hash)) as { p?: string; a?: any[] };
        if (data.a && data.a.length > 0) {
          commentBody += `\n\n### Annotations\n\n${formatAnnotations(data.a)}`;
        } else {
          commentBody += "\n\n_No specific annotations. Plan was reviewed visually._";
        }
      }
    } catch (err) {
      commentBody += `\n\n_Could not parse annotations. [View in Plannotator](${annotated_url})_`;
    }
    commentBody += `\n\n[View annotated plan in Plannotator](${annotated_url})`;
  }

  // Post as GitHub issue comment
  const repo = process.env.ZAPBOT_REPO;
  if (!repo) {
    return jsonError("no_repo", "ZAPBOT_REPO env var is required", 500);
  }
  try {
    const proc = Bun.spawn(["gh", "issue", "comment", String(issueNum), "--repo", repo, "--body", commentBody], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await proc.exited;
    if (code !== 0) {
      const stderr = await new Response(proc.stderr).text();
      console.error(`[bridge] gh issue comment failed: ${stderr}`);
      return jsonError("comment_failed", "Failed to post issue comment", 500);
    }
  } catch (err: any) {
    return jsonError("comment_error", err.message, 500);
  }

  console.log(`[bridge] Posted annotation feedback on issue #${issueNum}`);
  return Response.json({ ok: true, action: "comment_posted", issue: issueNum });
}

Bun.serve({
  port: BRIDGE_PORT,
  async fetch(req) {
    const url = new URL(req.url);

    // Health check
    if (url.pathname === "/healthz") {
      return Response.json({ ok: true, bridge: true, ao_port: AO_PORT });
    }

    // Token registration (called by zapbot-publish.sh)
    if (req.method === "POST" && url.pathname === "/api/tokens") {
      try {
        const { token, issueNumber } = (await req.json()) as any;
        if (!token || !issueNumber) {
          return jsonError("missing_fields", "token and issueNumber required", 400);
        }
        tokens.set(token, { issueNumber, createdAt: Date.now() });
        return Response.json({ ok: true, registered: true });
      } catch {
        return jsonError("invalid_body", "Request body must be valid JSON", 400);
      }
    }

    // GitHub webhooks
    if (req.method === "POST" && url.pathname === "/api/webhooks/github") {
      const body = await req.text();
      return handleGitHubWebhook(req, body);
    }

    // Plannotator callbacks: /api/callbacks/plannotator/:issueNumber
    const cbMatch = url.pathname.match(/^\/api\/callbacks\/plannotator\/(\d+)$/);
    if (req.method === "POST" && cbMatch) {
      const issueNum = parseInt(cbMatch[1], 10);
      return handlePlannotatorCallback(req, issueNum);
    }

    // Proxy everything else to AO
    return proxyToAO(req);
  },
});

console.log(`[bridge] Zapbot webhook bridge listening on port ${BRIDGE_PORT}`);
console.log(`[bridge] Proxying to AO on port ${AO_PORT}`);
console.log(`[bridge] Trigger label: ${APPROVE_LABEL}`);
