export interface CreateSandboxOptions {
  timeoutMs: number;
}

export interface StartSandboxCommandOptions {
  command: string;
  cwd?: string;
}

export interface SandboxOutput {
  stream: 'stdout' | 'stderr';
  text: string;
}

export interface SandboxExit {
  exitCode: number;
}

/** Owns a command; a stop request is not proof that it has exited. */
export interface SandboxProcess {
  readonly output: AsyncIterable<SandboxOutput>;
  wait: () => Promise<SandboxExit>;
  stop: () => Promise<void>;
}

export interface SandboxCommands {
  start: (options: StartSandboxCommandOptions) => Promise<SandboxProcess>;
}

export interface SandboxFiles {
  read: (path: string) => Promise<Uint8Array>;
  write: (path: string, content: Uint8Array) => Promise<void>;
}

/** Scoped to one environment; contains no account-level management capability. */
export interface SandboxExecution {
  readonly commands: SandboxCommands;
  readonly files: SandboxFiles;
}

export interface Sandbox {
  readonly id: string;
  readonly execution: SandboxExecution;
}

/** The host owns creation and destruction; do not pass this provider to arbitrary code. */
export interface SandboxProvider {
  create: (options: CreateSandboxOptions) => Promise<Sandbox>;
  connect: (sandboxId: string) => Promise<Sandbox>;
  destroy: (sandboxId: string) => Promise<void>;
}
