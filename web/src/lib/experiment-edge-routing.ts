export type ExperimentEdgeRouteOptions = {
  sourceX: number;
  sourceY: number;
  targetX: number;
  targetY: number;
  laneIndex: number;
  laneCount: number;
  borderRadius?: number;
};

export type ExperimentEdgeRoute = {
  path: string;
  labelX: number;
  labelY: number;
  trackX: number;
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

/** Routes sibling edges through separate vertical tracks between graph columns. */
export function routeExperimentEdge(options: ExperimentEdgeRouteOptions): ExperimentEdgeRoute {
  const { sourceX, sourceY, targetX, targetY } = options;
  const laneCount = Math.max(1, Math.floor(options.laneCount));
  const laneIndex = clamp(Math.floor(options.laneIndex), 0, laneCount - 1);
  const horizontalGap = targetX - sourceX;

  if (Math.abs(targetY - sourceY) < 0.5) {
    return {
      path: `M ${sourceX} ${sourceY} L ${targetX} ${targetY}`,
      labelX: (sourceX + targetX) / 2,
      labelY: sourceY,
      trackX: (sourceX + targetX) / 2,
    };
  }

  let trackX: number;
  if (horizontalGap > 0) {
    const padding = Math.min(32, Math.max(18, horizontalGap * 0.16));
    const usableWidth = Math.max(0, horizontalGap - padding * 2);
    trackX = sourceX + padding + usableWidth * ((laneIndex + 1) / (laneCount + 1));
  } else {
    trackX = Math.max(sourceX, targetX) + 42 + laneIndex * 16;
  }

  const verticalDirection = Math.sign(targetY - sourceY) || 1;
  const firstHorizontalDirection = Math.sign(trackX - sourceX) || 1;
  const secondHorizontalDirection = Math.sign(targetX - trackX) || 1;
  const radius = Math.min(
    options.borderRadius ?? 10,
    Math.abs(trackX - sourceX) / 2,
    Math.abs(targetY - sourceY) / 2,
    Math.abs(targetX - trackX) / 2,
  );
  const firstCornerX = trackX - firstHorizontalDirection * radius;
  const firstCornerY = sourceY + verticalDirection * radius;
  const secondCornerY = targetY - verticalDirection * radius;
  const secondCornerX = trackX + secondHorizontalDirection * radius;
  const path = [
    `M ${sourceX} ${sourceY}`,
    `L ${firstCornerX} ${sourceY}`,
    `Q ${trackX} ${sourceY} ${trackX} ${firstCornerY}`,
    `L ${trackX} ${secondCornerY}`,
    `Q ${trackX} ${targetY} ${secondCornerX} ${targetY}`,
    `L ${targetX} ${targetY}`,
  ].join(" ");

  return {
    path,
    labelX: trackX,
    labelY: sourceY + (targetY - sourceY) / 2,
    trackX,
  };
}
