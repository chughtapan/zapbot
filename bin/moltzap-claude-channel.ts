#!/usr/bin/env bun
/**
 * moltzap-claude-channel — zapbot's worker entrypoint for the MoltZap
 * Claude channel.
 *
 * Architect rev 4 §2 worker-side glue. Heavy lifting (credential
 * resolution, AO resume metadata, debug logging) lives in
 * `src/moltzap/worker-channel.ts`.
 *
 * sbd#205 (PR #343) removed the transitional self-register path. Workers
 * now require pre-minted credentials injected by the bridge at spawn time
 * via MOLTZAP_API_KEY / MOLTZAP_SERVER_URL env vars; `resolveWorkerCredentials`
 * decodes those and fails fast if they are absent.
 */
