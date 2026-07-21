# module_bindings (generated)

**Do not edit by hand.** The TypeScript client bindings for the SpacetimeDB
module live here and are produced by:

```bash
npm run stdb:generate
# = spacetime generate --lang typescript --out-dir module_bindings --project-path stdb-module
```

`lib/multiplayer/spacetime.js` imports `DbConnection` and the generated table /
reducer types from `@/module_bindings`. You **must** run the command above once
(and again whenever `stdb-module/src/lib.rs` changes) before `next build` or
`next dev`, otherwise the import will fail.

See `SPACETIMEDB_DEPLOY.md` for the full workflow.
