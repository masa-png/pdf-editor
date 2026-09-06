mod commands;

use commands::pdf::{
    analyze_document, close_document, open_document, read_document_bytes, save_document,
    validate_edit, AppState,
};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState::new())
        .invoke_handler(tauri::generate_handler![
            open_document,
            analyze_document,
            read_document_bytes,
            validate_edit,
            save_document,
            close_document
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
