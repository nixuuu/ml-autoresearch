export interface DashboardLifecycle {
  enabled: boolean;
  keepOpenAfterRun: boolean;
}

export function resolveDashboardLifecycle(args: readonly string[]): DashboardLifecycle {
  const enabled = !args.includes("--no-ui");
  return {
    enabled,
    keepOpenAfterRun: enabled,
  };
}
