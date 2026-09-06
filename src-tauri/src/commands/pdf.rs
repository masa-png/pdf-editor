use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::UNIX_EPOCH,
};
use tauri::{ipc::Response, State};
use uuid::Uuid;

#[derive(Debug, Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct AppError {
    code: String,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    details: Option<Value>,
}

impl AppError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            details: None,
        }
    }

    fn engine(value: &Value) -> Self {
        Self {
            code: value
                .get("code")
                .and_then(Value::as_str)
                .unwrap_or("ENGINE_ERROR")
                .into(),
            message: value
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("PDFエンジンでエラーが発生しました。")
                .into(),
            details: value.get("details").cloned(),
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(error: std::io::Error) -> Self {
        Self::new("IO_ERROR", error.to_string())
    }
}

#[derive(Clone)]
struct Fingerprint {
    len: u64,
    modified_nanos: u128,
}

impl Fingerprint {
    fn read(path: &Path) -> Result<Self, AppError> {
        let metadata = fs::metadata(path)?;
        let modified_nanos = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_nanos())
            .unwrap_or_default();
        Ok(Self {
            len: metadata.len(),
            modified_nanos,
        })
    }
    fn matches(&self, path: &Path) -> bool {
        Self::read(path)
            .map(|other| self.len == other.len && self.modified_nanos == other.modified_nanos)
            .unwrap_or(false)
    }
}

#[derive(Clone)]
struct DocumentSession {
    id: String,
    display_name: String,
    current_path: PathBuf,
    baseline_path: PathBuf,
    session_dir: PathBuf,
    fingerprint: Fingerprint,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocumentSessionInfo {
    document_id: String,
    display_name: String,
    path: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditPatch {
    span_id: String,
    new_text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveResult {
    path: String,
    display_name: String,
}

struct EngineProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
}

impl Drop for EngineProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

struct EngineClient {
    process: Mutex<Option<EngineProcess>>,
    next_id: AtomicU64,
}

impl EngineClient {
    fn new() -> Self {
        Self {
            process: Mutex::new(None),
            next_id: AtomicU64::new(1),
        }
    }

    fn spawn() -> Result<EngineProcess, AppError> {
        let mut command = if cfg!(debug_assertions) {
            let root = Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .expect("workspace root");
            let venv_python = root.join("python/.venv/bin/python");
            let mut command = Command::new(if venv_python.exists() {
                venv_python
            } else {
                PathBuf::from("python3")
            });
            command.arg(root.join("python/pdf_engine.py"));
            command
        } else {
            let executable_dir = std::env::current_exe()?
                .parent()
                .ok_or_else(|| {
                    AppError::new(
                        "ENGINE_NOT_FOUND",
                        "アプリの実行ディレクトリを確認できません。",
                    )
                })?
                .to_path_buf();
            Command::new(executable_dir.join("pdf-engine"))
        };
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| {
                AppError::new(
                    "ENGINE_START_FAILED",
                    format!("PDFエンジンを起動できません: {error}"),
                )
            })?;
        let stdin = child.stdin.take().ok_or_else(|| {
            AppError::new("ENGINE_START_FAILED", "PDFエンジンのstdinを開けません。")
        })?;
        let stdout = BufReader::new(child.stdout.take().ok_or_else(|| {
            AppError::new("ENGINE_START_FAILED", "PDFエンジンのstdoutを開けません。")
        })?);
        Ok(EngineProcess {
            child,
            stdin,
            stdout,
        })
    }

    fn call(&self, mut request: Value) -> Result<Value, AppError> {
        let request_id = self.next_id.fetch_add(1, Ordering::Relaxed);
        request["requestId"] = json!(request_id);
        let mut guard = self
            .process
            .lock()
            .map_err(|_| AppError::new("ENGINE_LOCK_FAILED", "PDFエンジンを利用できません。"))?;
        if guard.is_none() {
            *guard = Some(Self::spawn()?);
        }
        let process = guard.as_mut().expect("engine process");
        let encoded = serde_json::to_string(&request)
            .map_err(|error| AppError::new("ENGINE_REQUEST_FAILED", error.to_string()))?;
        writeln!(process.stdin, "{encoded}")?;
        process.stdin.flush()?;
        let mut line = String::new();
        if process.stdout.read_line(&mut line)? == 0 {
            *guard = None;
            return Err(AppError::new(
                "ENGINE_EXITED",
                "PDFエンジンが異常終了しました。再度操作してください。",
            ));
        }
        let response: Value = serde_json::from_str(&line)
            .map_err(|error| AppError::new("ENGINE_RESPONSE_FAILED", error.to_string()))?;
        if response.get("requestId").and_then(Value::as_u64) != Some(request_id) {
            return Err(AppError::new(
                "ENGINE_RESPONSE_MISMATCH",
                "PDFエンジンの応答を確認できません。",
            ));
        }
        if response.get("ok").and_then(Value::as_bool) == Some(true) {
            Ok(response.get("result").cloned().unwrap_or(Value::Null))
        } else {
            Err(AppError::engine(
                response.get("error").unwrap_or(&Value::Null),
            ))
        }
    }
}

pub struct AppState {
    session: Mutex<Option<DocumentSession>>,
    engine: EngineClient,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            session: Mutex::new(None),
            engine: EngineClient::new(),
        }
    }
    fn session(&self, id: &str) -> Result<DocumentSession, AppError> {
        let guard = self.session.lock().map_err(|_| {
            AppError::new("SESSION_LOCK_FAILED", "文書セッションを利用できません。")
        })?;
        guard
            .as_ref()
            .filter(|session| session.id == id)
            .cloned()
            .ok_or_else(|| AppError::new("SESSION_NOT_FOUND", "文書セッションが見つかりません。"))
    }
}

