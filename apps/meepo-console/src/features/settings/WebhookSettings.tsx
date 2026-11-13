import { useState } from 'react';

import { api } from '../../api/endpoints';
import { useSpace } from '../../app/context';
import { Button } from '../../ui/Button';
import { Callout, CopyBox } from '../../ui/Misc';
import { useConfirm } from '../../ui/Modal';
import { useAction } from '../../ui/useAction';

/** Lets external systems create tickets in this space with a bearer token. */
export function WebhookSettings(): React.JSX.Element {
  const space = useSpace();
  const confirm = useConfirm();
  const { run, pendingKey } = useAction();
  const [token, setToken] = useState<string>();

  const issue = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Generate a new webhook token?',
      message:
        'Any token issued before stops working immediately, so update the systems that use it.',
      confirmLabel: 'Generate token',
    });
    if (!ok) return;
    const result = await run(() => api.issueWebhookToken(space.id), {
      success: 'New token generated',
      key: 'issue',
    });
    if (result) setToken(result.token);
  };

  const revoke = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Revoke the webhook token?',
      message: 'External systems can no longer create tickets until you generate a new token.',
      confirmLabel: 'Revoke',
      tone: 'danger',
    });
    if (!ok) return;
    const done = await run(() => api.revokeWebhookToken(space.id), {
      success: 'Token revoked',
      key: 'revoke',
    });
    if (done) setToken(undefined);
  };

  const url = `${window.location.origin}/api/webhooks/${space.id}/tickets`;
  const example = [
    `curl -X POST '${url}' \\`,
    `  -H 'Authorization: Bearer ${token ?? '<token>'}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -d '{"title":"<short title>","objective":"<what the agent should do>"}'`,
  ].join('\n');

  return (
    <section className='card card-pad stack'>
      <div>
        <h3 className='card-title'>Ticket webhook</h3>
        <p className='muted'>
          Let CI, monitoring or your own scripts hand work to this space. Each call creates a ticket
          that a worker picks up.
        </p>
      </div>
      <CopyBox text={example} multiline />
      {token ? (
        <>
          <Callout tone='warn' title='Copy the token now'>
            It is shown only once. Generating another replaces it.
          </Callout>
          <CopyBox text={token} />
        </>
      ) : null}
      <div className='row'>
        <Button
          variant='primary'
          icon='key'
          loading={pendingKey === 'issue'}
          onClick={() => void issue()}
        >
          {token ? 'Generate another' : 'Generate token'}
        </Button>
        <Button variant='danger' loading={pendingKey === 'revoke'} onClick={() => void revoke()}>
          Revoke token
        </Button>
      </div>
    </section>
  );
}
