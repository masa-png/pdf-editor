import { memo, useEffect, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import type { PageAnalysis, TextSpan } from "../types/pdf";

export interface ActiveEditor {
  spanId: string;
  draft: string;
  error?: string;
  validating: boolean;
}

interface ViewerProps {
  pdf: PDFDocumentProxy;
  pages: PageAnalysis[];
  zoom: number;
  edits: Map<string, string>;
  editor: ActiveEditor | null;
  onSelect: (span: TextSpan, currentText: string) => void;
  onDraft: (value: string) => void;
  onCommit: () => void;
  onCancel: () => void;
  onCurrentPage: (pageIndex: number) => void;
}

interface PageProps extends Omit<ViewerProps, "pages" | "edits"> {
  page: PageAnalysis;
  pageEdits: Record<string, string>;
  editsKey: string;
}

function rectStyle(span: TextSpan): CSSProperties {
  return { left: `${span.rect.x * 100}%`, top: `${span.rect.y * 100}%`, width: `${span.rect.width * 100}%`, height: `${span.rect.height * 100}%` };
}

const PdfPage = memo(function PdfPage({ pdf, page, zoom, pageEdits, editor, onSelect, onDraft, onCommit, onCancel, onCurrentPage }: PageProps) {
  const hostRef = useRef<HTMLElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [active, setActive] = useState(false);
  const [dimensions, setDimensions] = useState({ width: page.widthPt * zoom / 100, height: page.heightPt * zoom / 100 });

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) setActive(true);
      if (entry.intersectionRatio >= 0.45) onCurrentPage(page.pageIndex);
    }, { rootMargin: "700px 0px", threshold: [0, 0.45] });
    observer.observe(host);
    return () => observer.disconnect();
  }, [onCurrentPage, page.pageIndex]);

  useEffect(() => {
    setDimensions({ width: page.widthPt * zoom / 100, height: page.heightPt * zoom / 100 });
  }, [page.heightPt, page.widthPt, zoom]);

  useEffect(() => {
    if (!active || !canvasRef.current) return;
    let disposed = false;
    let renderTask: RenderTask | undefined;
    void pdf.getPage(page.pageIndex + 1).then((pdfPage) => {
      if (disposed || !canvasRef.current) return;
      const viewport = pdfPage.getViewport({ scale: zoom / 100 });
      const ratio = window.devicePixelRatio || 1;
      const canvas = canvasRef.current;
      canvas.width = Math.floor(viewport.width * ratio);
      canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      setDimensions({ width: viewport.width, height: viewport.height });
      const context = canvas.getContext("2d");
      if (!context) return;
      renderTask = pdfPage.render({ canvas, canvasContext: context, viewport, transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0] });
      return renderTask.promise;
    }).catch((error) => {
      if (error?.name !== "RenderingCancelledException") console.error(error);
    });
    return () => { disposed = true; renderTask?.cancel(); };
  }, [active, page.pageIndex, pdf, zoom]);

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") { event.preventDefault(); onCancel(); }
  };

  return <section ref={hostRef} className="pdf-page" data-page-index={page.pageIndex} style={{ width: dimensions.width, height: dimensions.height }} aria-label={`ページ ${page.pageIndex + 1}`}>
    {active ? <canvas ref={canvasRef} /> : <div className="page-placeholder" />}
    {active ? <div className="text-overlay">
      {page.spans.map((span) => {
        const edited = pageEdits[span.spanId];
        const currentText = edited ?? span.text;
        const isEditing = editor?.spanId === span.spanId;
        return <div key={span.spanId}>
          {edited !== undefined && !isEditing ? <div className="edited-preview" style={{ ...rectStyle(span), color: span.color, fontSize: `${span.fontSizePt * zoom / 100}px` }}>{edited}</div> : null}
          {span.editable && !isEditing ? <button className="span-hitbox" style={rectStyle(span)} title={`${span.text}\nクリックして編集`} onClick={() => onSelect(span, currentText)} aria-label={`${span.text}を編集`} /> : null}
          {isEditing ? <form className="inline-editor" style={rectStyle(span)} onSubmit={(event) => { event.preventDefault(); onCommit(); }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) onCommit(); }}>
            <input autoFocus value={editor.draft} onChange={(event) => onDraft(event.currentTarget.value)} onKeyDown={handleKeyDown} disabled={editor.validating} aria-invalid={Boolean(editor.error)} />
            <button type="submit" className="editor-confirm" disabled={editor.validating} aria-label="編集を確定">✓</button>
            {editor.error ? <p className="editor-error">{editor.error}</p> : null}
          </form> : null}
        </div>;
      })}
    </div> : null}
    <span className="page-number">{page.pageIndex + 1}</span>
  </section>;
}, (before, after) => before.pdf === after.pdf && before.page === after.page && before.zoom === after.zoom && before.editsKey === after.editsKey && before.editor === after.editor);

export function PdfViewer(props: ViewerProps) {
  return <div className="viewer-scroll" id="pdf-viewer">
    <div className="pages-stack">
      {props.pages.map((page) => {
        const entries = page.spans.flatMap((span) => props.edits.has(span.spanId) ? [[span.spanId, props.edits.get(span.spanId)!] as const] : []);
        const pageEdits = Object.fromEntries(entries);
        return <PdfPage key={page.pageIndex} {...props} page={page} pageEdits={pageEdits} editsKey={JSON.stringify(entries)} />;
      })}
    </div>
  </div>;
}
