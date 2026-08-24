/**
 * EVENT BUS — FASE 9
 *
 * Barramento tipado sobre `RuntimeEvent` do contrato. Três invariantes que
 * valem mais que a API:
 *
 *  1. REDAÇÃO NA FRONTEIRA. Todo evento passa por `redactObject` no `emit`, uma
 *     única vez. O que vai para o buffer, para o assinante e para o WebSocket é
 *     o mesmo objeto já redigido. Não existe caminho que entregue o evento cru.
 *
 *  2. EMIT NÃO BLOQUEIA. Handler lento não segura o produtor: `emit` só
 *     enfileira e agenda o dreno. A fila por assinante tem teto; ao estourar,
 *     descarta e CONTA. Um drop silencioso seria a mesma mentira que o
 *     truncamento silencioso que o contrato proíbe em `Observation.truncated`.
 *
 *  3. BUFFER CIRCULAR. Os últimos N eventos ficam retidos para que um cliente
 *     que reconecta receba o que perdeu, em vez de acordar cego.
 *
 * Ordem por assinante é preservada (dreno sequencial). Ordem global entre
 * assinantes distintos não é prometida — cada um tem sua própria fila.
 */
import type { EventName, RuntimeEvent } from "../../core/src/contract.ts";
import { newId, nowIso } from "../../core/src/contract.ts";
import { redactObject } from "./redact.ts";

export type EventSelector = EventName | "*";

export type EventHandler<P = Record<string, unknown>> = (
  event: RuntimeEvent<P>,
) => void | Promise<void>;

export interface SubscriptionFilter {
  /** `undefined`/`null` = todas as sessões. Caso contrário, casamento exato. */
  session_id?: string | null;
  /** Lista vazia ou ausente = todos os eventos. */
  events?: readonly EventName[];
}

export interface SubscriberStats {
  id: string;
  filter: SubscriptionFilter;
  pending: number;
  delivered: number;
  dropped: number;
  errors: number;
}

export interface EventBusStats {
  emitted: number;
  delivered: number;
  /** Eventos descartados por fila cheia de assinante lento. */
  dropped: number;
  handler_errors: number;
  buffered: number;
  buffer_capacity: number;
  subscribers: number;
  per_subscriber: SubscriberStats[];
}

export interface Subscription {
  readonly id: string;
  readonly filter: SubscriptionFilter;
  unsubscribe(): void;
  stats(): SubscriberStats;
  /** Resolve quando a fila DESTE assinante estiver vazia. Evita sleep em teste. */
  idle(): Promise<void>;
}

export interface EventBusOptions {
  /** Tamanho do buffer circular de reconexão. */
  bufferSize?: number;
  /** Teto da fila por assinante antes de descartar. */
  maxQueuePerSubscriber?: number;
  /** Chamado quando um handler estoura. O bus NUNCA engole a exceção em silêncio. */
  onHandlerError?: (error: unknown, event: RuntimeEvent, subscriberId: string) => void;
}

export interface HistoryQuery extends SubscriptionFilter {
  limit?: number;
  /** ISO-8601: só eventos com timestamp ESTRITAMENTE maior. */
  since?: string;
}

const DEFAULT_BUFFER = 1000;
const DEFAULT_QUEUE = 256;
/** Teto de voltas do `drain()`. Handler que emite em loop falha alto, não trava. */
const DRAIN_ROUNDS = 1000;

export function eventMatchesFilter(event: RuntimeEvent, filter: SubscriptionFilter): boolean {
  if (filter.session_id !== undefined && filter.session_id !== null) {
    if (event.session_id !== filter.session_id) return false;
  }
  if (filter.events !== undefined && filter.events.length > 0) {
    if (!filter.events.includes(event.event)) return false;
  }
  return true;
}

class Subscriber implements Subscription {
  readonly id: string;
  readonly filter: SubscriptionFilter;
  readonly handler: EventHandler<never>;
  readonly selector: EventSelector | null;
  readonly maxQueue: number;

  queue: RuntimeEvent[] = [];
  running = false;
  delivered = 0;
  dropped = 0;
  errors = 0;
  active = true;

