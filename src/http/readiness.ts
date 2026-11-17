import type { HealthCheck } from "../ports/support.js";

export interface ReadinessReport {
  readonly ready: boolean;
  readonly checks: Readonly<Record<string, "ok" | "failed">>;
}

/** Runs every dependency probe in parallel, each with its own deadline. */
export class ReadinessProbe {
  public constructor(
    private readonly checks: readonly HealthCheck[],
    private readonly timeoutMs: number,
  ) {}

  public async run(): Promise<ReadinessReport> {
    const outcomes = await Promise.all(
      this.checks.map(async (probe) => [probe.name, await this.attempt(probe)] as const),
    );
    return {
      ready: outcomes.every(([, outcome]) => outcome === "ok"),
      checks: Object.fromEntries(outcomes),
    };
  }

  private async attempt(probe: HealthCheck): Promise<"ok" | "failed"> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`${probe.name} timed out`)), this.timeoutMs);
    });
    try {
      await Promise.race([probe.check(), deadline]);
      return "ok";
    } catch {
      return "failed";
    } finally {
      clearTimeout(timer);
    }
  }
}
