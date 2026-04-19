# Zapbot

zapbot is a thin GitHub webhook bridge around `ao`.

The current runtime is:

- verify GitHub issue-comment webhooks
- parse `@zapbot ...` commands
- check write permission
- shell out to `ao spawn <issue>`
- optionally provision `MOLTZAP_*` env for the spawned session

## Commands

| Command | Effect |
|---|---|
| `@zapbot plan this` | spawn an `ao` session |
| `@zapbot investigate this` | spawn an `ao` session |
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

- `v2/` — current bridge/runtime modules
- `v2/ao/dispatcher.ts` — direct `ao spawn`
- `v2/moltzap/runtime.ts` — MoltZap session env provisioning
- `src/config/` — config load + reload
- `src/github/` — GitHub auth and API access
- `bin/webhook-bridge.ts` — bridge entrypoint
