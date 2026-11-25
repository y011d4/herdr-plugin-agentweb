/** ui/Token.tsx — asks for the bridge's access token (none stored, a 401, or a failed sign-in). */
import { useRef, type FormEvent } from 'react';

export function Token({ message, onToken }: { message?: string; onToken: (token: string) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const val = input.current!.value.trim();
    if (val) onToken(val);
  };
  return (
    <div id="screen-login" style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 24, padding: '32px 24px', height: '100%', overflowY: 'auto' }}>
      <div className="login-logo">&#128241;</div>
      <div className="login-title">Yoicks</div>
      <div className="login-subtitle">{message || 'Enter the access token shown when the bridge server started.'}</div>
      <form className="login-form" id="token-form" style={{ width: '100%', maxWidth: 360, display: 'flex', flexDirection: 'column', gap: 12 }} onSubmit={submit}>
        <input type="password" id="token-input" ref={input} placeholder="Paste access token…" autoComplete="off" autoCorrect="off" spellCheck={false} />
        <button type="submit" className="btn-primary">Connect</button>
      </form>
    </div>
  );
}
