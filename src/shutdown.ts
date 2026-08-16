export interface TwoStageShutdownOptions {
  onInterrupt: (signal: NodeJS.Signals) => void;
  onForce: (signal: NodeJS.Signals) => void;
}

export function createTwoStageShutdownHandler(options: TwoStageShutdownOptions): (signal: NodeJS.Signals) => void {
  let interruptionRequested = false;
  let forceRequested = false;
  return (signal) => {
    if (!interruptionRequested) {
      interruptionRequested = true;
      options.onInterrupt(signal);
      return;
    }
    if (forceRequested) return;
    forceRequested = true;
    options.onForce(signal);
  };
}
