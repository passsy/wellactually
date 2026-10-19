/**
 * A registry that only takes ratings, for the trials of this run.
 *
 * Every injection invites the agent to rate the advice. Against an address
 * nobody listens on, or with reporting off, the rating fails and the agent is
 * told so, and some agents then tell the user, which a check counts against
 * the framing. Users who installed the plugin get "Recorded up. Thank you."
 * instead, so the trials do too. Each trial's board carries its own token, so
 * a rating lands in the trial that sent it, as ratings.json.
 */

import { randomBytes } from 'node:crypto';
import { appendFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

const trials = new Map<string, string>();
let started: Promise<string> | null = null;

/** The registry's address and a token whose ratings land in `runDir`. */
export async function registryFor(runDir: string): Promise<{ url: string; token: string }> {
  const token = randomBytes(16).toString('hex');
  trials.set(token, runDir);
  return { url: await (started ??= start()), token };
}

function start(): Promise<string> {
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const token = (request.headers.authorization ?? '').replace(/^Bearer /, '');
      const runDir = trials.get(token);
      if (request.method === 'POST' && request.url === '/api/ratings' && runDir) {
        appendFileSync(join(runDir, 'ratings.jsonl'), `${body}\n`);
        response.writeHead(200, { 'content-type': 'application/json' }).end('{}');
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not found"}');
    });
  });
  // Trials should not keep the run alive once they are done.
  server.unref();
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      resolve(`http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`);
    });
  });
}
