/**
 * Runs against the REAL screenwriter_api (spawned under Bun): two devices of one user edit one document.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { createFetchNetworkClient } from "@sudobility/screenwriter_client";
import type { DocumentSession, RebasedEvent, Screenwriter } from "../src";
import { createScreenwriter, DevAuthPort, InMemoryOfflineDocStore } from "../src";
import { BASE, makeScreenwriter, startApi, stopApi, waitFor } from "./helpers";

const EMAIL = "lib-test@example.com";

const texts = (s: DocumentSession) => s.model.elements().map(e => e.text.plain);
const has = (s: DocumentSession, t: string) => texts(s).includes(t);
const insert = (s: DocumentSession, text: string) => {
  const style = s.model.stylesByRole("action")[0]!.id;
  const r = s.execute([{ id: "element.insert", params: { style, text } }]);
  expect(r.ok).toBe(true);
};
const same = (a: Y.Doc, b: Y.Doc) => Buffer.from(Y.encodeStateVector(a)).equals(Buffer.from(Y.encodeStateVector(b)));

let A: Screenwriter;
let B: Screenwriter;
let sa: DocumentSession;
let sb: DocumentSession;
let docId = "";
let projectId = "";
const offlineA = new InMemoryOfflineDocStore();
const offlineB = new InMemoryOfflineDocStore();
const rebasedA: RebasedEvent[] = [];
const rebasedB: RebasedEvent[] = [];

beforeAll(async () => {
  await startApi();
  A = await makeScreenwriter(EMAIL, offlineA);
  B = await makeScreenwriter(EMAIL, offlineB);
});

afterAll(async () => {
  await sa?.close();
  await sb?.close();
  A?.dispose();
  B?.dispose();
  await stopApi();
});

describe("stores against the real API", () => {
  it("projects, templates, documents from a template", async () => {
    const { stores } = A;
    await stores.templates.getState().load();
    const templates = stores.templates.getState().items;
    expect(templates.length).toBeGreaterThan(0);
    const tpl = templates.find(t => t.builtinKey === "screenplay-standard") ?? templates[0]!;

    const project = await stores.projects.getState().create({ name: `lib-test ${Date.now()}` });
    expect(project).not.toBeNull();
    projectId = project!.id;
    const doc = await stores.documents.getState().create(projectId, { title: "Pilot", templateId: tpl.id });
    expect(doc?.templateId).toBe(tpl.id);
    docId = doc!.id;
    expect(stores.documents.getState().byProject[projectId]!.items.map(d => d.id)).toContain(docId);

    // trash / restore round trip
    await stores.projects.getState().load();
    expect(stores.projects.getState().items.map(p => p.id)).toContain(projectId);
    const extra = await stores.projects.getState().create({ name: "to-trash" });
    await stores.projects.getState().trash(extra!.id);
    expect(stores.projects.getState().items.map(p => p.id)).not.toContain(extra!.id);
    await stores.projects.getState().load({ trashed: true });
    expect(stores.projects.getState().items.map(p => p.id)).toContain(extra!.id);
    await stores.projects.getState().restore(extra!.id);
    await stores.projects.getState().load();
    expect(stores.projects.getState().items.map(p => p.id)).toContain(extra!.id);
  });
});

describe("document sessions", () => {
  it("opens two sessions; an edit on A shows in B; undo is per user", async () => {
    sa = await A.openDocumentSession(docId);
    sb = await B.openDocumentSession(docId);
    sa.on("rebased", e => rebasedA.push(e));
    sb.on("rebased", e => rebasedB.push(e));
    expect(sa.syncStatus.state).toBe("synced");
    expect(sa.epoch).toBe(0);
    expect(sa.model.doc instanceof Y.Doc).toBe(true); // single Yjs instance across writing_core, client and lib

    insert(sa, "Hello from A");
    await waitFor("B sees A", () => has(sb, "Hello from A"));

    insert(sb, "Hello from B");
    await waitFor("A sees B", () => has(sa, "Hello from B"));

    // a text command on A, then undo it: only A's own edit is reverted
    const el = sa.model.elements().find(e => e.text.plain === "Hello from A")!;
    const r = sa.execute([{ id: "text.insert", params: { at: { elementId: el.id, offset: el.text.plain.length }, text: " (edited)" } }]);
    expect(r.ok).toBe(true);
    await waitFor("B sees text edit", () => has(sb, "Hello from A (edited)"));

    expect(sa.canUndo()).toBe(true);
    expect(sa.undo()).toBe(true);
    await waitFor("B sees text undo", () => has(sb, "Hello from A") && !has(sb, "Hello from A (edited)"));
    expect(has(sa, "Hello from B")).toBe(true);

    // A undoes its element insert; B's element is untouched on both sides
    expect(sa.undo()).toBe(true);
    await waitFor("A's element gone on B", () => !has(sb, "Hello from A"));
    expect(has(sa, "Hello from A")).toBe(false);
    expect(has(sa, "Hello from B")).toBe(true);
    expect(has(sb, "Hello from B")).toBe(true);
    // nothing of B's is on A's undo stack
    expect(sa.canUndo()).toBe(false);
    expect(sa.redo()).toBe(true);
    await waitFor("redo reaches B", () => has(sb, "Hello from A"));

    await waitFor("converged", () => same(sa.model.doc, sb.model.doc));
  });

  it("presence: B sees A's cursor", async () => {
    sa.setLocalCursor({ elementId: "el_x", offset: 3 });
    await waitFor("cursor", () => sb.remoteCursors.size === 1);
    const c = [...sb.remoteCursors.values()][0]!;
    expect(c.cursor).toEqual({ elementId: "el_x", offset: 3 });
    expect(c.user?.name).toBeTruthy();
  });

  it("snapshot, edit, openSnapshot: both sessions rebase onto the snapshot content", async () => {
    const snap = await sa.createSnapshot("S1", "before more edits");
    expect(snap.name).toBe("S1");
    expect((await sb.listSnapshots()).snapshots.map(s => s.id)).toContain(snap.id);

    insert(sa, "After snapshot");
    await waitFor("B sees it", () => has(sb, "After snapshot"));

    await sa.openSnapshot(snap.id);
    await waitFor("B rebased", () => rebasedB.length === 1 && sb.syncStatus.state === "synced");
    expect(rebasedA).toHaveLength(1);
    for (const s of [sa, sb]) {
      expect(s.epoch).toBe(1);
      expect(has(s, "After snapshot")).toBe(false);
      expect(has(s, "Hello from B")).toBe(true);
    }
    expect(rebasedA[0]).toMatchObject({ fromEpoch: 0, toEpoch: 1, lostLocalEdits: false });
    expect(rebasedB[0]).toMatchObject({ fromEpoch: 0, toEpoch: 1, lostLocalEdits: false });
    expect(sa.canUndo()).toBe(false); // undo history does not survive a rebase

    // still live after the rebase
    insert(sa, "post-rebase");
    await waitFor("B sees post-rebase", () => has(sb, "post-rebase"));
    insert(sb, "post-rebase B");
    await waitFor("A sees post-rebase B", () => has(sa, "post-rebase B"));
    await waitFor("converged", () => same(sa.model.doc, sb.model.doc));

    expect((await sa.listVersions()).items.length).toBeGreaterThan(0);
    const fork = await sa.forkSnapshot(snap.id, "Pilot (fork)");
    expect(fork.id).not.toBe(docId);
    expect(fork.parentSnapshotId).toBe(snap.id);
  });

  it("edits the server never saw are reported as lost (and kept) when the session rebases", async () => {
    const snaps = (await sa.listSnapshots()).snapshots.filter(s => s.name === "S1");
    B.sync.disconnect();
    await waitFor("B disconnected", () => B.sync.status === "disconnected");
    insert(sb, "made offline");
    await sa.openSnapshot(snaps[0]!.id); // epoch 1 -> 2 while B is away
    B.sync.connect().catch(() => undefined);
    await waitFor("B rebased again", () => rebasedB.length === 2 && sb.syncStatus.state === "synced", 15000);
    const ev = rebasedB[1]!;
    expect(ev).toMatchObject({ fromEpoch: 1, toEpoch: 2, lostLocalEdits: true });
    expect(ev.preservedKey).toBeTruthy();
    expect(offlineB.keys()).toContain(ev.preservedKey);
    expect(has(sb, "made offline")).toBe(false);
    // the preserved copy really holds the lost edit
    const kept = new Y.Doc();
    Y.applyUpdateV2(kept, (await offlineB.load(ev.preservedKey!))!.state);
    expect(JSON.stringify(kept.getMap("elements").toJSON())).toContain("made offline");
    await waitFor("A rebased", () => rebasedA.length === 2);
    expect(rebasedA[1]!.lostLocalEdits).toBe(false);
  });

  it("reopens from the in-memory offline store without the network", async () => {
    await sa.close();
    await sb.close();
    const store = new InMemoryOfflineDocStore();
    const c = await makeScreenwriter(EMAIL, store);
    const s1 = await c.openDocumentSession(docId);
    insert(s1, "kept locally");
    await waitFor("synced", () => s1.syncStatus.state === "synced");
    await s1.close(); // flushes
    c.dispose();
    expect((await store.load(docId))?.epoch).toBe(s1.epoch);

    // a device with no reachable server
    const dead = createScreenwriter({
      network: { request: async () => Promise.reject(new Error("offline")) },
      baseUrl: "http://localhost:1",
      auth: new DevAuthPort(),
      offline: store,
    });
    await dead.auth.signIn(EMAIL);
    const s2 = await dead.openDocumentSession(docId);
    expect(s2.detail).toBeNull();
    expect(has(s2, "kept locally")).toBe(true);
    expect(s2.syncStatus.state).toBe("syncing");
    // and it can still edit locally
    insert(s2, "typed offline");
    expect(has(s2, "typed offline")).toBe(true);
    await s2.close();
    dead.dispose();
  });
});
