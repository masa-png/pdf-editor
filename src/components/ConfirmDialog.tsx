interface Props {
  open: boolean;
  busy: boolean;
  onSave: () => void;
  onDiscard: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({ open, busy, onSave, onDiscard, onCancel }: Props) {
  if (!open) return null;
  return <div className="modal-backdrop" role="presentation">
    <section className="modal" role="dialog" aria-modal="true" aria-labelledby="unsaved-title">
      <h2 id="unsaved-title">変更内容を保存しますか？</h2>
      <p>保存していない編集内容があります。</p>
      <div className="modal-actions">
        <button onClick={onCancel} disabled={busy}>キャンセル</button>
        <button className="danger-button" onClick={onDiscard} disabled={busy}>破棄</button>
        <button className="primary-button" onClick={onSave} disabled={busy}>保存</button>
      </div>
    </section>
  </div>;
}
