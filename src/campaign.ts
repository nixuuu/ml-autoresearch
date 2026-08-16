/**
 * Dependency-free research campaign primitives.
 *
 * The queue intentionally knows nothing about the ML harness or its artifact
 * format.  It only schedules deterministic, auditable pieces of research.
 */

export type CampaignTicketType = "hypothesis" | "ablation" | "merge" | "search";
export type CampaignTicketStatus = "queued" | "running" | "completed" | "cancelled" | "blocked";

export interface CampaignTicketInput {
  id?: string;
  type: CampaignTicketType;
  /** Human-readable label.  `hypothesis` is used as a fallback. */
  title?: string;
  hypothesis?: string;
  /** An optional stable key supplied by an upstream planner. */
  dedupeKey?: string;
  dependencies?: readonly string[];
  expectedGain?: number;
  probability?: number;
  informationGain?: number;
  estimatedCost?: number;
  parentId?: string;
  metadata?: Readonly<Record<string, unknown>>;
  createdAt?: string;
}

export interface CampaignTicket extends Omit<CampaignTicketInput, "id" | "dependencies" | "metadata" | "createdAt"> {
  id: string;
  status: CampaignTicketStatus;
  dependencies: string[];
  expectedGain: number;
  probability: number;
  informationGain: number;
  estimatedCost: number;
  priorityScore: number;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
  claimedBy?: string;
  claimedAt?: string;
  completedAt?: string;
  cancelledAt?: string;
  blockedAt?: string;
  cancellationReason?: string;
  blockedReason?: string;
  attempts: number;
}

export interface CampaignPriorityOptions {
  expectedGainWeight?: number;
  informationGainWeight?: number;
  costWeight?: number;
}

export interface CampaignQueueOptions {
  staleAfterMs?: number;
  now?: () => Date;
  priority?: CampaignPriorityOptions;
  initialTickets?: readonly CampaignTicketInput[];
}

export interface CompleteCampaignTicketOptions {
  metadata?: Readonly<Record<string, unknown>>;
  completedAt?: Date | string;
}

export interface CancelStaleOptions {
  now?: Date;
  staleAfterMs?: number;
}

export interface NextHypothesisOptions extends Omit<CampaignTicketInput, "id" | "type" | "hypothesis" | "title" | "dedupeKey"> {
  type?: CampaignTicketType;
  /** Applied to every generated hypothesis unless overridden by `ticketDefaults`. */
  ticketDefaults?: Partial<CampaignTicketInput>;
  idPrefix?: string;
}

const DEFAULT_STALE_AFTER_MS = 60 * 60 * 1_000;
const EPSILON = 1e-12;

function assertFiniteNumber(value: number, field: string): void {
  if (!Number.isFinite(value)) throw new Error(`${field} must be a finite number`);
}

function finiteOrDefault(value: number | undefined, fallback: number, field: string): number {
  if (value === undefined) return fallback;
  assertFiniteNumber(value, field);
  return value;
}

function isoDate(value: Date | string | undefined, fallback: Date): string {
  if (value === undefined) return fallback.toISOString();
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) throw new Error("date must be valid");
    return value.toISOString();
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("date must be a valid ISO date");
  return parsed.toISOString();
}

function normalizeText(value: string): string {
  return value.trim().replace(/\s+/gu, " ").toLocaleLowerCase();
}

