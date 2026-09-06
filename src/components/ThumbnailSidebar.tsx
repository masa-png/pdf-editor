import { memo, useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy, RenderTask } from "pdfjs-dist";
import type { PageAnalysis } from "../types/pdf";

const Thumbnail = memo(function Thumbnail({ pdf, page, selected, onClick }: { pdf: PDFDocumentProxy; page: PageAnalysis; selected: boolean; onClick: () => void }) {
  const hostRef = useRef<HTMLButtonElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [active, setActive] = useState(false);
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const observer = new IntersectionObserver(([entry]) => { if (entry.isIntersecting) setActive(true); }, { rootMargin: "300px" });
    observer.observe(host);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!active || !canvasRef.current) return;
    let task: RenderTask | undefined;
    let disposed = false;
    void pdf.getPage(page.pageIndex + 1).then((pdfPage) => {
      if (disposed || !canvasRef.current) return;
      const initial = pdfPage.getViewport({ scale: 1 });
      const viewport = pdfPage.getViewport({ scale: 112 / initial.width });
      const canvas = canvasRef.current;
      canvas.width = Math.floor(viewport.width * 1.5);
      canvas.height = Math.floor(viewport.height * 1.5);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const context = canvas.getContext("2d");
      if (!context) return;
      task = pdfPage.render({ canvas, canvasContext: context, viewport, transform: [1.5, 0, 0, 1.5, 0, 0] });
      return task.promise;
    }).catch((error) => { if (error?.name !== "RenderingCancelledException") console.error(error); });
    return () => { disposed = true; task?.cancel(); };
  }, [active, page.pageIndex, pdf]);
  return <button ref={hostRef} className={`thumbnail ${selected ? "selected" : ""}`} onClick={onClick} aria-label={`ページ ${page.pageIndex + 1}へ移動`}>
    <div className="thumbnail-paper">{active ? <canvas ref={canvasRef} /> : null}</div>
    <span>{page.pageIndex + 1}</span>
  </button>;
});

export function ThumbnailSidebar({ pdf, pages, currentPage, onNavigate }: { pdf: PDFDocumentProxy; pages: PageAnalysis[]; currentPage: number; onNavigate: (pageIndex: number) => void }) {
  return <aside className="sidebar" aria-label="ページ一覧">
    {pages.map((page) => <Thumbnail key={page.pageIndex} pdf={pdf} page={page} selected={currentPage === page.pageIndex} onClick={() => onNavigate(page.pageIndex)} />)}
  </aside>;
}
