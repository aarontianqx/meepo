// Space settings, split into small tabs so each screen answers one question.

import { spaceHref, type SectionProps } from '../../app/router';
import { useSpace } from '../../app/context';
import { Page, PageHeader, Tabs } from '../../ui/Misc';
import { AgentSettings } from './AgentSettings';
import { ChatSettings } from './ChatSettings';
import { GeneralSettings } from './GeneralSettings';
import { MemberSettings } from './MemberSettings';
import { WebhookSettings } from './WebhookSettings';

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'agent', label: 'Agent' },
  { id: 'chats', label: 'Chats' },
  { id: 'members', label: 'Members' },
  { id: 'webhook', label: 'Webhook' },
] as const;

type TabId = (typeof TABS)[number]['id'];

export function SettingsPage({ item }: SectionProps): React.JSX.Element {
  const space = useSpace();
  const tab: TabId = TABS.find((t) => t.id === item)?.id ?? 'general';
  return (
    <div className='view'>
      <PageHeader title='Settings' subtitle={`Configure ${space.name}.`} />
      <div className='tabs-bar'>
        <Tabs
          label='Settings sections'
          value={tab}
          tabs={TABS.map((t) => ({
            id: t.id,
            label: t.label,
            href: spaceHref(space.id, 'settings', t.id),
          }))}
        />
      </div>
      <Page narrow>
        {tab === 'general' ? <GeneralSettings /> : null}
        {tab === 'agent' ? <AgentSettings /> : null}
        {tab === 'chats' ? <ChatSettings /> : null}
        {tab === 'members' ? <MemberSettings /> : null}
        {tab === 'webhook' ? <WebhookSettings /> : null}
      </Page>
    </div>
  );
}
