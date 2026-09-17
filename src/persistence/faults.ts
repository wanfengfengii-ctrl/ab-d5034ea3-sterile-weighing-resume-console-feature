/**
 * 故障钩子：供 verify（Vitest / Playwright 经 window.__verify）调用，
 * 分别模拟两次独立写入完成后的立即终止。
 *
 * 每种钩子在每次启动（每个 FaultInjector 实例，即每次 Journal.open）内
 * 最多触发一次；触发后持久层视为已终止，拒绝后续一切操作。
 */

export type FaultHookKind = 'afterPrepare' | 'afterCommit';

export class SimulatedCrashError extends Error {
  readonly hook: FaultHookKind;

  constructor(hook: FaultHookKind) {
    super(`模拟崩溃：${hook} 故障钩子触发，进程立即终止`);
    this.name = 'SimulatedCrashError';
    this.hook = hook;
  }
}

export class FaultInjector {
  private readonly armed = new Set<FaultHookKind>();
  private readonly fired = new Set<FaultHookKind>();

  /** 武装钩子；本次启动内已触发过的钩子无法再次武装。 */
  arm(kind: FaultHookKind): void {
    if (!this.fired.has(kind)) {
      this.armed.add(kind);
    }
  }

  disarm(kind: FaultHookKind): void {
    this.armed.delete(kind);
  }

  isArmed(kind: FaultHookKind): boolean {
    return this.armed.has(kind);
  }

  /**
   * 到达钩子点时调用。若钩子已武装且本次启动尚未触发，
   * 则消费之并返回 true（调用方应立即终止）；否则返回 false。
   */
  consume(kind: FaultHookKind): boolean {
    if (this.fired.has(kind) || !this.armed.has(kind)) {
      return false;
    }
    this.armed.delete(kind);
    this.fired.add(kind);
    return true;
  }
}