  #waiters: Array<() => void> = [];
  /** Campo explícito em vez de parameter property: o strip de tipos do Node
   *  só apaga sintaxe apagável, e parameter property não é. */
  readonly bus: EventBus;

  constructor(
    id: string,
    filter: SubscriptionFilter,
    handler: EventHandler<never>,
    maxQueue: number,
    bus: EventBus,
    selector: EventSelector | null,
  ) {
    this.id = id;
    this.filter = filter;
    this.handler = handler;
    this.maxQueue = maxQueue;
    this.bus = bus;
    this.selector = selector;
  }

  push(event: RuntimeEvent): void {
    if (!this.active) return;
    if (this.queue.length >= this.maxQueue) {
      // Descarta o MAIS ANTIGO: um consumidor atrasado quer o estado atual, não
      // o histórico — e o histórico já está no buffer circular do bus.
      this.queue.shift();
      this.dropped += 1;
      this.bus._countDrop();
    }
    this.queue.push(event);
    if (!this.running) {
      this.running = true;
      queueMicrotask(() => void this.#drain());
    }
  }

  async #drain(): Promise<void> {
    try {
      while (this.queue.length > 0) {
        const event = this.queue.shift()!;
        try {
          await (this.handler as EventHandler)(event);
          this.delivered += 1;
          this.bus._countDelivered();
        } catch (error) {
          this.errors += 1;
          this.bus._countHandlerError(error, event, this.id);
        }
      }
    } finally {
      this.running = false;
      const waiters = this.#waiters;
      this.#waiters = [];
      for (const w of waiters) w();
    }
  }

  idle(): Promise<void> {
    if (!this.running && this.queue.length === 0) return Promise.resolve();
    return new Promise<void>((resolve) => this.#waiters.push(resolve));
  }

  stats(): SubscriberStats {
    return {
      id: this.id,
      filter: this.filter,
      pending: this.queue.length,
      delivered: this.delivered,
      dropped: this.dropped,
      errors: this.errors,
    };
  }

  unsubscribe(): void {
    this.bus._remove(this);
  }
}

export class EventBus {
  readonly bufferSize: number;
  readonly maxQueuePerSubscriber: number;

  #subs = new Set<Subscriber>();
  #buffer: RuntimeEvent[] = [];
  #emitted = 0;
  #delivered = 0;
  #dropped = 0;
  #handlerErrors = 0;
  #onHandlerError: EventBusOptions["onHandlerError"];

  constructor(options: EventBusOptions = {}) {
    this.bufferSize = Math.max(0, options.bufferSize ?? DEFAULT_BUFFER);
    this.maxQueuePerSubscriber = Math.max(1, options.maxQueuePerSubscriber ?? DEFAULT_QUEUE);
    this.#onHandlerError = options.onHandlerError;
  }

  /**
   * Publica um evento. Devolve a versão REDIGIDA — é exatamente o que os
   * assinantes veem, então quem quiser persistir persiste isto e não o cru.
   */
  emit<P = Record<string, unknown>>(event: RuntimeEvent<P>): RuntimeEvent<P> {
    const safe = redactObject(event);
    this.#emitted += 1;

    if (this.bufferSize > 0) {
      this.#buffer.push(safe as RuntimeEvent);
      if (this.#buffer.length > this.bufferSize) {
        this.#buffer.splice(0, this.#buffer.length - this.bufferSize);
      }
    }

    for (const sub of this.#subs) {
      if (eventMatchesFilter(safe as RuntimeEvent, sub.filter)) {
        sub.push(safe as RuntimeEvent);
      }
    }
    return safe;
  }

  /** Açúcar: monta o `RuntimeEvent` com timestamp do runtime e emite. */
  publish<P extends Record<string, unknown>>(
    name: EventName,
    init: { session_id?: string | null; action_id?: string | null; source?: string; payload?: P },
  ): RuntimeEvent<P> {
    return this.emit<P>({
      timestamp: nowIso(),
      session_id: init.session_id ?? null,
      action_id: init.action_id ?? null,
      source: init.source ?? "runtime",
      event: name,
      payload: (init.payload ?? ({} as P)),
    });
  }

