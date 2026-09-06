from pathlib import Path

import pymupdf
import pytest

import pdf_engine


@pytest.fixture()
def font_path() -> str:
    path = Path(__file__).parents[2] / "assets/fonts/NotoSansJP-Regular.ttf"
    if not path.exists():
        pytest.skip("Noto Sans JP test font has not been downloaded")
    return str(path)


@pytest.fixture()
def sample_pdf(tmp_path: Path, font_path: str) -> Path:
    path = tmp_path / "sample.pdf"
    doc = pymupdf.open()
    page = doc.new_page(width=400, height=300)
    page.insert_font(fontname="NotoSansJP", fontfile=font_path)
    page.insert_text((50, 80), "契約日は2026年4月1日です。", fontname="NotoSansJP", fontsize=12)
    doc.save(path)
    doc.close()
    return path


def test_analyze_and_render(sample_pdf: Path, font_path: str, tmp_path: Path) -> None:
    analysis = pdf_engine.analyze(str(sample_pdf))
    assert analysis["pageCount"] == 1
    span = analysis["pages"][0]["spans"][0]
    assert span["editable"]
    output = tmp_path / "output.pdf"
    replacement = "契約日は2027年4月1日です。"
    request = {"path": str(sample_pdf), "spanId": span["spanId"], "newText": replacement, "fontPath": font_path}
    assert pdf_engine.validate_edit(request)["fits"]
    pdf_engine.render({"path": str(sample_pdf), "outputPath": str(output), "fontPath": font_path, "edits": [{"spanId": span["spanId"], "newText": replacement}]})
    doc = pymupdf.open(output)
    text = "".join(page.get_text() for page in doc)
    doc.close()
    assert "2027" in text
    assert "2026" not in text


def test_overflow_is_rejected(sample_pdf: Path, font_path: str) -> None:
    span = pdf_engine.analyze(str(sample_pdf))["pages"][0]["spans"][0]
    with pytest.raises(pdf_engine.EngineError) as error:
        pdf_engine.validate_edit({"path": str(sample_pdf), "spanId": span["spanId"], "newText": "非常に長い文章" * 100, "fontPath": font_path})
    assert error.value.code == "TEXT_OVERFLOW"


def test_empty_replacement_deletes_text(sample_pdf: Path, font_path: str, tmp_path: Path) -> None:
    span = pdf_engine.analyze(str(sample_pdf))["pages"][0]["spans"][0]
    output = tmp_path / "deleted.pdf"
    pdf_engine.render({"path": str(sample_pdf), "outputPath": str(output), "fontPath": font_path, "edits": [{"spanId": span["spanId"], "newText": ""}]})
    doc = pymupdf.open(output)
    assert "2026" not in doc[0].get_text()
    doc.close()


def test_empty_pdf_opens_read_only(tmp_path: Path) -> None:
    path = tmp_path / "image-only.pdf"
    doc = pymupdf.open()
    doc.new_page()
    doc.save(path)
    doc.close()
    result = pdf_engine.analyze(str(path))
    assert result["readOnly"]
    assert result["editableSpanCount"] == 0


def test_linked_text_is_not_editable(tmp_path: Path) -> None:
    path = tmp_path / "linked.pdf"
    doc = pymupdf.open()
    page = doc.new_page()
    page.insert_text((72, 72), "Linked text")
    page.insert_link({"kind": pymupdf.LINK_URI, "from": page.search_for("Linked text")[0], "uri": "https://example.com"})
    doc.save(path)
    doc.close()
    span = pdf_engine.analyze(str(path))["pages"][0]["spans"][0]
    assert not span["editable"]
    assert span["unsupportedReason"] == "LINKED_TEXT"


def test_password_protected_pdf_is_rejected(tmp_path: Path) -> None:
    path = tmp_path / "protected.pdf"
    doc = pymupdf.open()
    doc.new_page()
    doc.save(path, encryption=pymupdf.PDF_ENCRYPT_AES_256, owner_pw="owner", user_pw="secret")
    doc.close()
    with pytest.raises(pdf_engine.EngineError) as error:
        pdf_engine.analyze(str(path))
    assert error.value.code == "PASSWORD_PROTECTED"