function stableValue(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(",")}]`;
  return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${stableValue((value as Record<string, unknown>)[key])}`).join(",")}}`;
}

function ticketDedupeKey(input: Pick<CampaignTicketInput, "type" | "title" | "hypothesis" | "dedupeKey" | "metadata">): string {
  if (input.dedupeKey?.trim()) return `${input.type}:key:${normalizeText(input.dedupeKey)}`;
  const text = normalizeText(input.hypothesis ?? input.title ?? "");
  return `${input.type}:text:${text}`;
}

function cloneMetadata(metadata: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> | undefined {
  return metadata === undefined ? undefined : { ...metadata };
}

function cloneTicket(ticket: CampaignTicket): CampaignTicket {
  return {
    ...ticket,
    dependencies: [...ticket.dependencies],
    ...(ticket.metadata === undefined ? {} : { metadata: cloneMetadata(ticket.metadata)! }),
  };
}

/**
 * Calculates the queue score.  Expected gain is discounted by the chance of
 * success, information gain is always useful, and both are normalized by the
 * estimated cost.  All ties are resolved by creation order and then id.
 */
export function calculateCampaignPriority(
  input: Pick<CampaignTicketInput, "expectedGain" | "probability" | "informationGain" | "estimatedCost">,
  options: CampaignPriorityOptions = {},
): number {
  const expectedGain = finiteOrDefault(input.expectedGain, 0, "expectedGain");
  const probability = finiteOrDefault(input.probability, 0, "probability");
  const informationGain = finiteOrDefault(input.informationGain, 0, "informationGain");
  const estimatedCost = finiteOrDefault(input.estimatedCost, 1, "estimatedCost");
  if (probability < 0 || probability > 1) throw new Error("probability must be between 0 and 1");
  if (estimatedCost < 0) throw new Error("estimatedCost must be non-negative");
  const expectedGainWeight = finiteOrDefault(options.expectedGainWeight, 1, "expectedGainWeight");
  const informationGainWeight = finiteOrDefault(options.informationGainWeight, 1, "informationGainWeight");
  const costWeight = finiteOrDefault(options.costWeight, 1, "costWeight");
  if (expectedGainWeight < 0 || informationGainWeight < 0 || costWeight < 0) {
    throw new Error("priority weights must be non-negative");
  }
  const utility = expectedGainWeight * expectedGain * probability + informationGainWeight * informationGain;
  return utility / Math.max(estimatedCost * costWeight, EPSILON);
}

/** Alias retained for callers that prefer a verb rather than a noun. */
export const priorityScore = calculateCampaignPriority;
export const computePriorityScore = calculateCampaignPriority;

function inputToTicket(input: CampaignTicketInput, id: string, now: Date, priority: CampaignPriorityOptions): CampaignTicket {
  const createdAt = isoDate(input.createdAt, now);
  const dependencies = [...new Set((input.dependencies ?? []).map((dependency) => dependency.trim()).filter(Boolean))];
  const expectedGain = finiteOrDefault(input.expectedGain, 0, "expectedGain");
  const probability = finiteOrDefault(input.probability, 0, "probability");
  const informationGain = finiteOrDefault(input.informationGain, 0, "informationGain");
  const estimatedCost = finiteOrDefault(input.estimatedCost, 1, "estimatedCost");
  const score = calculateCampaignPriority({ expectedGain, probability, informationGain, estimatedCost }, priority);
  const { metadata, ...rest } = input;
  return {
    ...rest,
    id,
    status: "queued",
    dependencies,
    expectedGain,
    probability,
    informationGain,
    estimatedCost,
    priorityScore: score,
    createdAt,
    updatedAt: createdAt,
    ...(metadata === undefined ? {} : { metadata: cloneMetadata(metadata)! }),
    attempts: 0,
  };
}

function ticketSort(left: CampaignTicket, right: CampaignTicket): number {
  return right.priorityScore - left.priorityScore
    || left.createdAt.localeCompare(right.createdAt)
    || left.id.localeCompare(right.id);
}

/** A deterministic, in-memory queue for research campaign tickets. */
export class CampaignQueue {
  private readonly tickets = new Map<string, CampaignTicket>();
  private readonly dedupeIndex = new Map<string, string>();
  private readonly staleAfterMs: number;
  private readonly now: () => Date;
  private readonly priority: CampaignPriorityOptions;
  private nextId = 1;

  public constructor(options: CampaignQueueOptions = {}) {
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    if (!Number.isFinite(this.staleAfterMs) || this.staleAfterMs < 0) throw new Error("staleAfterMs must be non-negative");
    this.now = options.now ?? (() => new Date());
    this.priority = { ...(options.priority ?? {}) };
    for (const ticket of options.initialTickets ?? []) this.enqueue(ticket);
  }

  public get size(): number {
    return this.tickets.size;
  }

  public get(id: string): CampaignTicket | undefined {
    this.refreshBlocked();
    const ticket = this.tickets.get(id);
    return ticket ? cloneTicket(ticket) : undefined;
  }

  public has(id: string): boolean {
    return this.tickets.has(id);
  }

  public list(status?: CampaignTicketStatus): CampaignTicket[] {
    this.refreshBlocked();
    return [...this.tickets.values()]
      .filter((ticket) => status === undefined || ticket.status === status)
      .sort(ticketSort)
      .map(cloneTicket);
  }

  public snapshot(): CampaignTicket[] {
    return this.list();
  }

  /** Returns an existing ticket that represents the same work, if present. */
  public deduplicate(input: CampaignTicketInput): CampaignTicket | undefined {
    const existingId = this.dedupeIndex.get(ticketDedupeKey(input));
    const existing = existingId === undefined ? undefined : this.tickets.get(existingId);
    return existing ? cloneTicket(existing) : undefined;
  }

  public enqueue(input: CampaignTicketInput): CampaignTicket {
    if (!input.type) throw new Error("ticket type is required");
    const dedupeKey = ticketDedupeKey(input);
    const existingId = this.dedupeIndex.get(dedupeKey);
    if (existingId !== undefined) return cloneTicket(this.tickets.get(existingId)!);
    const now = this.now();
    const id = input.id?.trim() || `ticket-${String(this.nextId++).padStart(4, "0")}`;
    if (this.tickets.has(id)) throw new Error(`campaign ticket already exists: ${id}`);
    const ticket = inputToTicket(input, id, now, this.priority);
    this.tickets.set(id, ticket);
    this.dedupeIndex.set(dedupeKey, id);
    return cloneTicket(ticket);
  }

  public enqueueMany(inputs: readonly CampaignTicketInput[]): CampaignTicket[] {
    return inputs.map((input) => this.enqueue(input));
  }

  /**
   * Claims the highest-priority ready ticket.  Dependencies must all be
   * completed; cancelled/blocked or missing dependencies block the ticket.
   */
  public claim(workerId = "default"): CampaignTicket | undefined {
    if (!workerId.trim()) throw new Error("workerId must not be empty");
    this.refreshBlocked();
    const candidate = [...this.tickets.values()]
      .filter((ticket) => ticket.status === "queued" && this.dependenciesCompleted(ticket))
      .sort(ticketSort)[0];
    if (!candidate) return undefined;
    const now = this.now().toISOString();
    candidate.status = "running";
    candidate.claimedBy = workerId;
    candidate.claimedAt = now;
    candidate.updatedAt = now;
    candidate.attempts += 1;
    return cloneTicket(candidate);
  }

  public complete(id: string, options: CompleteCampaignTicketOptions = {}): CampaignTicket {
    const ticket = this.require(id);
    if (ticket.status !== "running") throw new Error(`campaign ticket is not running: ${id}`);
    const completedAt = isoDate(options.completedAt, this.now());
    ticket.status = "completed";
    ticket.completedAt = completedAt;
    ticket.updatedAt = completedAt;
    if (options.metadata !== undefined) ticket.metadata = { ...(ticket.metadata ?? {}), ...options.metadata };
    return cloneTicket(ticket);
  }

  public cancel(id: string, reason = "cancelled by operator"): CampaignTicket {
    const ticket = this.require(id);
    if (ticket.status === "completed" || ticket.status === "cancelled") return cloneTicket(ticket);
    const timestamp = this.now().toISOString();
    ticket.status = "cancelled";
    ticket.cancelledAt = timestamp;
    ticket.updatedAt = timestamp;
    ticket.cancellationReason = reason;
    return cloneTicket(ticket);
  }

  /** Cancels running tickets that have exceeded their claim lease. */
  public cancelStale(optionsOrNow: CancelStaleOptions | Date = {}, staleAfterMsArgument?: number): CampaignTicket[] {
    const options = optionsOrNow instanceof Date ? { now: optionsOrNow, ...(staleAfterMsArgument === undefined ? {} : { staleAfterMs: staleAfterMsArgument }) } : optionsOrNow;
    const now = options.now ?? this.now();
    const staleAfterMs = options.staleAfterMs ?? this.staleAfterMs;
    if (!Number.isFinite(now.getTime())) throw new Error("now must be a valid date");
    if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) throw new Error("staleAfterMs must be non-negative");
    const cancelled: CampaignTicket[] = [];
    for (const ticket of this.tickets.values()) {
      if (ticket.status !== "running" || ticket.claimedAt === undefined) continue;
      const claimedAt = Date.parse(ticket.claimedAt);
      if (!Number.isFinite(claimedAt) || now.getTime() - claimedAt < staleAfterMs) continue;
      ticket.status = "cancelled";
      ticket.cancelledAt = now.toISOString();
      ticket.updatedAt = ticket.cancelledAt;
      ticket.cancellationReason = `stale claim exceeded ${staleAfterMs}ms`;
      cancelled.push(cloneTicket(ticket));
    }
    this.refreshBlocked();
    return cancelled.sort(ticketSort);
  }

  public enqueueNextHypotheses(nextHypotheses: readonly string[], options: NextHypothesisOptions = {}): CampaignTicket[] {
    const defaults = options.ticketDefaults ?? {};
    const type = options.type ?? "hypothesis";
    const idPrefix = options.idPrefix ?? type;
    const { type: _type, ticketDefaults: _ticketDefaults, idPrefix: _idPrefix, ...optionDefaults } = options;
    const generated: CampaignTicket[] = [];
    nextHypotheses.forEach((rawHypothesis, index) => {
      const hypothesis = rawHypothesis.trim();
      if (!hypothesis) return;
      const explicitId = `${idPrefix}-${String(index + 1).padStart(4, "0")}`;
      generated.push(this.enqueue({
        ...optionDefaults,
        ...defaults,
        id: explicitId,
        type,
        hypothesis,
        title: hypothesis,
        dedupeKey: hypothesis,
      }));
    });
    return generated;
  }

  /** Alias used by planners that call the generated items a campaign. */
  public generateFromNextHypotheses(nextHypotheses: readonly string[], options: NextHypothesisOptions = {}): CampaignTicket[] {
    return this.enqueueNextHypotheses(nextHypotheses, options);
  }

  private require(id: string): CampaignTicket {
    const ticket = this.tickets.get(id);
    if (!ticket) throw new Error(`campaign ticket does not exist: ${id}`);
    return ticket;
  }

  private dependenciesCompleted(ticket: CampaignTicket): boolean {
    return ticket.dependencies.every((dependencyId) => this.tickets.get(dependencyId)?.status === "completed");
  }

  private refreshBlocked(): void {
    let changed = true;
    while (changed) {
      changed = false;
      for (const ticket of this.tickets.values()) {
        if (ticket.status !== "queued") continue;
        const blocking = ticket.dependencies.find((dependencyId) => {
          const dependency = this.tickets.get(dependencyId);
          return dependency === undefined || dependency.status === "cancelled" || dependency.status === "blocked";
        });
        if (blocking === undefined) continue;
        const timestamp = this.now().toISOString();
        ticket.status = "blocked";
        ticket.blockedAt = timestamp;
        ticket.updatedAt = timestamp;
        ticket.blockedReason = this.tickets.has(blocking)
          ? `dependency ${blocking} is ${this.tickets.get(blocking)!.status}`
          : `dependency ${blocking} does not exist`;
        changed = true;
      }
    }
  }
}

/** Semantic alias for callers that model the queue as a campaign scheduler. */
export const ResearchCampaignQueue = CampaignQueue;

export function createCampaignQueue(options: CampaignQueueOptions = {}): CampaignQueue {
  return new CampaignQueue(options);
}

/** Pure helper for callers that do not need a queue instance. */
export function createCampaignTicketsFromNextHypotheses(
  nextHypotheses: readonly string[],
  options: NextHypothesisOptions = {},
): CampaignTicketInput[] {
  const defaults = options.ticketDefaults ?? {};
  const type = options.type ?? "hypothesis";
  const idPrefix = options.idPrefix ?? type;
  return nextHypotheses.flatMap((rawHypothesis, index) => {
    const hypothesis = rawHypothesis.trim();
    if (!hypothesis) return [];
    return [{
      ...defaults,
      type,
      id: `${idPrefix}-${String(index + 1).padStart(4, "0")}`,
      hypothesis,
      title: hypothesis,
      dedupeKey: hypothesis,
    } satisfies CampaignTicketInput];
  });
}

/** Alias for integrations that use "next hypotheses" as a planner concept. */
export const ticketsFromNextHypotheses = createCampaignTicketsFromNextHypotheses;
