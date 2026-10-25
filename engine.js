class StockfishClient {
  #workerUrl; #init; #worker = null; #jobs = new Map(); #nextId = 0;

  constructor({ engine, workerUrl }) {
    this.#workerUrl = workerUrl;
    this.#init = { engine, options: { Hash: 16 } };
  }

  analyze(request) {
    if (!this.#worker) this.#spawn();
    const id = ++this.#nextId;
    return new Promise((resolve, reject) => {
      this.#jobs.set(id, { resolve, reject });
      this.#worker.postMessage({ type: 'analyze', id, fen: request.fen, depth: 15 });
    });
  }

  #spawn() {
    this.#worker = new Worker(this.#workerUrl);
    this.#worker.onmessage = (ev) => {
      const msg = ev.data;
      if (msg && msg.type === 'result') {
        const job = this.#jobs.get(msg.id);
        if (job) { this.#jobs.delete(msg.id); job.resolve(msg); }
      }
    };
    this.#worker.postMessage({ type: 'init', config: this.#init });
  }
}

const engine = new StockfishClient({
  workerUrl: 'worker.js', 
  engine: { wasm: 'stockfish.js' } 
});

window.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'ANALYZE') {
    engine.analyze({ fen: event.data.fen })
      .then(result => {
        window.parent.postMessage({ type: 'BEST_MOVE', bestMove: result.bestMove }, '*');
      })
      .catch(err => {
        // Silently catch AbortErrors so the iframe doesn't crash on fast moves!
        console.log("[Engine Iframe] Analysis superseded by a newer move.");
      });
  }
});