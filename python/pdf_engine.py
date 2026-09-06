"""Long-lived JSON-lines PDF analysis and editing engine."""

from __future__ import annotations

import json
import math
import os
import signal
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pymupdf

ACTION_TIMEOUTS = {"ping": 2, "validate_edit": 5, "analyze": 60, "render": 120}
EMBEDDED_FONT_NAME = "PDFEditorNotoJP"


def _timeout_handler(_signum: int, _frame: Any) -> None:
    raise EngineError("ENGINE_TIMEOUT", "PDF処理がタイムアウトしました。")


class EngineError(Exception):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None):
        super().__init__(message)
        self.code, self.message, self.details = code, message, details


@dataclass(frozen=True)
class Target:
    span_id: str
    page_index: int
    text: str
    bbox: tuple[float, float, float, float]
    origin: tuple[float, float]
    char_rects: tuple[tuple[float, float, float, float], ...]
    font_size: float
    font_name: str
    color: int
    editable: bool
    reason: str | None


def _normal_rect(bbox: tuple[float, ...], width: float, height: float) -> dict[str, float]:
    x0, y0, x1, y1 = bbox
    return {
        "x": max(0.0, min(1.0, x0 / width)) if width else 0.0,
        "y": max(0.0, min(1.0, y0 / height)) if height else 0.0,
        "width": max(0.0, min(1.0, (x1 - x0) / width)) if width else 0.0,
        "height": max(0.0, min(1.0, (y1 - y0) / height)) if height else 0.0,
    }


def _reason_for_span(text: str, line: dict[str, Any], span: dict[str, Any], bbox: tuple[float, ...], links: list[pymupdf.Rect]) -> str | None:
    if not text.strip():
        return "EMPTY_TEXT"
    if line.get("wmode", 0) != 0:
        return "VERTICAL_TEXT"
    direction = line.get("dir", (1.0, 0.0))
    if not math.isclose(direction[0], 1.0, abs_tol=0.001) or not math.isclose(direction[1], 0.0, abs_tol=0.001):
        return "ROTATED_TEXT"
    if span.get("alpha", 255) == 0:
        return "INVISIBLE_TEXT"
    if any(pymupdf.Rect(bbox).intersects(link) for link in links):
        return "LINKED_TEXT"
    return None


def _extract_targets(doc: pymupdf.Document) -> tuple[list[dict[str, Any]], dict[str, Target]]:
    pages: list[dict[str, Any]] = []
    targets: dict[str, Target] = {}
    for page_index, page in enumerate(doc):
        raw = page.get_text("rawdict", flags=pymupdf.TEXTFLAGS_RAWDICT)
        width, height = float(page.rect.width), float(page.rect.height)
        links = [pymupdf.Rect(link["from"]) for link in page.get_links() if link.get("from")]
        public_spans: list[dict[str, Any]] = []
        for block_index, block in enumerate(raw.get("blocks", [])):
            if block.get("type") != 0:
                continue
            for line_index, line in enumerate(block.get("lines", [])):
                for span_index, span in enumerate(line.get("spans", [])):
                    chars = span.get("chars", [])
                    text = "".join(char.get("c", "") for char in chars)
                    bbox = tuple(float(value) for value in span["bbox"])
                    origin = tuple(float(value) for value in span.get("origin", (bbox[0], bbox[3])))
                    char_rects = tuple(tuple(float(value) for value in char["bbox"]) for char in chars if char.get("c") and char.get("bbox"))
                    span_id = f"p{page_index}-b{block_index}-l{line_index}-s{span_index}"
                    reason = _reason_for_span(text, line, span, bbox, links)
                    target = Target(span_id, page_index, text, bbox, origin, char_rects, float(span.get("size", 11.0)), str(span.get("font", "Unknown")), int(span.get("color", 0)), reason is None and bool(char_rects), reason)
                    targets[span_id] = target
                    public_spans.append({
                        "spanId": span_id, "pageIndex": page_index, "text": text,
                        "rect": _normal_rect(bbox, width, height), "fontName": target.font_name,
                        "fontSizePt": target.font_size, "color": f"#{target.color:06x}",
                        "editable": target.editable, "unsupportedReason": target.reason,
                    })
        pages.append({"pageIndex": page_index, "widthPt": width, "heightPt": height, "rotation": int(page.rotation), "spans": public_spans})
    return pages, targets


def _open_document(path: str) -> pymupdf.Document:
    try:
        doc = pymupdf.open(path)
    except Exception as exc:
        raise EngineError("PDF_OPEN_FAILED", "PDFを開けませんでした。") from exc
    if doc.needs_pass:
        doc.close()
        raise EngineError("PASSWORD_PROTECTED", "パスワード保護されたPDFには対応していません。")
    if not doc.is_pdf:
        doc.close()
        raise EngineError("NOT_A_PDF", "選択されたファイルはPDFではありません。")
    return doc


def analyze(path: str) -> dict[str, Any]:
    doc = _open_document(path)
    try:
        pages, targets = _extract_targets(doc)
        editable_count = sum(target.editable for target in targets.values())
        return {"pageCount": len(doc), "pages": pages, "editableSpanCount": editable_count, "readOnly": editable_count == 0}
    finally:
        doc.close()


def _font_path(request: dict[str, Any]) -> str:
    candidates = [request.get("fontPath"), os.environ.get("PDF_EDITOR_FONT")]
    bundle_root = getattr(sys, "_MEIPASS", None)
    if bundle_root:
        candidates.append(str(Path(bundle_root) / "assets/fonts/NotoSansJP-Regular.ttf"))
    candidates.append(str(Path(__file__).resolve().parents[1] / "assets/fonts/NotoSansJP-Regular.ttf"))
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(candidate)
    raise EngineError("FONT_NOT_FOUND", "同梱フォント Noto Sans JP を読み込めません。")


