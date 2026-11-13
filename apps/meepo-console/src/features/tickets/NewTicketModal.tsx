import { useState } from 'react';

import { api } from '../../api/endpoints';
import { keys } from '../../api/keys';
import { invalidate } from '../../api/query';
import { navigate, spaceHref } from '../../app/router';
import { Button } from '../../ui/Button';
import { Field, Input, TagInput, Textarea } from '../../ui/Form';
import { Modal } from '../../ui/Modal';
import { useAction } from '../../ui/useAction';

export interface TicketDraft {
  title: string;
  objective: string;
  contextSummary: string;
  requiredTags: string[];
}

const TITLE_FALLBACK_CHARS = 80;
const OBJECTIVE_LIMIT = 32_000;

/** Creates a background task for the agent; used for new tickets and "run again" copies. */
export function NewTicketModal({
  spaceId,
  initial,
  onClose,
}: {
  spaceId: string;
  initial?: TicketDraft;
  onClose: () => void;
}): React.JSX.Element {
  const { run, pending } = useAction();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [objective, setObjective] = useState(initial?.objective ?? '');
  const [context, setContext] = useState(initial?.contextSummary ?? '');
  const [tags, setTags] = useState(initial?.requiredTags ?? []);

  const submit = async (): Promise<void> => {
    const text = objective.trim();
    const created = await run(
      () =>
        api.createTicket({
          spaceId,
          title: title.trim() || text.split('\n')[0].slice(0, TITLE_FALLBACK_CHARS),
          objective: text,
          contextSummary: context.trim() || undefined,
          requiredTags: tags.length > 0 ? tags : undefined,
        }),
      { success: 'Ticket created' }
    );
    if (!created) return;
    invalidate(keys.tickets(spaceId));
    onClose();
    navigate(spaceHref(spaceId, 'tickets', created.id));
  };

  return (
    <Modal
      title={initial ? 'Run again as a new ticket' : 'New ticket'}
      description='Hand the agent a task to work on in the background. It reports back here and in the chat that asked.'
      onClose={onClose}
      locked={pending}
      wide
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type='submit' variant='primary' loading={pending} disabled={!objective.trim()}>
            Create ticket
          </Button>
        </>
      }
    >
      <Field
        label='What should the agent do?'
        hint='Be specific about the goal and what a finished result looks like.'
      >
        <Textarea
          value={objective}
          onChange={(e) => setObjective(e.target.value)}
          rows={6}
          maxLength={OBJECTIVE_LIMIT}
          data-autofocus
        />
      </Field>
      <Field label='Title' optional hint='Defaults to the first line of the task.'>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
      </Field>
      <Field
        label='Background'
        optional
        hint='Anything the agent should know first: links, constraints, earlier decisions.'
      >
        <Textarea
          value={context}
          onChange={(e) => setContext(e.target.value)}
          rows={3}
          maxLength={OBJECTIVE_LIMIT}
        />
      </Field>
      <Field
        label='Required worker tags'
        optional
        hint='Only workers with all these tags will pick it up. Press Enter to add.'
      >
        <TagInput value={tags} onChange={setTags} mono placeholder='Add a tag' />
      </Field>
    </Modal>
  );
}
