/** ui/Token.tsx — asks for the bridge's access token (none stored, a 401, or a failed sign-in). */
import { Button, Image, PasswordInput, Stack, Text } from '@mantine/core';
import { useRef, type FormEvent } from 'react';

export function Token({ message, onToken }: { message?: string; onToken: (token: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const val = input.current!.value.trim();
    if (val) onToken(val);
  };
  return (
    <Stack id="screen-login" align="center" justify="center" gap={24} px={24} py={32} h="100%" style={{ overflowY: 'auto' }}>
      <Image src="/icons/lockup.svg" alt="Yoicks" h={64} w="auto" />
      <Text className="login-subtitle" size="sm" c="dimmed" ta="center" maw={320}>{message || 'Enter the access token the bridge printed when it started.'}</Text>
      <form id="token-form" className="w-full max-w-[360px]" onSubmit={submit}>
        <Stack gap={12}>
          {/* the eye shows what was pasted; Tab reaches it (Mantine's default leaves it out) */}
          <PasswordInput id="token-input" ref={input} aria-label="Access token" placeholder="Paste access token…"
            autoComplete="off" autoCorrect="off" spellCheck={false} visibilityToggleFocusable />
          <Button type="submit" fullWidth>Connect</Button>
        </Stack>
      </form>
    </Stack>
  );
}
