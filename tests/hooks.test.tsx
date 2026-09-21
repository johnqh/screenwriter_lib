// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import type { NetworkClient } from "@sudobility/screenwriter_client";
import { createScreenwriter, DevAuthPort, InMemoryOfflineDocStore, ScreenwriterProvider, useAuth, useProjects } from "../src";

const ok = (data: unknown) => ({
  status: 200,
  headers: {},
  body: new TextEncoder().encode(JSON.stringify({ success: true, data })),
});

const network: NetworkClient = {
  async request(req) {
    if (req.url.endsWith("/me")) return ok({ userId: "u", email: "a@b.co", personalWorkspaceId: "w1" });
    if (req.url.includes("/workspaces/w1/projects")) return ok({ items: [{ id: "prj_1", name: "One" }], nextCursor: null });
    return { status: 404, headers: {}, body: new TextEncoder().encode("{}") };
  },
};

describe("react hooks (fake network)", () => {
  it("useAuth + useProjects: sign in, then the project list loads", async () => {
    const sw = createScreenwriter({ network, baseUrl: "http://x", auth: new DevAuthPort(), offline: new InMemoryOfflineDocStore() });
    const wrapper = ({ children }: { children: ReactNode }) => <ScreenwriterProvider screenwriter={sw}>{children}</ScreenwriterProvider>;
    const { result } = renderHook(() => ({ auth: useAuth(), projects: useProjects() }), { wrapper });
    expect(result.current.auth.status).toBe("signedOut");
    await act(async () => {
      await result.current.auth.signIn("a@b.co");
    });
    await waitFor(() => expect(result.current.projects.projects.map(p => p.id)).toEqual(["prj_1"]));
    expect(result.current.auth.me?.personalWorkspaceId).toBe("w1");
    sw.dispose();
  });
});