  /** Assina um evento nomeado ou `*`. Devolve a função de cancelamento. */
  on<P = Record<string, unknown>>(name: EventSelector, handler: EventHandler<P>): () => void {
    const filter: SubscriptionFilter = name === "*" ? {} : { events: [name] };
    const sub = this.#create(filter, handler as EventHandler<never>, name);
    return () => sub.unsubscribe();
  }

  /** Remove o par (seletor, handler). Devolve true se removeu algo. */
  off<P = Record<string, unknown>>(name: EventSelector, handler: EventHandler<P>): boolean {
    let removed = false;
    for (const sub of [...this.#subs]) {
      if (sub.selector === name && sub.handler === (handler as unknown as EventHandler<never>)) {
        this._remove(sub);
        removed = true;
      }
    }
    return removed;
  }

  /** Assinatura com filtro por sessão e/ou lista de eventos. */
  subscribe<P = Record<string, unknown>>(
    filter: SubscriptionFilter,
    handler: EventHandler<P>,
  ): Subscription {
    return this.#create({ ...filter }, handler as EventHandler<never>, null);
  }

  #create(filter: SubscriptionFilter, handler: EventHandler<never>, selector: EventSelector | null): Subscriber {
    const sub = new Subscriber(newId("sub"), filter, handler, this.maxQueuePerSubscriber, this, selector);
    this.#subs.add(sub);
    return sub;
  }

  /** Eventos retidos, do mais antigo ao mais novo. Para cliente que reconecta. */
  history(query: HistoryQuery = {}): RuntimeEvent[] {
    let out = this.#buffer.filter((e) => eventMatchesFilter(e, query));
    if (query.since !== undefined) {
      const since = Date.parse(query.since);
      if (Number.isNaN(since)) {
        throw new Error(`eventbus: history.since inválido: ${query.since}`);
      }
      out = out.filter((e) => {
        const t = Date.parse(e.timestamp);
        return Number.isNaN(t) ? false : t > since;
      });
    }
    if (query.limit !== undefined && query.limit >= 0 && out.length > query.limit) {
      out = out.slice(out.length - query.limit);
    }
    return out;
  }

  /** Resolve quando TODAS as filas estiverem drenadas. Condição verificável, não sleep. */
  async drain(): Promise<void> {
    for (let round = 0; round < DRAIN_ROUNDS; round += 1) {
      const busy = [...this.#subs].filter((s) => s.running || s.queue.length > 0);
      if (busy.length === 0) return;
      await Promise.all(busy.map((s) => s.idle()));
    }
    throw new Error("eventbus: drain não convergiu — handler provavelmente emite em laço");
  }

  stats(): EventBusStats {
    return {
      emitted: this.#emitted,
      delivered: this.#delivered,
      dropped: this.#dropped,
      handler_errors: this.#handlerErrors,
      buffered: this.#buffer.length,
      buffer_capacity: this.bufferSize,
      subscribers: this.#subs.size,
      per_subscriber: [...this.#subs].map((s) => s.stats()),
    };
  }

  /** Esvazia o buffer circular. Não mexe em assinantes. */
  clearBuffer(): void {
    this.#buffer = [];
  }

  /** Cancela todos os assinantes e esvazia o buffer. */
  close(): void {
    for (const sub of [...this.#subs]) this._remove(sub);
    this.#buffer = [];
  }

  // ── internos usados pelo Subscriber ────────────────────────────────────────
  /** @internal */
  _remove(sub: Subscriber): void {
    sub.active = false;
    sub.queue = [];
    this.#subs.delete(sub);
  }
  /** @internal */
  _countDelivered(): void {
    this.#delivered += 1;
  }
  /** @internal */
  _countDrop(): void {
    this.#dropped += 1;
  }
  /** @internal */
  _countHandlerError(error: unknown, event: RuntimeEvent, subscriberId: string): void {
    this.#handlerErrors += 1;
    if (this.#onHandlerError !== undefined) {
      try {
        this.#onHandlerError(error, event, subscriberId);
      } catch {
        // Se o próprio relator de erro falha, não há para onde escalar sem
        // recursão infinita. O contador acima preserva a evidência em stats().
      }
    }
  }
}

/** Instância compartilhada do processo. Módulos que não injetam bus usam esta. */
export const runtimeBus = new EventBus();
