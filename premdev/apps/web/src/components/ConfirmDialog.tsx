import { useEffect } from "react";
import { AlertTriangle, X } from "lucide-react";

export type ConfirmOptions = {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
};

export function ConfirmDialog({
  open,
  options,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  options: ConfirmOptions | null;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onCancel();
      if (e.key === "Enter") onConfirm();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onConfirm, onCancel]);

  if (!open || !options) return null;
  const danger = options.danger !== false;
  return (
    <div
      className="fixed inset-0 z-[100] grid place-items-center bg-black/60 p-4"
      onClick={onCancel}
    >
      <div
        className="card w-full max-w-md p-5"
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="mb-3 flex items-start gap-3">
          {danger && (
            <div className="rounded-md bg-danger/15 p-2 text-danger">
              <AlertTriangle size={18} />
            </div>
          )}
          <div className="flex-1">
            <div className="text-base font-semibold">
              {options.title ?? "Confirm action"}
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm text-text-muted">
              {options.message}
            </p>
          </div>
          <button className="btn-ghost p-1" onClick={onCancel} aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button className="btn-secondary" onClick={onCancel}>
            {options.cancelLabel ?? "Cancel"}
          </button>
          <button
            className={danger ? "btn-danger" : "btn-primary"}
            onClick={onConfirm}
            autoFocus
          >
            {options.confirmLabel ?? "Confirm"}
          </button>
        </div>
      </div>
    </div>
  );
}
