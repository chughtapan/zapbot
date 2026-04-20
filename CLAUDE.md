# Zapbot

zapbot is a thin GitHub webhook bridge around `ao`.

The current runtime is:

- verify GitHub issue-comment webhooks
- parse `@zapbot ...` commands
- check write permission
- ensure the persistent AO orchestrator exists
- forward the raw GitHub control event into that orchestrator
- optionally provision `MOLTZAP_*` env for orchestrator and worker sessions

## Commands

| Command | Effect |
|---|---|
| `@zapbot plan this` | spawn an `ao` session |
| `@zapbot triage this` | alias for `plan this` |
| `@zapbot investigate this` | spawn an `ao` session |
| `@zapbot investigate` | alias for `investigate this` |
| `@zapbot status` | post a GitHub-native issue summary |

## Useful commands

```bash
bun run test
bun run lint
bun run build
bun run bridge
./start.sh
```

## Key paths

- `src/` — current bridge/runtime modules
- `src/orchestrator/` — persistent AO orchestrator control path
- `bin/ao-spawn-with-moltzap.ts` — worker spawn helper that preserves MoltZap linkage
- `src/moltzap/runtime.ts` — MoltZap session env provisioning
- `src/config/` — config load + reload
- `src/github/` — GitHub auth and API access
- `worker/ao-plugin-agent-claude-moltzap/` — repo-local Claude/MoltZap AO agent plugin
- `bin/webhook-bridge.ts` — bridge entrypoint
