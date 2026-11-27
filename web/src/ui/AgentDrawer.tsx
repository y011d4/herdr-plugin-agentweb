/**
 * ui/AgentDrawer.tsx — an agent's pane (#/pane/<id>) in Mantine's Drawer over the screen it was opened
 * from (ui/App.tsx keeps that screen as it is under it): a sheet from the bottom on a phone, from the
 * right on a wide screen (lg, 1024px: the PC layout's breakpoint). Its header: ✕, the agent, the
 * terminal ⇄ chat toggle and ⋮; under it the pane (ui/Pane.tsx). ✕, a tap on the dimmed screen, Escape
 * and the phone's Back close it (nav.ts's closeAgent; Back is the hash change itself).
 *
 * The focus starts on its header (not on ✕, whose ring would show). A phone's sheet traps it; a wide
 * screen's drawer doesn't, so Tab reaches the sidebar, while the screen under it is inert (ui/App.tsx).
 *
 * Escape is its own: Mantine's modals each close on any Escape outside a shared stack, so the drawer
 * would close with the confirm or the ⋮ menu over it. It closes only with no other layer open. No scroll
 * lock (react-remove-scroll would stop the wheel and touch outside it: a wide screen's sidebar), and no
 * Mantine scroll area: the chat and the terminal scroll themselves. The dimmed part starts at
 * --sidebar-w (a wide screen's sidebar stays usable).
 */
import { CloseButton, Drawer } from '@mantine/core';
import { useMediaQuery } from '@mantine/hooks';
import { Fragment, useCallback, useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { closeAgent } from '../nav.ts';
import { WIDE_QUERY } from '../theme.ts';
import { AgentMenu, agentMenuOpen, Pane, PaneTitle, ViewToggle, type AgentActions } from './Pane.tsx';

/** The pane on show (ui/App.tsx): `key` is new for each pane route (a fresh view); a closing drawer
 *  keeps its last pane, its view stopped, until it is gone. `opener`: what had the focus as it opened, and
 *  the pane it opened then (`openedPane`: pane to pane keeps both). */
export interface Sheet { paneId: string; key: number; open: boolean; opener: HTMLElement | null; openedPane: string }

// Another layer over the drawer: a dialog of Modals.tsx (Mantine's Modal), or ⋮'s menu while open (its
// state, not its dropdown in the DOM: that stays through its closing transition, and takes the focus only a
// moment after it opens).
const otherLayer = (): boolean => agentMenuOpen || !!document.querySelector('[data-modal-backdrop]');

// The content's one child, in place of Mantine's scroll area (100vh tall): a column the pane fills.
const Fill = ({ children }: { children?: ReactNode }) => <div className="agent-drawer-fill">{children}</div>;

export function AgentDrawer({ sheet, actions }: { sheet: Sheet | null; actions: (paneId: string) => AgentActions }) {
  const wide = useMediaQuery(WIDE_QUERY, undefined, { getInitialValueInEffect: false });
  const open = sheet?.open ?? false;
  // each pane's header as it mounts (keyed): stable, so a re-render doesn't take the focus back
  const focusHead = useCallback((el: HTMLDivElement | null) => { el?.focus({ preventScroll: true }); }, []);
  // A phone's sheet traps the focus and gives it back on close (Mantine). A wide screen's, untrapped, gives
  // it back here: only when it was in the drawer or lost, not when the user took it to the sidebar: to the
  // opener (a Home resumed under it keeps it), else, on a screen drawn afresh (a Home whose pane changed,
  // the list), to its control for the pane it opened on (a chip), else for the pane on show (a Clear's
  // new pane: the old one has none), if any.
  const content = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const a = document.activeElement;
    if (open || !sheet || !wide || (a && a !== document.body && !content.current?.contains(a))) return;
    const control = (paneId: string) => document.querySelector<HTMLElement>(`#screen [data-pane-id="${CSS.escape(paneId)}"]`);
    const back = sheet.opener?.isConnected ? sheet.opener : control(sheet.openedPane) ?? control(sheet.paneId);
    back?.focus({ preventScroll: true });
  }, [open]); // on a close only
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !e.isComposing && !otherLayer()) closeAgent();
    };
    // capture, as Mantine's: before a layer over it closes on the same key
    addEventListener('keydown', onKey, true);
    return () => removeEventListener('keydown', onKey, true);
  }, [open]);
  if (!sheet) return null;
  return (
    // its size is style.css's (--drawer-size): a CSS min() is no size prop Mantine reads as such
    <Drawer.Root opened={open} onClose={closeAgent} position={wide ? 'right' : 'bottom'} closeOnEscape={false} lockScroll={false} scrollAreaComponent={Fill}
      trapFocus={!wide}
      classNames={{ root: 'agent-drawer', inner: 'agent-drawer-inner', content: 'agent-drawer-content' }}>
      <Drawer.Overlay color="#000" backgroundOpacity={0.55} className="agent-drawer-overlay" />
      {/* non-modal on a wide screen (the sidebar beside it is usable): Mantine sets aria-modal="true" whatever */}
      <Drawer.Content aria-label="Agent" ref={(el: HTMLElement | null) => { if (el) { content.current = el; el.setAttribute('aria-modal', String(!wide)); } }}>
        {/* each pane's header and body, mounted afresh as the drawer switches to it: one key for both (two
            siblings sharing one key leave the earlier one behind, a header per agent opened) */}
        <Fragment key={sheet.key}>
        {/* the focus starts here, not on ✕: opened by no tap (a notification), ✕ would show its focus ring */}
        <div className="agent-drawer-head" ref={focusHead} tabIndex={-1} data-autofocus>
          <CloseButton id="btn-drawer-close" aria-label="Close" size="xl" iconSize={18} className="shrink-0 text-(--color-text-dim) hover:text-(--color-text)" onClick={closeAgent} />
          <div className="topbar-title"><PaneTitle paneId={sheet.paneId} home={false} /></div>
          <ViewToggle paneId={sheet.paneId} home={false} />
          <AgentMenu actions={actions(sheet.paneId)} />
        </div>
        <Pane paneId={sheet.paneId} home={false} />
        </Fragment>
      </Drawer.Content>
    </Drawer.Root>
  );
}
