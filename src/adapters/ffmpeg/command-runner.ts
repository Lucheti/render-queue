import { spawn } from "node:child_process";
import { JobAbortedError } from "../../domain/job-failure.js";

export interface CommandResult {
  readonly exitCode: number;
  /** Empty when the caller streamed stdout through `onStdout`. */
  readonly stdout: string;
  /** The last few kilobytes of stderr. */
  readonly stderr: string;
}

export interface CommandOptions {
  readonly signal?: AbortSignal;
  /** When set, stdout is streamed to this callback instead of being collected. */
  readonly onStdout?: (chunk: string) => void;
}

/** Runs an executable to completion. */
export interface CommandRunner {
  run(command: string, args: readonly string[], options?: CommandOptions): Promise<CommandResult>;
}

const STDERR_TAIL_BYTES = 8 * 1024;

/** CommandRunner over `child_process.spawn`: no shell, so arguments are never interpreted. */
export class NodeCommandRunner implements CommandRunner {
  public run(command: string, args: readonly string[], options: CommandOptions = {}): Promise<CommandResult> {
    return new Promise((resolve, reject) => {
      if (options.signal?.aborted === true) {
        reject(new JobAbortedError());
        return;
      }
      const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";

      const abort = (): void => {
        child.kill("SIGKILL");
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      const cleanup = (): void => options.signal?.removeEventListener("abort", abort);

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        if (options.onStdout === undefined) {
          stdout += chunk;
        } else {
          options.onStdout(chunk);
        }
      });
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-STDERR_TAIL_BYTES);
      });

      child.once("error", (error) => {
        cleanup();
        reject(error);
      });
      child.once("close", (code) => {
        cleanup();
        if (options.signal?.aborted === true) {
          reject(new JobAbortedError());
          return;
        }
        resolve({ exitCode: code ?? -1, stdout, stderr });
      });
    });
  }
}
