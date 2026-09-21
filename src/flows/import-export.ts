import type {
  ConversionReport,
  DocumentImportRequest,
  DocumentMeta,
  ExportFormatId,
  FormatInfo,
} from "@sudobility/screenwriter_types";
import type { ExportedDocument, ImportDocumentInput, ScreenwriterClient } from "@sudobility/screenwriter_client";

/** Bytes in, bytes out: no `File`, `Blob` or `URL` here. The app picks the file and triggers the download. */
export interface ImportScriptInput extends Omit<DocumentImportRequest, "contentB64" | "id"> {
  bytes: Uint8Array | ArrayBuffer;
}

export interface ImportOutcome {
  document: DocumentMeta;
  report: ConversionReport;
  /** Detected source format id. */
  format: string;
}

export interface ExportOutcome extends ExportedDocument {
  /** The report has warn/loss/error entries the writer must see before the file is used. */
  hasLoss: boolean;
}

export type ImportExportClient = Pick<ScreenwriterClient, "importDocument" | "exportDocument" | "getFormats">;

export interface ImportExportFlow {
  formats(): Promise<FormatInfo[]>;
  /** Upload a script into the project as a new document (idempotent per call: the id is generated here). */
  importScript(projectId: string, input: ImportScriptInput): Promise<ImportOutcome>;
  /** Export the live document. Waits for this device's pending edits to reach the server first. */
  exportDocument(documentId: string, format: ExportFormatId): Promise<ExportOutcome>;
}

export interface ImportExportHooks {
  /** Called with the new document after a successful import (the documents store adds it). */
  onImported?(projectId: string, document: DocumentMeta): void;
  /** Called before an export so an open session can flush its unacknowledged edits. */
  beforeExport?(documentId: string): Promise<void>;
  newDocumentId(): string;
}

export function createImportExportFlow(client: ImportExportClient, hooks: ImportExportHooks): ImportExportFlow {
  return {
    formats: () => client.getFormats(),
    async importScript(projectId, input) {
      const { bytes, ...rest } = input;
      const req: ImportDocumentInput = { ...rest, id: hooks.newDocumentId(), bytes };
      const res = await client.importDocument(projectId, req);
      hooks.onImported?.(projectId, res.document);
      return res;
    },
    async exportDocument(documentId, format) {
      await hooks.beforeExport?.(documentId).catch(() => undefined);
      const res = await client.exportDocument(documentId, format);
      const s = res.report.summary;
      return { ...res, hasLoss: s.warn + s.loss + s.error > 0 };
    },
  };
}
