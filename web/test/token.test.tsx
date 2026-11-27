// @vitest-environment happy-dom
import { describe, it, vi } from 'vitest';
import assert from 'node:assert/strict';
import { Token } from '../src/ui/Token.tsx';
import { fire, render } from './render.ts';

// The 401 → token screen, its topbar and banner: app.test.tsx / app-token.test.tsx.
describe('Token', () => {
  it('submits the entered token, trimmed, and never a blank one', async () => {
    const onToken = vi.fn();
    const { container, unmount } = await render(<Token onToken={onToken} />);
    assert.match(container.querySelector('.login-subtitle')!.textContent!, /Enter the access token/);
    const input = container.querySelector<HTMLInputElement>('#token-input')!;
    const form = container.querySelector<HTMLFormElement>('#token-form')!;
    input.value = '   ';
    await fire(() => form.requestSubmit());
    assert.equal(onToken.mock.calls.length, 0);
    input.value = '  tok-1 ';
    await fire(() => form.requestSubmit());
    assert.deepEqual(onToken.mock.calls, [['tok-1']]);
    await unmount();
  });

  it('shows the token from its eye, which the keyboard reaches and works', async () => {
    const { container, unmount } = await render(<Token onToken={() => {}} />);
    const input = container.querySelector<HTMLInputElement>('#token-input')!;
    const eye = container.querySelector<HTMLButtonElement>('button[aria-label="Toggle password visibility"]')!;
    assert.equal(eye.tabIndex, 0);
    assert.equal(input.type, 'password');
    await fire(() => eye.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    assert.equal(input.type, 'text');
    await fire(() => eye.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true })));
    assert.equal(input.type, 'password');
    await unmount();
  });

  it("takes the theme's touch target (theme.ts): the field, a PasswordInput, and Connect", async () => {
    const { container, unmount } = await render(<Token onToken={() => {}} />);
    const height = (el: Element | null, prop: string): string => (el as HTMLElement | null)?.style.getPropertyValue(prop) ?? 'none';
    assert.equal(height(container.querySelector('#token-input')!.closest(`[style*="--input-height"]`), '--input-height'), 'calc(2.75rem * var(--mantine-scale))');
    assert.equal(height(container.querySelector('button[type="submit"]'), '--button-height'), 'calc(2.75rem * var(--mantine-scale))');
    await unmount();
  });
});
