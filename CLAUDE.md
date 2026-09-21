# screenwriter_lib

Frontend business-logic library for Fadewright. Slice F2 of `../screenwriter_plans/plans/2026-09-20-frontend-mvp.md`. Sits between `screenwriter_client` (network, sync socket) and the UI. **No UI code.** Local package: no publishing, no versions, no CI workflow; consumers import it by path (`tsconfig` `paths` + Vite alias to `../screenwriter_lib/src/index.ts`).

## Tech stack

Bun, TypeScript (ESM, `moduleResolution: bundler`), zustand (vanilla stores), React 19 (peer), Yjs V2, Vitest. Depends on `writing_core` (document engine), `screenwriter_client`, `screenwriter_types` by path.

## Structure

```
src/
  index.ts          barrel
  ports/            AuthPort, OfflineDocStore + InMemoryOfflineDocStore
  auth/dev-auth.ts  DevAuthPort (token dev:<uid>:<email>, uid = deterministic hash of the email)
  stores/           vanilla zustand stores made by factories over a (fakeable) client: auth, projects, documents, templates
  session/          DocumentSession: types.ts (public API), document-session.ts (the core), emitter.ts
  screenwriter.ts   createScreenwriter({network, baseUrl, auth, offline, sync?, session?}): wires client + SyncClient + stores + session factory
  flows/import-export.ts  createImportExportFlow: importScript(projectId,{filename,bytes}) / exportDocument(id, format) (bytes in, bytes out; export first waits for the open session to settle); on `Screenwriter.importExport`
  react/            ScreenwriterProvider, useScreenwriter, useAuth/useProjects/useDocuments/useTemplates/useDocumentSession (thin)
tests/              stores + DevAuth (fake client), hooks (fake network), session.integration (spawns the REAL API)
```

## Commands

- `bun install`; `bun run typecheck` (`bunx tsc --noEmit`); `bunx vitest run` (never `bun test`).
- `tests/session.integration.test.ts` spawns `bun run src/index.ts` in `../screenwriter_api` on a random port (`AI_TEST_MODE=1`, `postgres://localhost:5432/screenwriter_test`; the API creates its tables at boot). Never use `screenwriter_dev`. Needs local Postgres.

## AI flow

`flows/ai.ts` `createAiFlow(client, documentId, {pollMs})` (also `Screenwriter.createAi(documentId)`; the react hook is `useAi(documentId)`): status, `startReview()`, `startPolish({sceneIds})`, polling of the current job, the last coverage report (read back from the document's recent jobs on `refresh()`), the pending suggestion set, `accept(ids)` / `acceptAll()` / `reject(ids?)`. A refused accept resolves as `{ok:false, reason:'stale', suggestionIds}` (not an error); `describeAiError(code)` gives plain-language text for `AI_OUTPUT_INVALID`, `AI_UNAVAILABLE`, `JOB_ALREADY_RUNNING`, `RATE_LIMITED`, `AI_KEY_NOT_PERMITTED` and others. Timers only, no browser APIs.

## Ports

- `AuthPort`: `currentUser`, `signIn`, `signOut`, `getToken(forceRefresh)`, `onChange`. The app implements Firebase; `DevAuthPort` is for local dev (API must run with `AI_TEST_MODE=1`).
- `useImportExport()` (react): `{formats, importing, exporting, error, importScript, exportDocument}`; failures resolve `null` and set `error` (an `ApiError` with `code`/`details`). No `File`/`Blob` in the lib: the app reads the file and does the download.
- `OfflineDocStore`: `load/save/delete` of `{epoch, state (Yjs V2)}` per document id. The IndexedDB adapter is the app's job.
- `createScreenwriter` builds the `ScreenwriterClient` and one `SyncClient` (per instance = per device). `openDocumentSession` on it is reference counted: one live session per document, real close when every holder has called `close()` once.

## Session lifecycle (`openDocumentSession`)

1. `client.getDocument` (epoch, role, template summary). Network failure plus an offline copy = open offline from the copy.
2. New `Y.Doc`; apply the offline copy if its epoch equals the server epoch (older-epoch copies are dropped).
3. `sync.subscribe(id, doc, {epoch})`, wait for `synced` (timeout 10 s; with an offline copy it then opens anyway).
4. `openDocument(doc, deps, {repair: false})` (repair is a write; never on the client). `createSessionUndo` per session: `undo()/redo()` only touch this session's own origins.
5. `execute(commands, {kind, groupKey})` runs `executeBatch` with this user's origin (`origins.make`); viewers/commenters are read-only.
6. Every doc update schedules a debounced save to the offline store; `close()` flushes.
7. **Rebase** on the client's `epochChanged`: fetch `GET /documents/:did/state`; compare the old doc's state vector with (newest server `pre-open`/`pre-restore` snapshot vector + the new live state's vector); anything beyond both = lost local edits; save a copy in the offline store under `<docId>#lost@<epoch>@<ts>`; replace doc, model and undo; resubscribe at the live epoch; emit `change(null)` then `rebased {fromEpoch, toEpoch, lostLocalEdits, preservedKey}`. The client's `unackedCount` resets on disconnect, so it is NOT used for this. Undo history is cleared by a rebase. Read `session.model` fresh after `rebased`.
8. Presence: `setLocalCursor(x)` publishes `{user, cursor: x}` through awareness; `remoteCursors` is a map of `{clientId, user, cursor}`.
9. Snapshots: `listSnapshots`, `createSnapshot(name, note)` (waits for acks, generates `clientSnapshotId`), `openSnapshot(id)` (API call, then waits for this session's rebase), `forkSnapshot`, `listVersions`, `restoreVersion`.

## Single Yjs (important)

`yjs` and `lib0` resolve to `../writing_core/node_modules/` via a two-entry `paths` mapping (extensionless `dist/yjs` first so Bun loads `yjs.mjs`, then the directory for types). `vitest.config.ts` mirrors it as aliases; keep both in sync. An app bundler needs an alias plus `resolve.dedupe: ['yjs','lib0']`. The integration test asserts `session.model.doc instanceof Y.Doc` with the test's own import.

## Gotchas

- One `SyncClient` holds one subscription per document id: two sessions on one document need two `createScreenwriter` instances (that is what two devices are).
- The API's `createSnapshot` pins the server's live state; a client cannot upload its own state (see the offline-edits gap).
- `writing_core`'s command registry is a process-wide singleton; `registerBuiltinCommands()` is idempotent and is called on import of `session/`.
- React: `screenwriter_client`'s hooks import their own `react`; the app must dedupe `react`/`react-dom` (Vite `resolve.dedupe`).

## Related

`../writing_core`, `../screenwriter_client`, `../screenwriter_types`, `../screenwriter_api`, `../sudojo_lib` (convention reference), `../screenwriter_plans`.
