import { config } from './config.js';
import { eventStream } from './opencode.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class EventLog {
  #buffer = [];
  #limit;
  #running = false;
  #controller = null;
  #lastError = null;

  constructor(limit = config.eventBuffer) {
    this.#limit = limit;
  }

  get running() {
    return this.#running;
  }

  get lastError() {
    return this.#lastError;
  }

  get size() {
    return this.#buffer.length;
  }

  start() {
    if (this.#running) return;
    this.#running = true;
    void this.#loop();
  }

  stop() {
    this.#running = false;
    this.#controller?.abort();
  }

  async #loop() {
    while (this.#running) {
      this.#controller = new AbortController();
      try {
        for await (const event of eventStream(this.#controller.signal)) {
          this.#lastError = null;
          this.push(event);
        }
      } catch (error) {
        if (!this.#running || error.name === 'AbortError') return;
        this.#lastError = error.message;
        console.error(`[events] stream unavailable: ${error.message}`);
      }
      if (this.#running) await sleep(3000);
    }
  }

  push(event) {
    if (!event || typeof event !== 'object') return;
    const entry = {
      id: event.id,
      type: event.type || 'unknown',
      time: typeof event.created === 'number' ? event.created : Date.now(),
      data: event.data ?? {},
      location: event.location?.directory,
    };
    this.#buffer.push(entry);
    if (this.#buffer.length > this.#limit) {
      this.#buffer.splice(0, this.#buffer.length - this.#limit);
    }
  }

  recent(limit = 30) {
    const count = Math.max(1, Math.min(Number(limit) || 30, this.#limit));
    return this.#buffer.slice(-count);
  }
}
