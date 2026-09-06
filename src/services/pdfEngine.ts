import { invoke } from "@tauri-apps/api/core";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { DocumentAnalysis, DocumentSessionInfo, EditPatch, SaveResult, ValidationResult } from "../types/pdf";

export const openDocument = (path: string) => invoke<DocumentSessionInfo>("open_document", { path });
export const analyzeDocument = (documentId: string) => invoke<DocumentAnalysis>("analyze_document", { documentId });
export const readDocumentBytes = async (documentId: string): Promise<Uint8Array> => {
  const value = await invoke<Uint8Array | ArrayBuffer | number[]>("read_document_bytes", { documentId });
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return Uint8Array.from(value);
};
export const validateEdit = (documentId: string, spanId: string, newText: string) => invoke<ValidationResult>("validate_edit", { documentId, spanId, newText });
export const saveDocument = (documentId: string, edits: EditPatch[], destination?: string) => invoke<SaveResult>("save_document", { documentId, edits, destination: destination ?? null });
export const closeDocument = (documentId: string) => invoke<void>("close_document", { documentId });

let pdfModulePromise: Promise<typeof import("pdfjs-dist")> | undefined;

export async function loadPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  pdfModulePromise ??= Promise.all([
    import("pdfjs-dist"),
    import("pdfjs-dist/build/pdf.worker.min.mjs?url"),
  ]).then(([pdfjs, worker]) => {
    pdfjs.GlobalWorkerOptions.workerSrc = worker.default;
    return pdfjs;
  });
  const pdfjs = await pdfModulePromise;
  return pdfjs.getDocument({ data: bytes.slice() }).promise;
}

export function toAppError(error: unknown): { code: string; message: string } {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { code?: unknown; message?: unknown };
    if (typeof candidate.message === "string") return { code: typeof candidate.code === "string" ? candidate.code : "UNKNOWN", message: candidate.message };
  }
  return { code: "UNKNOWN", message: typeof error === "string" ? error : "予期しないエラーが発生しました。" };
}
