#!/usr/bin/env bun
/**
 * Generate a plannotator share link from a plan file.
 * Usage: bun bin/share-link.ts <plan-file> [--callback-url <url> --callback-token <token>]
 * Output: the share URL on stdout
 */

const args = process.argv.slice(2);

if (args[0] === "--help" || args.length === 0) {
  console.log("Usage: share-link <plan-file> [--callback-url <url> --callback-token <token>]");
  console.log("  Generates a plannotator share link with optional callback params.");
  process.exit(args[0] === "--help" ? 0 : 1);
}

const file = args[0];
let callbackUrl = "";
let callbackToken = "";

for (let i = 1; i < args.length; i++) {
  if (args[i] === "--callback-url" && args[i + 1]) callbackUrl = args[++i];
  if (args[i] === "--callback-token" && args[i + 1]) callbackToken = args[++i];
}

const plan = await Bun.file(file).text();
const json = JSON.stringify({ p: plan, a: [] });
const bytes = new TextEncoder().encode(json);

const stream = new CompressionStream("deflate-raw");
const writer = stream.writable.getWriter();
writer.write(bytes);
writer.close();

const buffer = await new Response(stream.readable).arrayBuffer();
const compressed = new Uint8Array(buffer);

let binary = "";
for (let i = 0; i < compressed.length; i++) {
  binary += String.fromCharCode(compressed[i]);
}
const hash = btoa(binary)
  .replace(/\+/g, "-")
  .replace(/\//g, "_")
  .replace(/=/g, "");

let url = `https://share.plannotator.ai/#${hash}`;

if (callbackUrl && callbackToken) {
  url += `?cb=${encodeURIComponent(callbackUrl)}&ct=${callbackToken}`;
}

console.log(url);
