/**
 * OrderedList block stories — numbered markers, start offset, two-digit
 * alignment, nested and mixed lists, and a numbered list in a user bubble.
 */

import type { Meta, StoryObj } from 'storybook-solidjs-vite';
import { ChatHost } from '@/stories/_harness/chat-host';

const meta: Meta = {
  title: 'Rows/Markdown/OrderedList',
  parameters: { layout: 'centered' },
};
export default meta;

type Story = StoryObj;

const TWENTY_THREE = Array.from(
  { length: 23 },
  (_, i) =>
    `${i + 1}. Step number ${i + 1}${i % 5 === 0 ? ' with a longer description that wraps onto a second line' : ''}`
).join('\n');

export const Default: Story = {
  render: () => (
    <ChatHost
      items={[
        {
          kind: 'message',
          id: 'm1',
          role: 'assistant',
          text: 'Steps:\n\n1. Install dependencies\n2. Run the **build**\n3. Start with `pnpm dev`',
        },
      ]}
      height={200}
    />
  ),
};

export const TwoDigitAligned: Story = {
  render: () => (
    <ChatHost
      items={[{ kind: 'message', id: 'm1', role: 'assistant', text: TWENTY_THREE }]}
      height={720}
    />
  ),
};

export const StartOffset: Story = {
  render: () => (
    <ChatHost
      items={[
        {
          kind: 'message',
          id: 'm1',
          role: 'assistant',
          text: 'Continuing from earlier:\n\n15. Fifteenth\n16. Sixteenth\n17. Seventeenth',
        },
      ]}
      height={180}
    />
  ),
};

export const NestedAndMixed: Story = {
  render: () => (
    <ChatHost
      items={[
        {
          kind: 'message',
          id: 'm1',
          role: 'assistant',
          text: [
            '1. Prepare',
            '   - check out the branch',
            '   - install packages',
            '2. Build',
            '   1. compile packages',
            '   2. compile the app',
            '3. Ship',
            '',
            '- [ ] task list items stay bullets',
            '- [x] done item',
          ].join('\n'),
        },
      ]}
      height={320}
    />
  ),
};

export const InUserBubble: Story = {
  render: () => (
    <ChatHost
      items={[
        {
          kind: 'message',
          id: 'u1',
          role: 'user',
          text: 'Please:\n\n1. fix the bug\n2. add tests\n3. open a PR',
        },
      ]}
      height={180}
    />
  ),
};
