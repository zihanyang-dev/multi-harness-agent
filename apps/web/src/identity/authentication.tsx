import { type FormEvent, useEffect, useRef, useState } from 'react';
import { authClient } from './session';

export function AuthForm({ onClose }: { onClose: () => void }) {
  const [signup, setSignup] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const email = useRef<HTMLInputElement>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    dialog.current?.showModal();
    email.current?.focus();
    return () => dialog.current?.close();
  }, []);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    const data = new FormData(event.currentTarget);
    const fields = { email: String(data.get('email')), password: String(data.get('password')) };
    setBusy(true);
    setError('');
    try {
      const result = signup
        ? await authClient.signUp.email({ ...fields, name: String(data.get('name')) })
        : await authClient.signIn.email(fields);
      if (result.error) setError(result.error.message ?? 'Authentication was not accepted.');
      else onClose();
    } catch {
      setError('Unable to reach authentication. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog
      ref={dialog}
      className="fixed inset-0 z-30 m-0 grid h-full max-h-none w-full max-w-none place-items-center border-0 bg-[#0004] p-5"
      aria-labelledby="auth-title"
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <section className="relative w-[380px] max-w-full rounded-[20px] bg-white p-8 shadow-[0_12px_40px_#0002]">
        <button
          className="inline-flex size-[30px] items-center justify-center rounded-lg border-0 bg-transparent text-[20px] hover:bg-[#00000008] absolute top-[10px] right-[10px]"
          type="button"
          aria-label="Close sign in"
          disabled={busy}
          onClick={onClose}
        >
          ×
        </button>
        <h2 className="mb-2 text-[24px] font-semibold" id="auth-title">
          {signup ? 'Create an account' : 'Welcome back'}
        </h2>
        <p className="mb-6 text-[#777]">Sign in to keep your conversations.</p>
        <form onSubmit={(event) => void submit(event)}>
          {signup && (
            <label className="my-4 block text-[13px]">
              Name
              <input
                className="mt-[6px] block w-full rounded-lg border border-[#ddd] p-[10px]"
                name="name"
                required
                autoComplete="name"
              />
            </label>
          )}
          <label className="my-4 block text-[13px]">
            Email
            <input
              className="mt-[6px] block w-full rounded-lg border border-[#ddd] p-[10px]"
              ref={email}
              name="email"
              type="email"
              required
              autoComplete="email"
            />
          </label>
          <label className="my-4 block text-[13px]">
            Password
            <input
              className="mt-[6px] block w-full rounded-lg border border-[#ddd] p-[10px]"
              name="password"
              type="password"
              required
              minLength={signup ? 8 : undefined}
              autoComplete={signup ? 'new-password' : 'current-password'}
            />
          </label>
          {error && (
            <p role="alert" className="text-[13px] leading-5 text-[#a43c32]">
              {error}
            </p>
          )}
          <button
            className="w-full rounded-lg border-0 bg-ink p-[11px] text-white disabled:opacity-50"
            type="submit"
            disabled={busy}
          >
            {busy ? 'Please wait…' : signup ? 'Create account' : 'Sign in'}
          </button>
        </form>
        <button
          className="mt-5 border-0 bg-transparent text-[13px] underline"
          type="button"
          disabled={busy}
          onClick={() => {
            setSignup(!signup);
            setError('');
          }}
        >
          {signup ? 'Already have an account? Sign in' : 'Create an account'}
        </button>
      </section>
    </dialog>
  );
}