fn validate_pdf_path(path: &Path, must_exist: bool) -> Result<(), AppError> {
    if path
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| value.eq_ignore_ascii_case("pdf"))
        != Some(true)
    {
        return Err(AppError::new(
            "NOT_A_PDF",
            "PDFファイルを選択してください。",
        ));
    }
    if must_exist {
        let mut header = [0_u8; 5];
        fs::File::open(path)?.read_exact(&mut header)?;
        if &header != b"%PDF-" {
            return Err(AppError::new("NOT_A_PDF", "PDFヘッダーを確認できません。"));
        }
    }
    Ok(())
}

fn font_path() -> Option<String> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .join("assets/fonts/NotoSansJP-Regular.ttf");
    path.exists().then(|| path.to_string_lossy().into_owned())
}

fn engine_request(action: &str, session: &DocumentSession) -> Value {
    let mut value = json!({"action": action, "path": session.baseline_path});
    if let Some(path) = font_path() {
        value["fontPath"] = json!(path);
    }
    value
}

#[tauri::command(async)]
pub fn open_document(
    path: String,
    state: State<'_, AppState>,
) -> Result<DocumentSessionInfo, AppError> {
    let source = PathBuf::from(path).canonicalize()?;
    validate_pdf_path(&source, true)?;
    let id = Uuid::new_v4().to_string();
    let session_dir = std::env::temp_dir().join("pdf-editor").join(&id);
    fs::create_dir_all(&session_dir)?;
    let baseline_path = session_dir.join("original.pdf");
    if let Err(error) = fs::copy(&source, &baseline_path) {
        let _ = fs::remove_dir_all(&session_dir);
        return Err(error.into());
    }
    let display_name = source
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("document.pdf")
        .to_string();
    let session = DocumentSession {
        id: id.clone(),
        display_name: display_name.clone(),
        current_path: source.clone(),
        baseline_path,
        session_dir,
        fingerprint: Fingerprint::read(&source)?,
    };
    let mut guard = state
        .session
        .lock()
        .map_err(|_| AppError::new("SESSION_LOCK_FAILED", "文書セッションを開始できません。"))?;
    if let Some(previous) = guard.replace(session) {
        let _ = fs::remove_dir_all(previous.session_dir);
    }
    Ok(DocumentSessionInfo {
        document_id: id,
        display_name,
        path: source.to_string_lossy().into_owned(),
    })
}

