import { useEffect, useRef } from 'react';

export function useStatusDetails() {
  const details = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const node = details.current;
      if (node?.open && !node.contains(event.target as Node)) node.open = false;
    };
    const escape = (event: KeyboardEvent) => {
      const node = details.current;
      if (event.key !== 'Escape' || !node?.open) return;
      node.open = false;
      if (node.contains(document.activeElement)) node.querySelector('summary')?.focus();
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, []);
  return details;
}
