import { expect, it } from 'vitest';
import * as config from './config.js';

it('does not activate execution or read infrastructure credentials without explicit opt-in', () => {
  expect(config.readWorkerConfig({})).toBeUndefined();
  expect(() => config.readWorkerConfig({ AGENT_BACKEND_ENABLED: '1' })).toThrow();
});

it('rejects explicit keys that would activate ambient Vertex credential discovery', () => {
  const environment = {
    AGENT_BACKEND_ENABLED: '1',
    DATABASE_URL: 'postgresql://localhost/agent',
    REDIS_URL: 'redis://localhost:6379',
    PI_PROVIDER: 'google-vertex',
    PI_MODEL: 'configured-model',
    PI_STORAGE_ID: 'private-volume',
    PI_STATE_ROOT: '/private/agent',
  };
  for (const PI_API_KEY of [
    '  ',
    '<placeholder>',
    'gcp-vertex-credentials',
    ' gcp-vertex-credentials ',
  ])
    expect(() => config.readWorkerConfig({ ...environment, PI_API_KEY })).toThrow();
});

it('requires explicit credentials and absolute durable storage with a bounded whole-turn deadline', () => {
  const environment = {
    AGENT_BACKEND_ENABLED: '1',
    DATABASE_URL: 'postgresql://localhost/agent',
    REDIS_URL: 'redis://localhost:6379',
    PI_PROVIDER: 'openai',
    PI_MODEL: 'configured-model',
    PI_STORAGE_ID: 'private-volume',
    PI_STATE_ROOT: '/private/agent',
    PI_API_KEY: 'local-test-only',
  };
  expect(config.readWorkerConfig(environment)).toMatchObject({
    prefix: 'mha',
    maxRunMs: 120000,
    binding: { policy: 'text-v1', storageId: 'private-volume' },
  });
  expect(() => config.readWorkerConfig({ ...environment, PI_STATE_ROOT: 'relative' })).toThrow();
  expect(() => config.readWorkerConfig({ ...environment, PI_API_KEY: '' })).toThrow();
  expect(() => config.readWorkerConfig({ ...environment, TURN_MAX_RUN_MS: '0' })).toThrow();
});