#[tauri::command(async)]
pub fn analyze_document(
    document_id: String,
    state: State<'_, AppState>,
) -> Result<Value, AppError> {
    let session = state.session(&document_id)?;
    state.engine.call(engine_request("analyze", &session))
}

#[tauri::command(async)]
pub fn read_document_bytes(
    document_id: String,
    state: State<'_, AppState>,
) -> Result<Response, AppError> {
    Ok(Response::new(fs::read(
        state.session(&document_id)?.baseline_path,
    )?))
}

#[tauri::command(async)]
pub fn validate_edit(
    document_id: String,
    span_id: String,
    new_text: String,
    state: State<'_, AppState>,
) -> Result<Value, AppError> {
    let session = state.session(&document_id)?;
    let mut request = engine_request("validate_edit", &session);
    request["spanId"] = json!(span_id);
    request["newText"] = json!(new_text);
    state.engine.call(request)
}

#[tauri::command(async)]
pub fn save_document(
    document_id: String,
    edits: Vec<EditPatch>,
    destination: Option<String>,
    state: State<'_, AppState>,
) -> Result<SaveResult, AppError> {
    let session = state.session(&document_id)?;
    let destination_path = destination
        .map(PathBuf::from)
        .unwrap_or_else(|| session.current_path.clone());
    validate_pdf_path(&destination_path, false)?;
    if destination_path == session.current_path
        && !session.fingerprint.matches(&session.current_path)
    {
        return Err(AppError::new(
            "SOURCE_CHANGED",
            "PDFが別のアプリで変更されています。別名で保存してください。",
        ));
    }
    let parent = destination_path
        .parent()
        .ok_or_else(|| AppError::new("SAVE_PATH_INVALID", "保存先を確認できません。"))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".pdf-editor-{}.pdf", Uuid::new_v4()));
    let mut request = engine_request("render", &session);
    request["outputPath"] = json!(temporary);
    request["edits"] = serde_json::to_value(edits)
        .map_err(|error| AppError::new("SAVE_REQUEST_FAILED", error.to_string()))?;
    if let Err(error) = state.engine.call(request) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    fs::rename(&temporary, &destination_path)?;
    let display_name = destination_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("document.pdf")
        .to_string();
    let fingerprint = Fingerprint::read(&destination_path)?;
    let mut guard = state
        .session
        .lock()
        .map_err(|_| AppError::new("SESSION_LOCK_FAILED", "保存状態を更新できません。"))?;
    if let Some(active) = guard.as_mut().filter(|active| active.id == document_id) {
        active.current_path = destination_path.clone();
        active.display_name = display_name.clone();
        active.fingerprint = fingerprint;
    }
    Ok(SaveResult {
        path: destination_path.to_string_lossy().into_owned(),
        display_name,
    })
}

#[tauri::command(async)]
pub fn close_document(document_id: String, state: State<'_, AppState>) -> Result<(), AppError> {
    let mut guard = state
        .session
        .lock()
        .map_err(|_| AppError::new("SESSION_LOCK_FAILED", "文書セッションを終了できません。"))?;
    if let Some(session) = guard.take() {
        if session.id != document_id {
            *guard = Some(session);
            return Err(AppError::new(
                "SESSION_NOT_FOUND",
                "文書セッションが見つかりません。",
            ));
        }
        fs::remove_dir_all(session.session_dir)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pdf_extension_is_case_insensitive() {
        assert!(validate_pdf_path(Path::new("sample.PDF"), false).is_ok());
        assert!(validate_pdf_path(Path::new("sample.txt"), false).is_err());
    }

    #[test]
    fn fingerprint_detects_external_changes() {
        let directory = std::env::temp_dir().join(format!("pdf-editor-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join("sample.pdf");
        fs::write(&path, b"%PDF-one").unwrap();
        let fingerprint = Fingerprint::read(&path).unwrap();
        fs::write(&path, b"%PDF-a-different-size").unwrap();
        assert!(!fingerprint.matches(&path));
        fs::remove_dir_all(directory).unwrap();
    }
}
