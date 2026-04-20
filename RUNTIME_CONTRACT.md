# Zapbot + AO + MoltZap Runtime Contract

This document is the authoritative runtime contract for the orchestrator-first deployment of
zapbot, AO, and MoltZap. It supersedes the earlier direct-spawn model described in ARCHITECTURE.md
for all projects running in orchestrator mode.

---

## 1. zapbot is a thin control shim

`zapbot` is a thin ingress and control shim for GitHub-originated events. In orchestrator mode it
does **not** directly spawn worker sessions. Its responsibilities are limited to:

1. Receiving and verifying GitHub webhook events.
2. Classifying `@zapbot` mention commands.
3. Checking write permission for the triggering user.
4. Ensuring the project orchestrator session exists (creating it if absent).
5. Forwarding the GitHub control event as a prompt to the project orchestrator.

All decisions about whether to dispatch safer-pipeline work, spawn workers, or coordinate
inter-agent activity belong to the project orchestrator, not to zapbot.

---

## 2. One persistent orchestrator session per project

Each project has exactly one persistent AO orchestrator session. This session:

- Is created proactively at first use and reused for all subsequent GitHub control events
  routed to that project.
- Is identified by a deterministic session name derived from the project name.
- Is the live coordinator for all worker activity associated with that project.
- Exactly one orchestrator session is the active coordinator for a given project at any time.

`zapbot` checks for the session via `ao status <session>` before each dispatch. If the session
does not exist or is not running, `zapbot` starts it via `ao spawn <session>` and waits for it to
reach a ready state before forwarding the control event.

---

## 3. GitHub-originated work enters through zapbot

All GitHub-originated work (issue comments, PR events) enters the runtime through `zapbot`:

1. `zapbot` verifies the webhook signature and classifies the event.
2. `zapbot` ensures the project orchestrator session exists (see §2).
3. `zapbot` forwards the control event as a structured prompt to the orchestrator via
   `ao send <session> <prompt>`.

`zapbot` does not interpret the content of the event beyond classification; interpretation and
dispatch decisions are delegated entirely to the orchestrator.

---

## 4. Orchestrator owns dispatch and worker spawning

The project orchestrator is the sole component that decides:

- Whether incoming GitHub control events require safer-pipeline work.
- When to spawn worker agent sessions.
- What context and instructions to pass to each spawned worker.

When the orchestrator needs a new worker session it must use:

```
bun run bin/ao-spawn-with-moltzap.ts <issue-number>
```

rather than plain `ao spawn`, so that the worker is provisioned with MoltZap credentials and
maintains a live communication channel back to the orchestrator.

---

## 5. Orchestrator must register as a MoltZap client

The project orchestrator session must register with the MoltZap server at startup. Registration
provides:

- A unique `MOLTZAP_SENDER_ID` that identifies this orchestrator to workers and to `zapbot`.
- A MoltZap credential set (`MOLTZAP_SERVER_URL`, `MOLTZAP_TOKEN`) used for all outbound DMs.

The orchestrator is not operational for new safer-pipeline work until MoltZap registration
succeeds. If MoltZap connectivity is unavailable at orchestrator startup, the session must not
accept work that requires live worker coordination (see §8).

---

## 6. Each spawned worker must register as its own MoltZap client

Every worker session spawned by the orchestrator receives its own MoltZap credentials. Workers:

- Register under a unique agent name (`zb-{projectName}-{issue}-{suffix}`, max 32 chars).
- Obtain a unique `MOLTZAP_SENDER_ID` distinct from the orchestrator's.
- Use that sender ID for all DMs sent to the orchestrator.

Worker MoltZap provisioning is handled by `bin/ao-spawn-with-moltzap.ts`, which calls
`v2/moltzap/runtime.ts` to build the child process environment before handing off to `ao spawn`.

---

## 7. Live coordination occurs over MoltZap DMs

All live orchestrator-to-worker and worker-to-orchestrator coordination occurs over MoltZap
direct messages (DMs):

- The orchestrator sends instructions, unblock signals, and scope changes to workers via DM.
- Workers send progress updates, completion signals, and unblock requests to the orchestrator
  via DM.
- Neither the orchestrator nor any worker polls GitHub as the primary channel for live
  coordination.

GitHub remains the channel for durable artifacts (see §9). MoltZap DMs are the channel for
everything transient and live.

---

## 8. MoltZap connectivity is required for live coordination

MoltZap connectivity is a hard prerequisite for new safer-pipeline work:

- If the orchestrator cannot reach MoltZap (registration failed, connection dropped, maximum
  reconnect attempts exhausted), the safer pipeline is **not operational** for new work.
- `zapbot` must not forward a control event that would trigger worker spawning when the
  orchestrator's MoltZap channel is unavailable.
- The orchestrator must surface the connectivity failure to `zapbot` (via `ao send` response or
  an error reply) so that `zapbot` can post a GitHub comment indicating the pipeline is
  temporarily unavailable.

The reconnect/backoff policy (initial 1 s, cap 60 s, max 8 attempts, full-jitter exponential) is
implemented in `v2/moltzap/supervisor.ts`.

---

## 9. GitHub remains the durable source of truth

GitHub is the canonical, durable record for all user-visible workflow state and artifacts:

- Issue body and labels are the source of truth for task scope and status.
- PR descriptions, review comments, and merge events are the source of truth for code review and
  landing state.
- Published plan artifacts, spec documents, and status updates are posted as GitHub comments or
  PR descriptions.
- Workers must write all durable artifacts to GitHub even though live coordination occurs over
  MoltZap.

Nothing stored only in MoltZap DM history is considered durable. If a message matters beyond the
lifetime of a single session pair, it must be mirrored to GitHub.

---

## 10. Worker-to-worker direct messaging is out of scope

The first shipped version uses a hub-and-spoke communication topology:

- Workers communicate only with the orchestrator, never directly with other workers.
- Cross-worker coordination is mediated by the orchestrator: if worker A needs input from
  worker B, it sends a DM to the orchestrator, which relays or resolves the dependency.
- Direct worker-to-worker DMs are not provisioned, not authorized, and not routed in this
  version.

---

## 11. Arbitrary MoltZap payloads are acceptable in the first version

Formal typed message schemas for orchestrator-to-worker and worker-to-orchestrator DMs are
deferred. In the first shipped version:

- Any free-text or JSON-encoded payload carried in a MoltZap DM `bodyText` field is acceptable.
- The runtime must preserve enough structure in each message for the orchestrator to make routing
  decisions (e.g., which issue a message pertains to) and for durable GitHub publication.
- Formal schemas will be introduced in a follow-on phase once the coordination patterns are
  stable.

---

## Summary table

| Contract | Responsible component |
|---|---|
| GitHub ingress + permission check | `zapbot` |
| Orchestrator session lifecycle | `zapbot` (ensure) + AO (run) |
| Control event forwarding | `zapbot` → AO orchestrator via `ao send` |
| Safer-pipeline dispatch decisions | AO orchestrator |
| Worker spawning | AO orchestrator via `bin/ao-spawn-with-moltzap.ts` |
| Orchestrator MoltZap registration | AO orchestrator session startup |
| Worker MoltZap registration | `bin/ao-spawn-with-moltzap.ts` + `v2/moltzap/runtime.ts` |
| Live orchestrator↔worker coordination | MoltZap DMs |
| MoltZap reconnect/backoff | `v2/moltzap/supervisor.ts` |
| Durable artifact publication | AO orchestrator + workers → GitHub |
| Cross-worker coordination | AO orchestrator (hub-and-spoke) |
