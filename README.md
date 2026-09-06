# PDF Editor Desktop

macOS上でテキスト情報を持つPDFを開き、既存テキストをクリックして書き換えられるTauri 2アプリです。PDFは端末内だけで処理され、編集中の原本は変更されません。

## MVP機能

- PDF.jsによる連続ページ表示、サムネイル、25〜300%ズーム、幅合わせ
- PyMuPDFによる書式Span単位のテキスト解析・削除・再挿入
- 日本語対応（Noto Sans JP）、領域超過の保存前検証
- Undo / Redo、上書き保存、別名保存、未保存変更の確認
- ファイルダイアログとドラッグ＆ドロップ
- セッション原本と同一ディレクトリ一時出力を使った安全な保存

動作保証はApple Silicon搭載Mac・macOS 13以降です。縦書き、斜め文字、複数行、OCR、パスワード保護PDF、元フォントの完全再現はMVP対象外です。

## 開発環境

- Node.js 22以降
- Rust 1.92以降
- Python 3.14（arm64）

```bash
npm install
python3 -m venv python/.venv
python/.venv/bin/pip install -r python/requirements.txt
npm run build:sidecar
npm run tauri dev
```

`tauri dev`でも`python/.venv/bin/python`を使用します。Noto Sans JPは`assets/fonts`、OFL 1.1ライセンスは`assets/licenses`にあります。

## テストと配布ビルド

```bash
npm test
npm run build
npm run test:python
cargo test --manifest-path src-tauri/Cargo.toml
npm run build:sidecar
npm run tauri build
```

生成物は`src-tauri/target/release/bundle/macos/PDF Editor Desktop.app`です。署名・公証は行いません。

## 実装構成

- `src/`: React UI、PDF.js表示、編集履歴、Tauri IPCクライアント
- `src-tauri/`: 文書セッション、原本バックアップ、外部変更検出、原子的保存
- `python/`: JSON Lines常駐エンジン（`analyze` / `validate_edit` / `render`）
- `scripts/build-sidecar.sh`: PyInstallerによるarm64 sidecar生成

Pythonプロトコルでは標準入力へ1行1リクエストを送り、標準出力から同じ`requestId`を持つ応答を受け取ります。ログは標準エラーへ出力されます。
