import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

interface PopoverProps {
  anchor: RefObject<HTMLElement | null>;
  onClose: () => void;
  children: ReactNode;
  /** Align the popover's left or right edge with the anchor. */
  align?: 'start' | 'end';
  /** Open above the anchor (used by footer menus). */
  placement?: 'bottom' | 'top';
  width?: number;
  label: string;
}

/** Anchored floating panel: closes on outside click / Esc, flips to stay inside the viewport. */
export function Popover({
  anchor,
  onClose,
  children,
  align = 'start',
  placement = 'bottom',
  width,
  label,
}: PopoverProps): React.JSX.Element {
  const panel = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<React.CSSProperties>({ visibility: 'hidden' });

  const position = useCallback(() => {
    const trigger = anchor.current;
    const node = panel.current;
    if (!trigger || !node) return;
    const rect = trigger.getBoundingClientRect();
    const height = node.offsetHeight;
    const panelWidth = width ?? Math.max(node.offsetWidth, rect.width);
    let left = align === 'start' ? rect.left : rect.right - panelWidth;
    left = Math.min(Math.max(8, left), window.innerWidth - panelWidth - 8);
    const below = rect.bottom + 6;
    const above = rect.top - height - 6;
    const top =
      placement === 'bottom'
        ? below + height > window.innerHeight - 8 && above > 8
          ? above
          : below
        : above < 8 && below + height < window.innerHeight
          ? below
          : above;
    setStyle({ left, top, minWidth: width ?? rect.width, width, visibility: 'visible' });
  }, [anchor, align, placement, width]);

  useLayoutEffect(position, [position]);

  useEffect(() => {
    const onPointer = (event: MouseEvent): void => {
      const target = event.target as Node;
      if (!panel.current?.contains(target) && !anchor.current?.contains(target)) onClose();
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
        anchor.current?.focus();
      }
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', position);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', position);
    };
  }, [anchor, onClose, position]);

  return createPortal(
    <div ref={panel} className='popover' style={style} role='dialog' aria-label={label}>
      {children}
    </div>,
    document.body
  );
}
