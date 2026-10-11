import { useQueryClient } from '@tanstack/react-query';
import { createAuthClient } from 'better-auth/react';
import { useEffect, useRef } from 'react';

// The native client resolves this path against the current browser origin.
export const authClient = createAuthClient({ basePath: '/api/auth', fetchOptions: { retry: 0 } });

export function useOwnerCache(ownerId: string | undefined) {
  const client = useQueryClient();
  const previous = useRef(ownerId);
  useEffect(() => {
    if (previous.current !== ownerId) {
      if (previous.current) {
        void client.cancelQueries({ queryKey: ['owner', previous.current] });
        client.removeQueries({ queryKey: ['owner', previous.current] });
      }
      previous.current = ownerId;
    }
  }, [client, ownerId]);
}
