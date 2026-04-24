/**
 * Test stubs for src/moltzap/worker-app.ts.
 *
 * Anchors: sbd#199 acceptance items 1, 7 (worker boot per A+C(2)),
 * 8 (zapbot#336 — workers never call apps/register).
 */

import { describe, it } from "vitest";

describe("worker-app: join sequence", () => {
  it.todo(
    "joinWorkerSession connects via auth/connect and waits for app/sessionReady",
  );
  it.todo("joinWorkerSession is idempotent: second call returns WorkerJoinAlreadyBooted");
  it.todo(
    "joinWorkerSession fails with WorkerJoinNoSessionReady when sessionReady does not arrive within joinTimeoutMs",
  );
});

describe("worker-app: zapbot#336 — workers never register", () => {
  it.todo("worker process issues zero apps/register RPCs during full lifecycle");
  it.todo("worker process issues zero apps/create RPCs during full lifecycle");
});

describe("worker-app: role-pair gates", () => {
  it.todo(
    "workerSend rejects keys outside sendableKeysForRole(role) with KeyDisallowedForRole",
  );
  it.todo(
    "workerOnMessage rejects keys outside receivableKeysForRole(role) with KeyNotReceivableForRole",
  );
  it.todo("workerSend dispatches messages/send for permitted keys");
});
