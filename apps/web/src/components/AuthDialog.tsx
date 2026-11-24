'use client';

import { useEffect, useRef, useState } from 'react';
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithPopup,
  signOut,
} from 'firebase/auth';
import { getFirebaseClientAuth, isFirebaseClientConfigured } from '@/lib/firebase-client';

export interface SessionUser {
  name: string;
  email: string;
  uid?: string | null;
  provider: 'guest' | 'google' | 'email';
}

interface AuthDialogProps {
  open: boolean;
  onClose: () => void;
  user: SessionUser | null;
  cloudMode?: boolean;
  onSignedIn: (user: SessionUser) => void;
  onSignOut: () => void;
}

function formatAuthError(err: unknown, fallback: string, isCloud: boolean): string {
  const msg = err instanceof Error ? err.message : fallback;
  if (
    msg.includes('auth/configuration-not-found') ||
    msg.includes('auth/operation-not-allowed')
  ) {
    return isCloud
      ? 'Enable this Sign-In provider in Firebase Console → Authentication → Sign-in method (saibhajanverse).'
      : 'Enable this Sign-In provider in Firebase Console → Authentication → Sign-in method (saibhajanverse), or use Continue as Guest below.';
  }
  return msg;
}

export function AuthDialog({
  open,
  onClose,
  user,
  cloudMode,
  onSignedIn,
  onSignOut,
}: AuthDialogProps) {
  const isCloud = cloudMode ?? isFirebaseClientConfigured();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [mode, setMode] = useState<'signin' | 'register'>('signin');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      dialog.showModal();
    } else if (!open && dialog.open) {
      dialog.close();
    }
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    const onDialogClose = () => {
      dialog.returnValue = '';
      onClose();
    };
    dialog.addEventListener('close', onDialogClose);

    // Light-dismiss fallback for browsers without native closedBy support
    let pointerDownOutside = false;
    const isOutside = (e: PointerEvent) => {
      const r = dialog.getBoundingClientRect();
      return (
        e.clientX < r.left ||
        e.clientX > r.right ||
        e.clientY < r.top ||
        e.clientY > r.bottom
      );
    };
    const onPointerDown = (e: PointerEvent) => {
      pointerDownOutside = isOutside(e);
    };
    const onPointerUp = (e: PointerEvent) => {
      if (!('closedBy' in HTMLDialogElement.prototype) && pointerDownOutside && isOutside(e)) {
        dialog.close();
      }
    };

    dialog.addEventListener('pointerdown', onPointerDown);
    dialog.addEventListener('pointerup', onPointerUp);

    return () => {
      dialog.removeEventListener('close', onDialogClose);
      dialog.removeEventListener('pointerdown', onPointerDown);
      dialog.removeEventListener('pointerup', onPointerUp);
    };
  }, [onClose]);

  const handleGoogleSignIn = async () => {
    setBusy(true);
    setStatusMessage(null);
    const fb = getFirebaseClientAuth();
    if (fb) {
      try {
        const result = await signInWithPopup(fb.auth, fb.googleProvider);
        onSignedIn({
          name: result.user.displayName || 'Sai Devotee',
          email: result.user.email || '',
          uid: result.user.uid,
          provider: 'google',
        });
        setBusy(false);
        dialogRef.current?.close();
        return;
      } catch (err) {
        setStatusMessage(formatAuthError(err, 'Google Sign-In failed', isCloud));
        setBusy(false);
        return;
      }
    }

    if (isCloud) {
      setStatusMessage(
        'Firebase Web configuration is missing. Set NEXT_PUBLIC_FIREBASE_* keys before signing in.',
      );
      setBusy(false);
      return;
    }

    onSignedIn({
      name: 'Srinivasa Pasumarthi (Local Preview)',
      email: 'pschax@gmail.com',
      uid: 'local-admin-preview',
      provider: 'google',
    });
    setBusy(false);
    dialogRef.current?.close();
  };

  const handleEmailSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    if (!form.reportValidity()) return;

    setBusy(true);
    setStatusMessage(null);
    const fb = getFirebaseClientAuth();

    if (fb) {
      try {
        const cred =
          mode === 'register'
            ? await createUserWithEmailAndPassword(fb.auth, email, password)
            : await signInWithEmailAndPassword(fb.auth, email, password);
        onSignedIn({
          name: displayName.trim() || cred.user.displayName || email.split('@')[0],
          email: cred.user.email || email,
          uid: cred.user.uid,
          provider: 'email',
        });
        setBusy(false);
        dialogRef.current?.close();
        return;
      } catch (err) {
        setStatusMessage(formatAuthError(err, 'Authentication failed', isCloud));
        setBusy(false);
        return;
      }
    }

    if (isCloud) {
      setStatusMessage(
        'Firebase Web configuration is missing. Set NEXT_PUBLIC_FIREBASE_* keys before signing in.',
      );
      setBusy(false);
      return;
    }

    // Local preview mode when cloud config is disabled
    onSignedIn({
      name: displayName.trim() || email.split('@')[0],
      email: email.trim(),
      uid: `local_${email.trim()}`,
      provider: 'email',
    });
    setBusy(false);
    dialogRef.current?.close();
  };

  const handleSignOut = async () => {
    const fb = getFirebaseClientAuth();
    if (fb) {
      try {
        await signOut(fb.auth);
      } catch {
        // Still clear client session state
      }
    }
    onSignOut();
    dialogRef.current?.close();
  };

  return (
    <dialog
      ref={dialogRef}
      id="auth-dialog"
      {...({ closedby: 'any' } as Record<string, string>)}
      aria-labelledby="auth-dialog-title"
    >
      <div className="dialog-inner">
        <div className="dialog-header">
          <div>
            <h2 id="auth-dialog-title">Sign in to bhaJami (saibhajanverse)</h2>
            <span className="field-hint">
              {isCloud
                ? 'Connected to live Firebase Auth (saibhajanverse) — non-anonymous account required for contributions'
                : 'Local Dev Auth Preview — add Firebase Web keys in .env.local for live OAuth'}
            </span>
          </div>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => dialogRef.current?.close()}
            aria-label="Close sign in dialog"
          >
            Close
          </button>
        </div>

        {user ? (
          <div className="control-box" style={{ marginBottom: '1rem' }}>
            <div className="control-label">Currently Signed In</div>
            <p style={{ margin: '0 0 0.75rem 0' }}>
              <strong>{user.name}</strong> ({user.email}) · via {user.provider}
            </p>
            <button type="button" className="btn btn-danger btn-sm" onClick={handleSignOut}>
              Sign Out
            </button>
          </div>
        ) : null}

        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.5rem', marginBottom: '1rem' }}>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleGoogleSignIn}
            disabled={busy}
            autoFocus
          >
            Continue with Google
          </button>
          <button
            type="button"
            className="btn"
            onClick={() =>
              setStatusMessage(
                'Facebook & Instagram OIDC require a Meta Developer App ID configured in Firebase Authentication -> Sign-in method.',
              )
            }
          >
            Facebook / Instagram (Meta OIDC)
          </button>
          {!isCloud && (
            <button
              type="button"
              className="btn"
              onClick={() => {
                onSignedIn({ name: 'Guest Bhajan Singer', email: 'guest@local', provider: 'guest' });
                dialogRef.current?.close();
              }}
            >
              Continue as Guest
            </button>
          )}
        </div>

        <hr style={{ border: 0, borderTop: '1px solid var(--border)', margin: '1rem 0' }} />

        <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.85rem' }}>
          <button
            type="button"
            className={`btn btn-sm ${mode === 'signin' ? 'btn-primary' : ''}`}
            onClick={() => setMode('signin')}
          >
            Email Sign In
          </button>
          <button
            type="button"
            className={`btn btn-sm ${mode === 'register' ? 'btn-primary' : ''}`}
            onClick={() => setMode('register')}
          >
            Create Email Account
          </button>
        </div>

        <form onSubmit={handleEmailSubmit}>
          {mode === 'register' && (
            <div className="form-field">
              <label htmlFor="auth-fullname">Display Name</label>
              <span id="auth-name-hint" className="field-hint">
                Appears on lyrics correction credits when approved
              </span>
              <input
                id="auth-fullname"
                name="fullname"
                type="text"
                className="input-control"
                autoComplete="name"
                aria-describedby="auth-name-hint"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
              />
            </div>
          )}

          <div className="form-field">
            <label htmlFor="auth-email">Email Address (Username)</label>
            <span id="auth-email-hint" className="field-hint">
              Format: you@example.com
            </span>
            <input
              id="auth-email"
              name="email"
              type="email"
              required
              autoComplete="username"
              spellCheck={false}
              enterKeyHint="next"
              className="input-control"
              aria-describedby="auth-email-hint"
              data-error="auth-email-error"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <div id="auth-email-error" className="error-msg">
              <span role="img" aria-label="Error">
                ❌
              </span>{' '}
              Enter an email address in the format you@example.com.
            </div>
          </div>

          <div className="form-field">
            <label htmlFor="auth-password">Password</label>
            <span id="auth-pw-hint" className="field-hint">
              {mode === 'register'
                ? 'At least 8 characters with uppercase, lowercase, number, and symbol'
                : 'Enter your bhaJami account password (pasting is supported)'}
            </span>
            <div style={{ display: 'flex', gap: '0.5rem' }}>
              <input
                id="auth-password"
                name="password"
                type={showPassword ? 'text' : 'password'}
                required
                minLength={mode === 'register' ? 8 : 1}
                pattern={
                  mode === 'register'
                    ? '(?=.*\\d)(?=.*[a-z])(?=.*[A-Z])(?=.*[\\W_]).{8,}'
                    : undefined
                }
                autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
                enterKeyHint="done"
                className="input-control"
                aria-describedby="auth-pw-hint"
                data-error="auth-pw-error"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setShowPassword((v) => !v)}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
            <div id="auth-pw-error" className="error-msg">
              <span role="img" aria-label="Error">
                ❌
              </span>{' '}
              {mode === 'register'
                ? 'Password must be at least 8 characters and include upper, lower, number, and symbol.'
                : 'Please enter your password.'}
            </div>
          </div>

          {statusMessage && (
            <p style={{ color: 'var(--accent)', fontSize: '0.88rem', marginBottom: '0.8rem' }}>
              {statusMessage}
            </p>
          )}

          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '0.6rem' }}>
            <button
              type="button"
              className="btn"
              onClick={() => dialogRef.current?.close()}
            >
              Cancel
            </button>
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {mode === 'register' ? 'Create Account' : 'Sign In'}
            </button>
          </div>
        </form>
      </div>
    </dialog>
  );
}
