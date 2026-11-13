import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

import { errorMessage } from '../api/client';
import { Icon } from './Icon';

type ToastKind = 'ok' | 'error' | 'info';

interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastApi {
  success: (message: string) => void;
  error: (error: unknown) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi | undefined>(undefined);

export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast requires <ToastProvider>');
  return api;
}

const LIFETIME_MS: Record<ToastKind, number> = { ok: 3500, info: 4000, error: 7000 };

export function ToastProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setItems((current) => current.filter((item) => item.id !== id));
  }, []);

  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = nextId.current++;
      setItems((current) => [...current.slice(-3), { id, kind, message }]);
      setTimeout(() => dismiss(id), LIFETIME_MS[kind]);
    },
    [dismiss]
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (message) => push('ok', message),
      info: (message) => push('info', message),
      error: (error) => push('error', errorMessage(error)),
    }),
    [push]
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className='toasts' role='status' aria-live='polite'>
        {items.map((item) => (
          <div key={item.id} className={`toast toast-${item.kind}`}>
            <Icon
              name={item.kind === 'error' ? 'alert' : item.kind === 'ok' ? 'checkCircle' : 'info'}
              size={16}
            />
            <span className='toast-msg'>{item.message}</span>
            <button className='toast-close' onClick={() => dismiss(item.id)} aria-label='Dismiss'>
              <Icon name='x' size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
