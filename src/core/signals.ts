// core/signals.ts — typed event bus.
//
// Modules connect listeners; emitters don't know who's listening. This
// is the same pattern as Django signals: it's how feedback can react to
// an action_completed event without the actions module importing
// feedback. Order of listener invocation is registration order; errors
// in one listener don't stop the others.

import { getLogger } from "./logger.js";

const log = getLogger("signals");

export type Signal<T> = {
  connect(handler: (payload: T) => void | Promise<void>): () => void;
  emit(payload: T): Promise<void>;
  /** Listener count — useful in tests. */
  size(): number;
};

export function createSignal<T>(name: string): Signal<T> {
  const handlers: Array<(p: T) => void | Promise<void>> = [];

  return {
    connect(handler) {
      handlers.push(handler);
      return () => {
        const i = handlers.indexOf(handler);
        if (i !== -1) handlers.splice(i, 1);
      };
    },

    async emit(payload) {
      for (const h of handlers) {
        try {
          await h(payload);
        } catch (err) {
          log.error(
            { err, signal: name },
            "signal handler threw — continuing with remaining handlers",
          );
        }
      }
    },

    size() {
      return handlers.length;
    },
  };
}
