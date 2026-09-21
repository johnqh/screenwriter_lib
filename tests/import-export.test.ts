/** Import/export flows against the REAL API: bytes in, document out; a just-typed edit shows up in the export. */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Screenwriter } from "../src";
import { makeScreenwriter, startApi, stopApi } from "./helpers";

const FOUNTAIN = "Title: Lib Test\n\nINT. KITCHEN - DAY\n\nJane stirs the pot.\n\nJANE\nIt needs salt.\n";
let A: Screenwriter;

beforeAll(async () => {
  await startApi();
  A = await makeScreenwriter("lib-import@example.com");
});
afterAll(async () => {
  A?.dispose();
  await stopApi();
});

describe("import/export flows", () => {
  it("imports bytes into the documents store, exports live edits", async () => {
    const project = await A.stores.projects.getState().create({ name: "Imports" });
    expect(project).toBeTruthy();
    const pid = project!.id;
    const formats = await A.importExport.formats();
    expect(formats.some(f => f.id === "fountain" && f.canImport && f.canExport)).toBe(true);

    const out = await A.importExport.importScript(pid, { filename: "s.fountain", bytes: new TextEncoder().encode(FOUNTAIN) });
    expect(out.format).toBe("fountain");
    expect(out.report.summary).toBeDefined();
    expect(A.stores.documents.getState().byProject[pid]?.items.map(d => d.id)).toContain(out.document.id);

    const session = await A.openDocumentSession(out.document.id);
    const style = session.model.stylesByRole("action")[0]!.id;
    session.execute([{ id: "element.insert", params: { style, text: "Typed a moment ago." } }]);
    const ex = await A.importExport.exportDocument(out.document.id, "fountain");
    expect(ex.filename.endsWith(".fountain")).toBe(true);
    expect(new TextDecoder().decode(ex.bytes)).toContain("Typed a moment ago.");
    await session.close();
  });
});
