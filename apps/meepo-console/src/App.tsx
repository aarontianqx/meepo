import { useCallback, useEffect, useState } from 'react';

import { ApiError, errorMessage, getUserId, setUserId } from './api/client';
import { api } from './api/endpoints';
import { clearQueries } from './api/query';
import type { Me } from './api/types';
import { MeProvider } from './app/context';
import { Shell } from './app/Shell';
import { Button } from './ui/Button';
import { Field, Input } from './ui/Form';
import { Icon } from './ui/Icon';
import { Callout } from './ui/Misc';
import { ConfirmProvider } from './ui/Modal';
import { ToastProvider } from './ui/Toast';

type GateState =
  | { kind: 'loading' }
  | { kind: 'ready'; me: Me }
  | { kind: 'signin'; message?: string }
  | { kind: 'error'; message: string };

export function App(): React.JSX.Element {
  // Bumping the generation remounts the whole tree so nothing keeps the previous identity.
  const [generation, setGeneration] = useState(0);
  const switchUser = useCallback(() => setGeneration((n) => n + 1), []);
  return (
    <ToastProvider>
      <ConfirmProvider>
        <IdentityGate key={generation} onSwitchUser={switchUser} />
      </ConfirmProvider>
    </ToastProvider>
  );
}

/** Resolves who the server thinks we are before showing anything else. */
function IdentityGate({ onSwitchUser }: { onSwitchUser: () => void }): React.JSX.Element {
  const [state, setState] = useState<GateState>({ kind: 'loading' });

  // Always ask the server first: it may already know the caller (default dev user, SSO proxy).
  // The id form only appears when the server rejects the current identity.
  const load = useCallback(() => {
    setState({ kind: 'loading' });
    api.me().then(
      (me) => setState({ kind: 'ready', me }),
      (error: unknown) =>
        setState(
          error instanceof ApiError && error.status === 401
            ? { kind: 'signin', message: error.message }
            : { kind: 'error', message: errorMessage(error) }
        )
    );
  }, []);

  useEffect(load, [load]);

  if (state.kind === 'ready')
    return (
      <MeProvider value={state.me}>
        <Shell onSwitchUser={onSwitchUser} />
      </MeProvider>
    );

  return (
    <div className='gate'>
      <div className='gate-card'>
        <span className='brand-mark brand-mark-lg' aria-hidden='true'>
          <Icon name='bot' size={22} strokeWidth={2.1} />
        </span>
        <h1>Meepo Console</h1>
        {state.kind === 'loading' ? (
          <p className='muted' aria-busy='true'>
            Connecting…
          </p>
        ) : state.kind === 'error' ? (
          <>
            <Callout tone='danger' title='Cannot reach the server'>
              {state.message}
            </Callout>
            <Button variant='primary' onClick={load}>
              Retry
            </Button>
          </>
        ) : (
          <SignIn
            message={state.message}
            onSubmit={(userId) => {
              setUserId(userId);
              clearQueries();
              onSwitchUser();
            }}
          />
        )}
      </div>
    </div>
  );
}

function SignIn({
  message,
  onSubmit,
}: {
  message?: string;
  onSubmit: (userId: string) => void;
}): React.JSX.Element {
  const [userId, setUserIdDraft] = useState(getUserId());
  return (
    <form
      className='stack'
      onSubmit={(event) => {
        event.preventDefault();
        if (userId.trim()) onSubmit(userId.trim());
      }}
    >
      <p className='muted'>Choose who you are acting as. Development servers trust this id.</p>
      {message ? <Callout tone='warn'>{message}</Callout> : null}
      <Field label='User id'>
        <Input
          mono
          value={userId}
          onChange={(e) => setUserIdDraft(e.target.value)}
          placeholder='User ID'
          autoFocus
        />
      </Field>
      <Button type='submit' variant='primary' disabled={!userId.trim()}>
        Continue
      </Button>
    </form>
  );
}
