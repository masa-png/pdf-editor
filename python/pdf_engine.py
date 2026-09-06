import pymupdf
import sys


def analyze_pdf(file_path):
    doc = pymupdf.open(file_path)

    print(f"ページ数: {len(doc)}")

    for page_number, page in enumerate(doc):
        print(f"\n--- Page {page_number + 1} ---")

        text = page.get_text()

        print(text)


def main():
    if len(sys.argv) < 2:
        print("PDFファイルを指定してください")
        return

    analyze_pdf(sys.argv[1])


if __name__ == "__main__":
    main()