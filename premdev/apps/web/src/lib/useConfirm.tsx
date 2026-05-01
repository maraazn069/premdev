import { useCallback, useState } from "react";
import { ConfirmDialog, ConfirmOptions } from "@/components/ConfirmDialog";

export function useConfirm() {
  const [opts, setOpts] = useState<ConfirmOptions | null>(null);
  const [resolver, setResolver] = useState<((v: boolean) => void) | null>(null);

  const confirm = useCallback((options: ConfirmOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      setOpts(options);
      setResolver(() => resolve);
    });
  }, []);

  const dialog = (
    <ConfirmDialog
      open={!!opts}
      options={opts}
      onConfirm={() => {
        resolver?.(true);
        setOpts(null);
        setResolver(null);
      }}
      onCancel={() => {
        resolver?.(false);
        setOpts(null);
        setResolver(null);
      }}
    />
  );

  return { confirm, dialog };
}
