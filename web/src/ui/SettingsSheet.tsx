/**
 * ui/SettingsSheet.tsx — Settings (#/settings) in front of the screen it was opened from (ui/App.tsx keeps
 * that screen as it is under it, a Home running): Mantine's Modal, centered on a wide screen (lg, 1024px),
 * the whole screen, sliding up, on a phone. ✕, a tap outside, Escape and the phone's Back close it (nav.ts's
 * closeOverlay; Back is the hash change itself). The focus starts at its top, not on ✕ (whose ring would
 * show when it opens by no tap, a notification's), and goes back to what opened it. No scroll lock: nothing
 * under it scrolls the page.
 */
import { Modal } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import type { ReactNode } from 'react';
import { closeOverlay } from '../nav.ts';
import { WIDE_QUERY } from '../theme.ts';

export function SettingsSheet({ open, children }: { open: boolean; children: ReactNode }) {
  const wide = useMediaQuery(WIDE_QUERY, undefined, { getInitialValueInEffect: false });
  return (
    <Modal opened={open} onClose={closeOverlay} title="Settings" fullScreen={!wide} centered size={760} lockScroll={false}
      transitionProps={{ transition: wide ? 'fade' : 'slide-up', duration: 200 }}
      closeButtonProps={{ 'aria-label': 'Close', id: 'btn-settings-close' }}
      classNames={{ content: 'settings-sheet', header: 'settings-sheet-head', title: 'settings-sheet-title', body: 'settings-sheet-body' }}>
      <div className="settings-sheet-start" tabIndex={-1} data-autofocus></div>
      {children}
    </Modal>
  );
}
