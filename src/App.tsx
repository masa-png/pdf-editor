import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open, save } from "@tauri-apps/plugin-dialog";
import "./App.css";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { PdfViewer, type ActiveEditor } from "./components/PdfViewer";
import { ThumbnailSidebar } from "./components/ThumbnailSidebar";
import { Toolbar } from "./components/Toolbar";
import { useEditHistory } from "./hooks/useEditHistory";
import { analyzeDocument, closeDocument, loadPdf, openDocument, readDocumentBytes, saveDocument, toAppError, validateEdit } from "./services/pdfEngine";
import type { DocumentAnalysis, DocumentSessionInfo, TextSpan } from "./types/pdf";
import type { PDFDocumentProxy } from "pdfjs-dist";

type PendingAction = { type: "open"; path: string } | { type: "close" };
const ensurePdfExtension = (path: string) => path.toLowerCase().endsWith(".pdf") ? path : `${path}.pdf`;

function App() {
  const [session, setSession] = useState<DocumentSessionInfo | null>(null);
  const [analysis, setAnalysis] = useState<DocumentAnalysis | null>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [zoom, setZoomState] = useState(100);
  const [currentPage, setCurrentPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: "error" | "info"; text: string } | null>(null);
  const [editor, setEditor] = useState<ActiveEditor | null>(null);
  const [pending, setPending] = useState<PendingAction | null>(null);
  const history = useEditHistory();
  const dirtyRef = useRef(history.dirty);
  const sessionRef = useRef(session);
  const commitInFlight = useRef(false);
  dirtyRef.current = history.dirty;
  sessionRef.current = session;

  const originalText = useMemo(() => new Map(analysis?.pages.flatMap((page) => page.spans.map((span) => [span.spanId, span.text] as const)) ?? []), [analysis]);
  const effectivePatches = useMemo(() => history.patches.filter((patch) => originalText.get(patch.spanId) !== patch.newText), [history.patches, originalText]);
  const showError = useCallback((error: unknown) => setMessage({ kind: "error", text: toAppError(error).message }), []);
  const setZoom = useCallback((value: number) => setZoomState(Math.max(25, Math.min(300, Math.round(value)))), []);

  const loadPath = useCallback(async (path: string) => {
    setBusy(true); setMessage(null); setEditor(null);
    try {
      const nextSession = await openDocument(path);
      setPdf((previous) => { if (previous) void previous.cleanup(); return null; });
      setAnalysis(null);
      setSession(nextSession);
      const analysisPromise = analyzeDocument(nextSession.documentId);
      const pdfPromise = readDocumentBytes(nextSession.documentId).then(loadPdf);
      const [nextAnalysis, nextPdf] = await Promise.all([analysisPromise, pdfPromise]);
      setPdf(nextPdf);
      setAnalysis(nextAnalysis); setCurrentPage(0); setZoomState(100); history.reset();
      await getCurrentWindow().setTitle(`${nextSession.displayName} — PDF Editor Desktop`);
      if (nextAnalysis.readOnly) setMessage({ kind: "info", text: "編集可能なテキストがありません。画像PDFのOCRはMVP対象外です。" });
    } catch (error) { showError(error); }
    finally { setBusy(false); }
  }, [history.reset, showError]);

  const requestOpenPath = useCallback((path: string) => {
    if (dirtyRef.current) setPending({ type: "open", path }); else void loadPath(path);
  }, [loadPath]);
  const chooseAndOpen = useCallback(async () => {
    const selected = await open({ multiple: false, directory: false, filters: [{ name: "PDF", extensions: ["pdf"] }] });
    if (typeof selected === "string") requestOpenPath(selected);
  }, [requestOpenPath]);
  const performClose = useCallback(async () => {
    const active = sessionRef.current;
    if (active) await closeDocument(active.documentId).catch(() => undefined);
    await getCurrentWindow().destroy();
  }, []);
  const performPending = useCallback(async (action: PendingAction | null) => {
    setPending(null);
    if (!action) return;
    if (action.type === "close") await performClose(); else await loadPath(action.path);
  }, [loadPath, performClose]);

  const saveCurrent = useCallback(async (saveAs: boolean): Promise<boolean> => {
    if (!session) return false;
    setBusy(true); setMessage(null);
    try {
      let destination: string | undefined;
      if (saveAs) {
        const selected = await save({ defaultPath: session.displayName.replace(/\.pdf$/i, "-edited.pdf"), filters: [{ name: "PDF", extensions: ["pdf"] }] });
        if (!selected) return false;
        destination = ensurePdfExtension(selected);
      }
      const result = await saveDocument(session.documentId, effectivePatches, destination);
      setSession((current) => current ? { ...current, path: result.path, displayName: result.displayName } : current);
      history.markSaved();
      setMessage({ kind: "info", text: `${result.displayName} を保存しました。` });
      await getCurrentWindow().setTitle(`${result.displayName} — PDF Editor Desktop`);
      return true;
    } catch (error) { showError(error); return false; }
    finally { setBusy(false); }
  }, [effectivePatches, history.markSaved, session, showError]);

  const selectSpan = useCallback((span: TextSpan, currentText: string) => setEditor({ spanId: span.spanId, draft: currentText, validating: false }), []);
  const updateDraft = useCallback((draft: string) => setEditor((current) => current ? { ...current, draft, error: undefined } : current), []);
  const commitEditor = useCallback(async () => {
    if (!editor || editor.validating || !session || commitInFlight.current) return;
    commitInFlight.current = true;
    const active = editor;
    const before = history.current.get(active.spanId) ?? originalText.get(active.spanId) ?? "";
    if (active.draft === before) { setEditor(null); commitInFlight.current = false; return; }
    setEditor({ ...active, validating: true, error: undefined });
    try {
      await validateEdit(session.documentId, active.spanId, active.draft);
      history.commit(active.spanId, before, active.draft); setEditor(null);
    } catch (error) { setEditor({ ...active, validating: false, error: toAppError(error).message }); }
    finally { commitInFlight.current = false; }
  }, [editor, history, originalText, session]);

  const navigate = useCallback((pageIndex: number) => document.querySelector<HTMLElement>(`[data-page-index="${pageIndex}"]`)?.scrollIntoView({ behavior: "smooth", block: "start" }), []);
  const fitWidth = useCallback(() => { const page = analysis?.pages[0]; if (page) setZoom((window.innerWidth - 250) / page.widthPt * 100); }, [analysis, setZoom]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!event.metaKey) return;
      const key = event.key.toLowerCase();
      if (key === "s") { event.preventDefault(); void saveCurrent(event.shiftKey); }
      else if (key === "z" && event.shiftKey) { event.preventDefault(); history.redo(); }
      else if (key === "z") { event.preventDefault(); history.undo(); }
      else if (key === "o") { event.preventDefault(); void chooseAndOpen(); }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [chooseAndOpen, history.redo, history.undo, saveCurrent]);
  useEffect(() => {
    const unlisten = getCurrentWebviewWindow().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      if (event.payload.paths.length !== 1) { setMessage({ kind: "error", text: "PDFは1件だけドロップしてください。" }); return; }
      requestOpenPath(event.payload.paths[0]);
    });
    return () => { void unlisten.then((dispose) => dispose()); };
  }, [requestOpenPath]);
  useEffect(() => {
    const unlisten = getCurrentWindow().onCloseRequested((event) => {
      if (!sessionRef.current) return;
      event.preventDefault();
      if (dirtyRef.current) setPending({ type: "close" }); else void performClose();
    });
    return () => { void unlisten.then((dispose) => dispose()); };
  }, [performClose]);

  return (
    <main className="app-shell">
      <Toolbar hasDocument={Boolean(session)} canUndo={history.canUndo} canRedo={history.canRedo} zoom={zoom} busy={busy} onOpen={() => void chooseAndOpen()} onSave={() => void saveCurrent(false)} onSaveAs={() => void saveCurrent(true)} onUndo={history.undo} onRedo={history.redo} onZoom={setZoom} onFit={fitWidth} />
      <div className="workspace">
        {pdf && analysis ? <><ThumbnailSidebar pdf={pdf} pages={analysis.pages} currentPage={currentPage} onNavigate={navigate} /><PdfViewer pdf={pdf} pages={analysis.pages} zoom={zoom} edits={history.current} editor={editor} onSelect={selectSpan} onDraft={updateDraft} onCommit={() => void commitEditor()} onCancel={() => setEditor(null)} onCurrentPage={setCurrentPage} /></> :
          <section className={`empty-state ${busy ? "loading" : ""}`} onDoubleClick={() => void chooseAndOpen()}><div className="empty-icon">PDF</div><h1>{busy ? "PDFを読み込んでいます…" : "PDFを開いて編集"}</h1><p>ファイルをここへドラッグ＆ドロップするか、「PDFを選択」を押してください。</p><button className="primary-button" onClick={() => void chooseAndOpen()} disabled={busy}>PDFを選択</button></section>}
      </div>
      <footer className="statusbar"><span>{session?.displayName ?? "文書が開かれていません"}{history.dirty ? " — 未保存" : ""}</span><span>{analysis ? `ページ ${currentPage + 1} / ${analysis.pageCount}` : ""}</span><span>{analysis ? `ズーム ${zoom}%` : ""}</span></footer>
      {message ? <div className={`toast ${message.kind}`} role={message.kind === "error" ? "alert" : "status"}><span>{message.text}</span><button onClick={() => setMessage(null)} aria-label="閉じる">×</button></div> : null}
      {busy && session ? <div className="busy-indicator">処理中…</div> : null}
      <ConfirmDialog open={Boolean(pending)} busy={busy} onCancel={() => setPending(null)} onDiscard={() => void performPending(pending)} onSave={() => void saveCurrent(false).then((saved) => { if (saved) void performPending(pending); })} />
    </main>
  );
}

export default App;
