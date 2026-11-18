// Platform admin: instructions given to the agent in every space.

import { useState } from 'react';

import { api } from '../../api/endpoints';
import { keys } from '../../api/keys';
import { setQueryData, useQuery } from '../../api/query';
import { Button } from '../../ui/Button';
import { Field, Textarea } from '../../ui/Form';
import { Callout, ErrorState, ListSkeleton, Page, PageHeader } from '../../ui/Misc';
import { useAction } from '../../ui/useAction';

export function InstructionsPage(): React.JSX.Element {
  const current = useQuery(keys.globalInstructions, api.getGlobalInstructions);

  return (
    <div className='view'>
      <PageHeader
        title='Instructions'
        subtitle='Rules the agent follows in every space, ahead of each space’s own instructions.'
      />
      <Page narrow>
        {current.error && !current.data ? (
          <ErrorState message={current.error} onRetry={() => void current.refresh()} />
        ) : !current.data ? (
          <ListSkeleton rows={3} />
        ) : (
          <InstructionsForm saved={current.data.instructions} />
        )}
      </Page>
    </div>
  );
}

function InstructionsForm({ saved }: { saved: string }): React.JSX.Element {
  const { run, pending } = useAction();
  const [text, setText] = useState(saved);
  const dirty = text.trim() !== saved;

  const save = async (): Promise<void> => {
    const updated = await run(() => api.setGlobalInstructions(text), {
      success: 'Instructions saved',
    });
    if (updated) {
      setQueryData(keys.globalInstructions, () => updated);
      setText(updated.instructions);
    }
  };

  return (
    <form
      className='card card-pad stack'
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Field
        label='Global instructions'
        optional
        hint='Plain text. Use it for working style and standing rules that apply everywhere.'
      >
        <Textarea value={text} onChange={(e) => setText(e.target.value)} rows={14} />
      </Field>
      <Callout>
        A conversation keeps the instructions it started with. Edits apply to new conversations,
        including the first message after <code>/new</code>.
      </Callout>
      <div className='row'>
        <Button type='submit' variant='primary' loading={pending} disabled={!dirty}>
          Save instructions
        </Button>
        {dirty ? <Button onClick={() => setText(saved)}>Reset</Button> : null}
      </div>
    </form>
  );
}