def _targets_for(path: str) -> dict[str, Target]:
    doc = _open_document(path)
    try:
        return _extract_targets(doc)[1]
    finally:
        doc.close()


def _validate_text(target: Target, new_text: str, font_path: str) -> dict[str, Any]:
    if "\n" in new_text or "\r" in new_text:
        raise EngineError("MULTILINE_NOT_SUPPORTED", "MVPでは複数行の編集に対応していません。")
    if len(new_text) > 4096:
        raise EngineError("TEXT_TOO_LONG", "入力文字数が多すぎます。")
    font = pymupdf.Font(fontfile=font_path)
    missing = sorted({char for char in new_text if not char.isspace() and font.has_glyph(ord(char)) == 0})
    if missing:
        raise EngineError("UNSUPPORTED_GLYPH", "同梱フォントで表示できない文字が含まれています。", {"characters": missing[:10]})
    width = float(font.text_length(new_text, fontsize=target.font_size))
    maximum = max(0.0, target.bbox[2] - target.bbox[0])
    return {"fits": width <= maximum + 0.05, "widthPt": width, "maxWidthPt": maximum}


def validate_edit(request: dict[str, Any]) -> dict[str, Any]:
    target = _targets_for(request["path"]).get(request["spanId"])
    if target is None:
        raise EngineError("TARGET_NOT_FOUND", "編集対象が元PDF内に見つかりません。")
    if not target.editable:
        raise EngineError("TARGET_NOT_EDITABLE", "このテキストは安全に編集できません。", {"reason": target.reason})
    result = _validate_text(target, str(request.get("newText", "")), _font_path(request))
    if not result["fits"]:
        raise EngineError("TEXT_OVERFLOW", "文章が編集可能領域を超えています。", result)
    return result


def render(request: dict[str, Any]) -> dict[str, Any]:
    source, output = request["path"], request["outputPath"]
    edits = request.get("edits", [])
    if len({edit["spanId"] for edit in edits}) != len(edits):
        raise EngineError("DUPLICATE_EDIT", "同じ編集対象が複数指定されています。")
    font_path = _font_path(request)
    doc = _open_document(source)
    try:
        targets = _extract_targets(doc)[1]
        prepared: list[tuple[Target, str]] = []
        for edit in edits:
            target = targets.get(edit["spanId"])
            if target is None or not target.editable:
                raise EngineError("TARGET_NOT_FOUND", "保存時に編集対象を再確認できませんでした。")
            new_text = str(edit.get("newText", ""))
            validation = _validate_text(target, new_text, font_path)
            if not validation["fits"]:
                raise EngineError("TEXT_OVERFLOW", "文章が編集可能領域を超えています。", validation)
            prepared.append((target, new_text))
        by_page: dict[int, list[tuple[Target, str]]] = {}
        for item in prepared:
            by_page.setdefault(item[0].page_index, []).append(item)
        for page_index, page_edits in by_page.items():
            page = doc[page_index]
            for target, _ in page_edits:
                for rect in target.char_rects:
                    page.add_redact_annot(pymupdf.Rect(rect), fill=False, cross_out=False)
            page.apply_redactions(images=pymupdf.PDF_REDACT_IMAGE_NONE, graphics=pymupdf.PDF_REDACT_LINE_ART_NONE, text=pymupdf.PDF_REDACT_TEXT_REMOVE)
            page.insert_font(fontname=EMBEDDED_FONT_NAME, fontfile=font_path)
            for target, new_text in page_edits:
                if new_text:
                    color = (((target.color >> 16) & 255) / 255, ((target.color >> 8) & 255) / 255, (target.color & 255) / 255)
                    page.insert_text(pymupdf.Point(target.origin), new_text, fontname=EMBEDDED_FONT_NAME, fontsize=target.font_size, color=color, overlay=True)
        doc.save(output, garbage=4, deflate=True, clean=True)
    except Exception:
        Path(output).unlink(missing_ok=True)
        raise
    finally:
        doc.close()
    check = _open_document(output)
    try:
        return {"pageCount": len(check)}
    finally:
        check.close()


def dispatch(request: dict[str, Any]) -> dict[str, Any]:
    action = request.get("action")
    if action == "ping":
        return {"version": 1}
    if action == "analyze":
        return analyze(request["path"])
    if action == "validate_edit":
        return validate_edit(request)
    if action == "render":
        return render(request)
    raise EngineError("UNKNOWN_ACTION", f"未対応のアクションです: {action}")


def main() -> None:
    signal.signal(signal.SIGALRM, _timeout_handler)
    for line in sys.stdin:
        if not line.strip():
            continue
        request_id: Any = None
        try:
            request = json.loads(line)
            request_id = request.get("requestId")
            timeout = ACTION_TIMEOUTS.get(str(request.get("action")), 30)
            signal.setitimer(signal.ITIMER_REAL, timeout)
            try:
                result = dispatch(request)
            finally:
                signal.setitimer(signal.ITIMER_REAL, 0)
            response = {"requestId": request_id, "ok": True, "result": result}
        except EngineError as exc:
            response = {"requestId": request_id, "ok": False, "error": {"code": exc.code, "message": exc.message, "details": exc.details}}
        except Exception as exc:
            print(repr(exc), file=sys.stderr, flush=True)
            response = {"requestId": request_id, "ok": False, "error": {"code": "ENGINE_ERROR", "message": "PDFエンジンで予期しないエラーが発生しました。"}}
        print(json.dumps(response, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    main()
