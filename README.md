# @sudobility/screenwriter_lib

Business logic for the Fadewright screenwriting app: ports (auth, offline store), zustand stores, a `DocumentSession` (writing_core model, per-user undo, presence, offline persistence, epoch rebase, snapshot flows) and thin React hooks. No UI. Local package (not published); import it by path.

## Usage

```ts
import { createFetchNetworkClient } from "@sudobility/screenwriter_client";
import { createScreenwriter, DevAuthPort, InMemoryOfflineDocStore, ScreenwriterProvider, useDocumentSession } from "@sudobility/screenwriter_lib";

const sw = createScreenwriter({
  network: createFetchNetworkClient(),
  baseUrl: "http://localhost:8042",
  auth: new DevAuthPort(),              // dev token dev:<uid>:<email>; needs the API with AI_TEST_MODE=1
  offline: new InMemoryOfflineDocStore(), // the app supplies an IndexedDB adapter
});
await sw.stores.auth.getState().signIn("me@example.com");

const session = await sw.openDocumentSession(documentId);
session.execute([{ id: "element.insert", params: { style, text: "INT. KITCHEN - DAY" } }]);
session.undo();                       // only this user's own edits
session.on("rebased", e => { /* epoch changed; re-read session.model */ });
await session.close();
```

React: wrap the tree in `<ScreenwriterProvider screenwriter={sw}>`, then `useAuth`, `useProjects`, `useDocuments(projectId)`, `useTemplates`, `useDocumentSession(documentId)`.

## API summary

- Ports: `AuthPort`, `OfflineDocStore`, `InMemoryOfflineDocStore`, `DevAuthPort`.
- Stores (vanilla zustand, on `sw.stores`): auth, projects, documents, templates.
- `DocumentSession`: `model`, `execute`, `undo/redo`, `subscribe`, `on(status|presence|rebased|error)`, `syncStatus`, `setLocalCursor`, `remoteCursors`, snapshot and version methods, `close`.

## Development

```
bun install
bun run typecheck
bunx vitest run     # spawns the real screenwriter_api against the local screenwriter_test database
```

## License

BUSL-1.1
