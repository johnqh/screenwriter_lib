import { describe, expect, it, vi } from "vitest";
import {
  createAuthStore,
  createDocumentsStore,
  createProjectsStore,
  createTemplatesStore,
  DevAuthPort,
  devUidForEmail,
  InMemoryOfflineDocStore,
  type DocumentsClient,
  type ProjectsClient,
} from "../src";

const project = (id: string) => ({ id, name: id }) as never;

describe("DevAuthPort", () => {
  it("produces dev:<uid>:<email> with a deterministic uid", async () => {
    const auth = new DevAuthPort();
    expect(await auth.getToken()).toBeNull();
    const seen: Array<string | null> = [];
    auth.onChange(u => seen.push(u?.email ?? null));
    const user = await auth.signIn("Ann@Example.com");
    expect(user.uid).toBe(devUidForEmail("ann@example.com"));
    expect(await auth.getToken()).toBe(`dev:${user.uid}:ann@example.com`);
    await auth.signOut();
    expect(await auth.getToken()).toBeNull();
    expect(seen).toEqual(["ann@example.com", null]);
    expect(devUidForEmail("a@b.co")).not.toBe(devUidForEmail("b@b.co"));
  });
});

describe("InMemoryOfflineDocStore", () => {
  it("saves, loads copies, deletes", async () => {
    const s = new InMemoryOfflineDocStore();
    expect(await s.load("d")).toBeNull();
    const state = new Uint8Array([1, 2, 3]);
    await s.save("d", { epoch: 2, state });
    state[0] = 9;
    expect(Array.from((await s.load("d"))!.state)).toEqual([1, 2, 3]);
    await s.delete("d");
    expect(await s.load("d")).toBeNull();
  });
});

describe("stores over a fake client", () => {
  it("auth store follows the port and loads me", async () => {
    const auth = new DevAuthPort();
    const client = { me: vi.fn(async () => ({ userId: "u", personalWorkspaceId: "w1" }) as never) };
    const { store, dispose } = createAuthStore(auth, client);
    expect(store.getState().status).toBe("signedOut");
    await store.getState().signIn("a@b.co");
    expect(store.getState().status).toBe("signedIn");
    await vi.waitFor(() => expect(store.getState().me?.personalWorkspaceId).toBe("w1"));
    await store.getState().signOut();
    expect(store.getState()).toMatchObject({ status: "signedOut", me: null });
    dispose();
  });

  it("projects: list, create, trash, restore, error", async () => {
    const client: ProjectsClient = {
      listProjects: vi.fn(async (_w, q) => ({ items: q?.trashed ? [project("t1")] : [project("p1")], nextCursor: null }) as never),
      createProject: vi.fn(async (_w, b) => project(b.name)),
      trashProject: vi.fn(async () => ({ trashedAt: "x" })),
      restoreProject: vi.fn(async () => project("t1")),
    };
    const store = createProjectsStore(client, async () => "w1");
    await store.getState().load();
    expect(store.getState().items.map(p => p.id)).toEqual(["p1"]);
    await store.getState().create({ name: "p2" });
    expect(store.getState().items.map(p => p.id)).toEqual(["p2", "p1"]);
    await store.getState().trash("p1");
    expect(store.getState().items.map(p => p.id)).toEqual(["p2"]);
    expect(client.createProject).toHaveBeenCalledWith("w1", { name: "p2" });
    await store.getState().load({ trashed: true });
    await store.getState().restore("t1");
    expect(store.getState().items).toEqual([]);
    (client.listProjects as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("boom"));
    await store.getState().load();
    expect(store.getState()).toMatchObject({ error: "boom", loading: false });
  });

  it("documents: create from a template sends a client doc id and the template", async () => {
    const client: DocumentsClient = {
      listDocuments: vi.fn(async () => ({ items: [], nextCursor: null }) as never),
      createDocument: vi.fn(async (_p, b) => ({ id: b.id, title: b.title }) as never),
      trashDocument: vi.fn(async () => ({ trashedAt: "x" })),
      restoreDocument: vi.fn(async () => ({}) as never),
    };
    const store = createDocumentsStore(client);
    const d = await store.getState().create("prj", { title: "Pilot", templateId: "tpl_1" });
    const arg = (client.createDocument as ReturnType<typeof vi.fn>).mock.calls[0]![1];
    expect(arg).toMatchObject({ title: "Pilot", kind: "script", templateId: "tpl_1" });
    expect(arg.id).toMatch(/^doc_/);
    expect(store.getState().byProject.prj!.items.map(x => x.id)).toEqual([d!.id]);
    await store.getState().trash("prj", d!.id);
    expect(store.getState().byProject.prj!.items).toEqual([]);
  });

  it("templates: load and error", async () => {
    const listTemplates = vi.fn(async () => [{ id: "t" }] as never);
    const store = createTemplatesStore({ listTemplates });
    await store.getState().load();
    expect(store.getState()).toMatchObject({ loaded: true, loading: false });
    listTemplates.mockRejectedValueOnce(new Error("nope"));
    await store.getState().load();
    expect(store.getState().error).toBe("nope");
  });
});
