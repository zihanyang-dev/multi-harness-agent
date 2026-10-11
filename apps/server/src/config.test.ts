import { expect, it } from 'vitest';
import * as config from './config.js';

it('keeps liveness independent of product infrastructure until explicitly enabled', () => {
  expect(config.readServerConfig({})).toEqual({
    hostname: '127.0.0.1',
    port: 3000,
    backend: undefined,
  });
});

it('requires a complete trusted profile and never fills missing authentication configuration', () => {
  expect(() => config.readServerConfig({ AGENT_BACKEND_ENABLED: '1' })).toThrow();
  const environment = {
    AGENT_BACKEND_ENABLED: '1',
    DATABASE_URL: 'postgresql://localhost/agent',
    REDIS_URL: 'redis://localhost:6379',
    BETTER_AUTH_URL: 'http://localhost:3000',
    BETTER_AUTH_SECRET: 'local-test-only-secret-with-32-characters',
    PI_PROVIDER: 'openai',
    PI_MODEL: 'configured-model',
    PI_STORAGE_ID: 'private-volume',
  };
  expect(config.readServerConfig(environment).backend).toMatchObject({
    allowSignUp: false,
    binding: {
      harness: 'pi',
      sdkVersion: '1.1.0',
      provider: 'openai',
      model: 'configured-model',
      policy: 'text-v1',
      storageId: 'private-volume',
    },
  });
  expect(() =>
    config.readServerConfig({ ...environment, AGENT_BACKEND_ENABLED: 'true' }),
  ).toThrow();
  expect(() => config.readServerConfig({ ...environment, PORT: 'not-a-port' })).toThrow();
});
