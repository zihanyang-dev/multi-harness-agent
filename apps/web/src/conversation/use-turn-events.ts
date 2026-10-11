import { ActivityEnvelopeSchema, type Turn, TurnSchema } from '@multi-harness/protocol/http';
import { useEffect, useEffectEvent, useState } from 'react';
import { emptyActivity, reduceActivity } from './activity';

/** Native EventSource owns reconnect/Last-Event-ID; closing an observer never cancels execution. */
export function useTurnEvents(
  ownerId: string | undefined,
  turn: Turn | undefined,
  onTurn: (turn: Turn) => void,
) {
  const turnId = turn?.id ?? '';
  const live = turn?.status === 'accepted' || turn?.status === 'running';
  const [activity, setActivity] = useState(() => emptyActivity(turnId));
  const [connection, setConnection] = useState<{ turnId: string; connected: boolean }>({
    turnId: '',
    connected: false,
  });
  const receiveTurn = useEffectEvent(onTurn);

  useEffect(() => {
    setActivity(emptyActivity(turnId));
    setConnection({ turnId, connected: false });
    if (!ownerId || !turnId || !live) return;
    const source = new EventSource(`/api/turns/${encodeURIComponent(turnId)}/events`);
    let closed = false;
    const gap = () => setActivity((current) => reduceActivity(current, { kind: 'gap' }));
    source.onopen = () => {
      if (!closed) setConnection({ turnId, connected: true });
    };
    source.onerror = () => {
      if (!closed) setConnection({ turnId, connected: false });
    };
    source.addEventListener('activity', (event: MessageEvent<string>) => {
      if (closed) return;
      try {
        const envelope = ActivityEnvelopeSchema.parse(JSON.parse(event.data));
        if (envelope.turnId !== turnId) return;
        if (!/^\d+-\d+$/.test(event.lastEventId)) {
          gap();
          return;
        }
        setActivity((current) =>
          reduceActivity(current, { kind: 'activity', id: event.lastEventId, envelope }),
        );
      } catch {
        gap();
      }
    });
    source.addEventListener('gap', (event: MessageEvent<string>) => {
      if (closed) return;
      try {
        const data: unknown = JSON.parse(event.data);
        if (
          typeof data === 'object' &&
          data !== null &&
          'code' in data &&
          (data.code === 'activity_gap' || data.code === 'activity_unavailable')
        )
          gap();
      } catch {
        gap();
      }
    });
    source.addEventListener('turn', (event: MessageEvent<string>) => {
      if (closed) return;
      try {
        const snapshot = TurnSchema.parse(JSON.parse(event.data));
        if (snapshot.id !== turnId) return;
        receiveTurn(snapshot);
        setActivity((current) =>
          reduceActivity(current, { kind: 'snapshot', turnId, status: snapshot.status }),
        );
        if (snapshot.status !== 'accepted' && snapshot.status !== 'running') {
          closed = true;
          source.close();
          setConnection({ turnId, connected: false });
        }
      } catch {
        gap();
      }
    });
    return () => {
      closed = true;
      source.close();
    };
  }, [ownerId, turnId, live]);

  const projection = activity.turnId === turnId ? activity : emptyActivity(turnId);
  return {
    activity: projection,
    available: live && connection.turnId === turnId && connection.connected && !projection.missing,
  };
}
