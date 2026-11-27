/**
 * ui/Toasts.tsx — the toast stack (notify.ts's store), drawn into #toast-container, oldest
 * first, each one Mantine's Notification. A toast goes after 4s, on its ✕, or a right swipe past
 * 72px. Only the toasts take taps: a tap between or beside them reaches the screen under them.
 */
import { Notification } from '@mantine/core';
import { useRef, useSyncExternalStore } from 'react';
import { dismissToast, getToasts, removeToast, subscribeToasts, type Toast } from '../notify.ts';

export function Toasts() {
  const toasts = useSyncExternalStore(subscribeToasts, getToasts);
  return <>{toasts.map((t) => <ToastItem key={t.id} toast={t} />)}</>;
}

function ToastItem({ toast: t }: { toast: Toast }) {
  const el = useRef<HTMLDivElement>(null);
  // the swipe follows the finger by styling the element directly, not by re-rendering
  const swipe = useRef({ startX: 0, dx: 0 });
  const s = swipe.current;
  const style = (): CSSStyleDeclaration => el.current!.style;

  return (
    // #toast-container is the live region: no alert role of its own, so a toast is read out once
    <Notification
      ref={el}
      role="none"
      className={t.fading ? 'toast fading' : 'toast'}
      title={t.title}
      color="gray"
      radius={10}
      bg="dark.4"
      closeButtonProps={{ 'aria-label': 'Dismiss', size: 'lg' }}
      onClose={() => dismissToast(t.id)}
      onTouchStart={(e) => {
        s.startX = e.touches[0].clientX;
        s.dx = 0;
        style().transition = 'none';
      }}
      onTouchMove={(e) => {
        s.dx = e.touches[0].clientX - s.startX;
        if (s.dx > 0) {
          style().transform = `translateX(${s.dx}px)`;
          style().opacity = String(Math.max(0.2, 1 - s.dx / 240));
        }
      }}
      onTouchEnd={() => {
        style().transition = 'transform 0.15s ease-out, opacity 0.15s ease-out';
        if (s.dx > 72) {
          style().transform = 'translateX(120%)';
          style().opacity = '0';
          setTimeout(() => removeToast(t.id), 150);
        } else {
          style().transform = '';
          style().opacity = '';
        }
        s.dx = 0;
      }}
    >
      {t.body}
    </Notification>
  );
}
