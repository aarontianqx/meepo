import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';

const NEAR_BOTTOM_PX = 96;

/**
 * Keeps a scroll container pinned to its newest content while the reader is at the bottom,
 * and leaves the scroll position alone once they scroll up to read history.
 */
export function useStickToBottom<T extends HTMLElement>(
  contentVersion: unknown
): { ref: RefObject<T | null>; atBottom: boolean; scrollToBottom: () => void } {
  const ref = useRef<T>(null);
  const stuck = useRef(true);
  const [atBottom, setAtBottom] = useState(true);

  const measure = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    const near = node.scrollHeight - node.scrollTop - node.clientHeight < NEAR_BOTTOM_PX;
    stuck.current = near;
    setAtBottom(near);
  }, []);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!node) return undefined;
    node.addEventListener('scroll', measure, { passive: true });
    return () => node.removeEventListener('scroll', measure);
  }, [measure]);

  useLayoutEffect(() => {
    const node = ref.current;
    if (node && stuck.current) node.scrollTop = node.scrollHeight;
  }, [contentVersion]);

  const scrollToBottom = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    stuck.current = true;
    node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
  }, []);

  return { ref, atBottom, scrollToBottom };
}
