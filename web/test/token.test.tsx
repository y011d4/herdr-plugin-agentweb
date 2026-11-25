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
});
