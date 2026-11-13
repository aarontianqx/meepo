import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';

import { Button } from './Button';
import { Field, Input } from './Form';
import { Icon } from './Icon';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface ModalProps {
  title: string;
  description?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  /** Wraps content and footer in a <form>; the footer submit button triggers it. */
  onSubmit?: (event: FormEvent<HTMLFormElement>) => void;
  /** Disable Esc/backdrop dismissal while work is in flight. */
  locked?: boolean;
}

/** Accessible dialog: focus trap, Esc to close, restores focus and locks page scroll. */
export function Modal({
  title,
  description,
  onClose,
  children,
  footer,
  wide,
  onSubmit,
  locked,
}: ModalProps): React.JSX.Element {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const dialog = dialogRef.current;
    const first =
      dialog?.querySelector<HTMLElement>('[data-autofocus]') ??
      dialog?.querySelector<HTMLElement>('input, textarea, select') ??
      dialog?.querySelector<HTMLElement>(FOCUSABLE);
    first?.focus();
    return () => {
      document.body.style.overflow = previousOverflow;
      previous?.focus?.();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && !locked) {
      event.stopPropagation();
      onClose();
      return;
    }
    if (event.key !== 'Tab') return;
    const nodes = [...(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const content = (
    <>
      <div className='modal-body'>{children}</div>
      {footer ? <div className='modal-foot'>{footer}</div> : null}
    </>
  );
  return createPortal(
    <div
      className='overlay'
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !locked) onClose();
      }}
    >
      <div
        ref={dialogRef}
        className={`modal ${wide ? 'modal-wide' : ''}`}
        role='dialog'
        aria-modal='true'
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <div className='modal-head'>
          <h2 id={titleId}>{title}</h2>
          <Button
            variant='ghost'
            size='sm'
            icon='x'
            aria-label='Close'
            onClick={onClose}
            disabled={locked}
          />
        </div>
        {description ? <div className='modal-sub'>{description}</div> : null}
        {onSubmit ? (
          <form className='modal-form' onSubmit={onSubmit}>
            {content}
          </form>
        ) : (
          <div className='modal-form'>{content}</div>
        )}
      </div>
    </div>,
    document.body
  );
}

export interface ConfirmOptions {
  title: string;
  message: ReactNode;
  confirmLabel?: string;
  tone?: 'default' | 'danger';
  /** Operator must type this exact text to enable the confirm button. */
  requireText?: string;
}

type ConfirmFn = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn | undefined>(undefined);

/** Promise-based replacement for `window.confirm`. */
export function useConfirm(): ConfirmFn {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error('useConfirm requires <ConfirmProvider>');
  return confirm;
}

export function ConfirmProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [pending, setPending] = useState<{
    options: ConfirmOptions;
    resolve: (ok: boolean) => void;
  }>();

  const confirm = useCallback<ConfirmFn>(
    (options) => new Promise<boolean>((resolve) => setPending({ options, resolve })),
    []
  );
  const settle = (ok: boolean): void => {
    pending?.resolve(ok);
    setPending(undefined);
  };
  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {pending ? <ConfirmDialog options={pending.options} onSettle={settle} /> : null}
    </ConfirmContext.Provider>
  );
}

function ConfirmDialog({
  options,
  onSettle,
}: {
  options: ConfirmOptions;
  onSettle: (ok: boolean) => void;
}): React.JSX.Element {
  const [typed, setTyped] = useState('');
  const danger = options.tone === 'danger';
  const ready = !options.requireText || typed === options.requireText;
  return (
    <Modal
      title={options.title}
      onClose={() => onSettle(false)}
      onSubmit={(event) => {
        event.preventDefault();
        if (ready) onSettle(true);
      }}
      footer={
        <>
          <Button onClick={() => onSettle(false)}>Cancel</Button>
          <Button
            type='submit'
            variant={danger ? 'danger-solid' : 'primary'}
            disabled={!ready}
            data-autofocus={options.requireText ? undefined : true}
          >
            {options.confirmLabel ?? 'Confirm'}
          </Button>
        </>
      }
    >
      <div className='row' style={{ alignItems: 'flex-start', gap: 12 }}>
        {danger ? (
          <span
            className='empty-icon'
            style={{
              background: 'var(--danger-soft)',
              color: 'var(--danger)',
              margin: 0,
              flex: 'none',
            }}
          >
            <Icon name='alert' size={20} />
          </span>
        ) : null}
        <div className='muted' style={{ lineHeight: 1.6 }}>
          {options.message}
        </div>
      </div>
      {options.requireText ? (
        <Field
          label={
            <>
              Type <code>{options.requireText}</code> to confirm
            </>
          }
        >
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete='off' />
        </Field>
      ) : null}
    </Modal>
  );
}
