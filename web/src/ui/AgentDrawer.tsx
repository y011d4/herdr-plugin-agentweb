/**
 * ui/AgentDrawer.tsx — an agent's pane (#/pane/<id>) in Mantine's Drawer over the screen it was opened
 * from (ui/App.tsx keeps that screen as it is under it): a sheet from the bottom on a phone, from the
 * right on a wide screen (lg, 1024px: the PC layout's breakpoint). Its header: ✕, the agent, the
 * terminal ⇄ chat toggle and ⋮; under it the pane (ui/Pane.tsx). ✕, a tap on the dimmed screen, Escape
 * and the phone's Back close it (nav.ts's closeAgent; Back is the hash change itself).
 *
 * Escape is its own: Mantine's modals each close on any Escape outside a shared stack, so the drawer
 * would close with the confirm or the ⋮ menu over it. It closes only with no other layer open. No scroll
 * lock (react-remove-scroll would stop the wheel and touch outside it: a wide screen's sidebar), and no
 * Mantine scroll area: the chat and the terminal scroll themselves. The dimmed part starts at
 * --sidebar-w (a wide screen's sidebar stays usable).
 */
import { Drawer } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { useEffect, type ReactNode } from 'react';
import { closeAgent } from '../nav.ts';
import { WIDE_QUERY } from '../theme.ts';
import { AgentMenu, Pane, PaneTitle, ViewToggle, type AgentActions } from './Pane.tsx';

/** The pane on show (ui/App.tsx): `key` is new for each pane route (a fresh view); a closing drawer
 *  keeps its last pane, its view stopped, until it is gone. */
export interface Sheet { paneId: string; key: number; open: boolean }

// Another layer over the drawer: a dialog of Modals.tsx (Mantine's confirm too) or ⋮'s menu.
const OTHER_LAYER = '.modal-overlay, [data-modal-backdrop], [data-menu-dropdown]';

// The content's one child, in place of Mantine's scroll area (100vh tall): a column the pane fills.
const Fill = ({ children }: { children?: ReactNode }) => <div className="agent-drawer-fill">{children}</div>;

export function AgentDrawer({ sheet, actions }: { sheet: Sheet | null; actions: (paneId: string) => AgentActions }) {
  const wide = useMediaQuery(WIDE_QUERY, undefined, { getInitialValueInEffect: false });
  const open = sheet?.open ?? false;
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.isComposing && !document.querySelector(OTHER_LAYER)) closeAgent();
    };
    // capture, as Mantine's: before a layer over it closes on the same key
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [open]);
  if (!sheet) return null;
  return (
    // its size is style.css's (--drawer-size): a CSS min() is no size prop Mantine reads as such
    <Drawer.Root opened={open} onClose={closeAgent} position={wide ? 'right' : 'bottom'} closeOnEscape={false} lockScroll={false} scrollAreaComponent={Fill}
      classNames={{ root: 'agent-drawer', inner: 'agent-drawer-inner', content: 'agent-drawer-content' }}>
      <Drawer.Overlay color="#000" backgroundOpacity={0.55} className="agent-drawer-overlay" />
      <Drawer.Content aria-label="Agent">
        {/* the focus starts here, not on ✕: opened by no tap (a notification), ✕ would show its focus ring */}
        <div className="agent-drawer-head" key={sheet.key} tabIndex={-1} data-autofocus>
          <button className="topbar-action agent-drawer-close" id="btn-drawer-close" aria-label="Close" onClick={closeAgent}>&#10005;</button>
          <div className="topbar-title"><PaneTitle paneId={sheet.paneId} home={false} /></div>
          <ViewToggle paneId={sheet.paneId} home={false} />
          <AgentMenu actions={actions(sheet.paneId)} />
        </div>
        <Pane key={sheet.key} paneId={sheet.paneId} home={false} />
      </Drawer.Content>
    </Drawer.Root>
  );
}
