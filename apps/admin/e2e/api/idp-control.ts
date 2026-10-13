import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { z } from 'zod';

const identitySchema = z.object({
  subject: z.string().min(1).max(300),
  email: z.email(),
  groups: z.array(z.string().min(1).max(300)).max(100),
});

/** Loopback stand-in control only; never mounted by Helpdock or any real IdP. */
export function idpControl(update: (identity: z.infer<typeof identitySchema>) => void) {
  const key = randomBytes(32).toString('base64url');
  return {
    key,
    async serve(request: IncomingMessage, reply: ServerResponse): Promise<boolean> {
      if (request.url !== '/__fixture/identity') return false;
      if (request.method !== 'POST' || request.headers.authorization !== `Bearer ${key}`) {
        reply.writeHead(403).end();
        return true;
      }
      let body = '';
      for await (const chunk of request) {
        body += String(chunk);
        if (body.length > 32_768) {
          reply.writeHead(413).end();
          return true;
        }
      }
      try {
        update(identitySchema.parse(JSON.parse(body)));
        reply.writeHead(204).end();
      } catch {
        reply.writeHead(400).end();
      }
      return true;
    },
  };
}
