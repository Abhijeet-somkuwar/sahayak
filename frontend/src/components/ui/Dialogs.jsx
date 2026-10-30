import { Modal } from 'antd';

// For irreversible actions (skip, complete, cancel visit). tone 'danger' makes the confirm button red.
export function ConfirmDialog({ open, onClose, title, body, confirmLabel, cancelLabel, onConfirm, tone = 'primary', pending = false, children }) {
  return (
    <Modal
      open={open}
      onCancel={onClose}
      onOk={onConfirm}
      okText={confirmLabel}
      cancelText={cancelLabel}
      okButtonProps={{ danger: tone === 'danger', loading: pending }}
      title={title}
      centered
      destroyOnHidden
      modalRender={(node) => <div role="alertdialog">{node}</div>}
    >
      {body && <p className="text-soft">{body}</p>}
      {children}
    </Modal>
  );
}

// Plain panel with a title and custom content (forms).
export function Panel({ open, onClose, title, children, wide = false }) {
  return (
    <Modal open={open} onCancel={onClose} footer={null} title={title} centered destroyOnHidden width={wide ? 760 : 520}>
      {children}
    </Modal>
  );
}

// "?" overlay listing the keyboard shortcuts of the current screen.
export function ShortcutHelp({ open, onClose, title, shortcuts }) {
  return (
    <Panel open={open} onClose={onClose} title={title}>
      <dl style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '8px 16px', margin: 0 }}>
        {shortcuts.map((s) => (
          <div key={s.key + s.label} style={{ display: 'contents' }}>
            <dt>
              <kbd className="kbd" style={{ marginLeft: 0 }}>{s.key}</kbd>
            </dt>
            <dd style={{ margin: 0 }}>{s.label}</dd>
          </div>
        ))}
      </dl>
    </Panel>
  );
}
