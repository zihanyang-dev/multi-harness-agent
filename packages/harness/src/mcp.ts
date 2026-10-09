/** Trusted host configuration, never supplied or authorized by model output. */
export type HarnessMcpServer =
  | {
      name: string;
      transport: 'stdio';
      command: string;
      args?: readonly string[];
      env?: Readonly<Record<string, string>>;
    }
  | {
      name: string;
      transport: 'streamable-http';
      url: string;
      headers?: Readonly<Record<string, string>>;
    };
