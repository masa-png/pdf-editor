interface Props {
  hasDocument: boolean;
  canUndo: boolean;
  canRedo: boolean;
  zoom: number;
  busy: boolean;
  onOpen: () => void;
  onSave: () => void;
  onSaveAs: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onZoom: (zoom: number) => void;
  onFit: () => void;
}

export function Toolbar(props: Props) {
  return <header className="toolbar">
    <div className="toolbar-group">
      <button onClick={props.onOpen} disabled={props.busy}>開く</button>
      <button onClick={props.onSave} disabled={!props.hasDocument || props.busy}>保存</button>
      <button onClick={props.onSaveAs} disabled={!props.hasDocument || props.busy}>別名保存</button>
    </div>
    <div className="toolbar-divider" />
    <div className="toolbar-group">
      <button className="icon-button" aria-label="元に戻す" title="元に戻す ⌘Z" onClick={props.onUndo} disabled={!props.canUndo || props.busy}>↶</button>
      <button className="icon-button" aria-label="やり直す" title="やり直す ⇧⌘Z" onClick={props.onRedo} disabled={!props.canRedo || props.busy}>↷</button>
    </div>
    <div className="toolbar-spacer" />
    <div className="toolbar-group zoom-group">
      <button className="icon-button" aria-label="縮小" onClick={() => props.onZoom(props.zoom - 10)} disabled={!props.hasDocument}>−</button>
      <button className="zoom-value" onClick={() => props.onZoom(100)} disabled={!props.hasDocument}>{props.zoom}%</button>
      <button className="icon-button" aria-label="拡大" onClick={() => props.onZoom(props.zoom + 10)} disabled={!props.hasDocument}>＋</button>
      <button onClick={props.onFit} disabled={!props.hasDocument}>幅に合わせる</button>
    </div>
  </header>;
}
