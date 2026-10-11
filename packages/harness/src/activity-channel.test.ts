import { type Event, EventType } from '@ag-ui/core';
import { expect, it } from 'vitest';
import { createActivityChannel } from './activity-channel.js';

it('delivers pending activity and closes independently of execution', async () => {
  const channel = createActivityChannel();
  const read = channel.events.next();
  channel.push({ type: EventType.CUSTOM, name: 'reasoning', value: { status: 'started' } });
  expect((await read).value).toMatchObject({ name: 'reasoning' });
  await channel.events.return?.();
  expect(() =>
    channel.push({ type: EventType.CUSTOM, name: 'reasoning', value: {} }),
  ).not.toThrow();
  expect(await channel.events.next()).toMatchObject({ done: true });
});

it('bounds items and bytes, failing only the observer', async () => {
  for (const event of [
    { type: EventType.CUSTOM, name: 'reasoning', value: {} },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'm', delta: 'x'.repeat(300_000) },
  ] satisfies Event[]) {
    const channel = createActivityChannel();
    for (let i = 0; i < 300; i++) expect(() => channel.push(event)).not.toThrow();
    await expect(channel.events.next()).rejects.toThrow('overflow');
  }
});
