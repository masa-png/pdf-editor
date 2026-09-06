import type { PDFDocumentProxy } from "pdfjs-dist";

export interface NormalizedRect { x: number; y: number; width: number; height: number }

export interface TextSpan {
  spanId: string;
  pageIndex: number;
  text: string;
  rect: NormalizedRect;
  fontName: string;
  fontSizePt: number;
  color: string;
  editable: boolean;
  unsupportedReason?: string | null;
}

export interface PageAnalysis {
  pageIndex: number;
  widthPt: number;
  heightPt: number;
  rotation: number;
  spans: TextSpan[];
}

export interface DocumentAnalysis {
  pageCount: number;
  pages: PageAnalysis[];
  editableSpanCount: number;
  readOnly: boolean;
}

export interface DocumentSessionInfo { documentId: string; displayName: string; path: string }
export interface EditPatch { spanId: string; newText: string }
export interface ValidationResult { fits: boolean; widthPt: number; maxWidthPt: number }
export interface SaveResult { path: string; displayName: string }
export interface AppError { code: string; message: string; details?: unknown }
export interface LoadedDocument { session: DocumentSessionInfo; analysis: DocumentAnalysis; pdf: PDFDocumentProxy }
