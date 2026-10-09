import { Socket } from 'node:net';

function rejectNetwork(): never {
  throw new Error('Network access is forbidden in offline SDK fixtures');
}

// Each fixture has its own process; this never changes the application or Vitest host.
globalThis.fetch = rejectNetwork;
Socket.prototype.connect = rejectNetwork;
