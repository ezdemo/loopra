import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Button, Modal, ModalBody, ModalContent, ModalFooter, ModalHeader, Spinner } from '@nextui-org/react';
import type { LoopraClient } from '../backend';

export function useRemote<T>(api: LoopraClient, path: string | null, revision = 0, keepData = false) {
  const [data, setData] = useState<T>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const previousPath = useRef(path);
  useEffect(() => {
    const controller = new AbortController();
    if (!keepData || !path || path !== previousPath.current) setData(undefined);
    previousPath.current = path;
    setError('');
    if (!path) { setLoading(false); return; }
    setLoading(true);
    void api.request<T>(path, 'GET', undefined, controller.signal).then(value => { if (!controller.signal.aborted) setData(value); }).catch(cause => { if (!controller.signal.aborted) setError(errorText(cause)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [api, path, revision, keepData]);
  return { data, error, loading, setData };
}
export const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
export const query = (values: Record<string, string | number | boolean | undefined>) => new URLSearchParams(Object.entries(values).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)])).toString();
export function RemoteState({ loading, error }: { loading: boolean; error: string }) {
  return <>{loading && <div className="remote-loading"><Spinner size="sm" aria-label="正在加载" /></div>}{error && <p className="settings-error" role="alert">{error}</p>}</>;
}
export function ConfirmAction({ title, children, action, onClose, onDone }: { title: string; children: ReactNode; action: () => Promise<unknown>; onClose: () => void; onDone?: () => void }) {
  const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function run() { setBusy(true); setError(''); try { await action(); onDone?.(); onClose(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); } }
  return <Modal isOpen onClose={() => { if (!busy) onClose(); }} isDismissable={!busy} isKeyboardDismissDisabled={busy} placement="center" scrollBehavior="inside" classNames={{ base: 'app-dialog confirm-dialog', wrapper: 'app-dialog-wrapper', backdrop: 'modal-backdrop', closeButton: 'app-dialog-close' }} aria-label={title}><ModalContent>
    <ModalHeader className="app-dialog-header"><h2>{title}</h2></ModalHeader>
    <ModalBody className="app-dialog-body confirm-dialog-body">{children}{error && <p role="alert" className="settings-error">{error}</p>}</ModalBody>
    <ModalFooter className="app-dialog-footer"><Button size="sm" variant="light" isDisabled={busy} onPress={onClose}>取消</Button><Button size="sm" color="danger" isLoading={busy} onPress={() => void run()}>确认</Button></ModalFooter>
  </ModalContent></Modal>;
}
