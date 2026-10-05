// Fixtures for `semgrep scan --test`: each `ruleid:` line must be reported by
// that rule and each `ok:` line must not. Never compiled or linted.

// ruleid: helpdock-enqueue-from-request-path
import { Queue } from 'bullmq';

@Controller('things')
class Undeclared {
  // ruleid: helpdock-route-without-declaration
  @Get()
  list() {
    return [];
  }

  // ok: helpdock-route-without-declaration
  @Get(':id')
  @Requires('ticket:read')
  async read() {
    return {};
  }

  // ok: helpdock-route-without-declaration
  @Post()
  @Authenticated()
  create() {
    return {};
  }

  // ok: helpdock-route-without-declaration
  @Post('public')
  @Public()
  open() {
    return {};
  }

  // ok: helpdock-route-without-declaration
  helper() {
    return 1;
  }

  async enqueue(queue: Queue, service: Service) {
    // ruleid: helpdock-enqueue-in-handler
    await queue.add(emailSendJob.name, { id: 1 });
    // ruleid: helpdock-enqueue-in-handler
    await queue.add('email.send', { id: 1 });
    // ok: helpdock-enqueue-in-handler
    await service.add(context, body);
    // ok: helpdock-enqueue-in-handler
    seen.add(1);
  }
}

@Controller('declared')
@Requires('brand:read')
class DeclaredOnTheClass {
  // ok: helpdock-route-without-declaration
  @Get()
  list() {
    return [];
  }
}

@WebSocketGateway({ namespace: '/staff' })
class Gateway {
  // ruleid: helpdock-route-without-declaration
  @SubscribeMessage('room:join')
  async join() {
    return {};
  }
}

const user = async (url: string, token: string, password: string) => {
  // ruleid: helpdock-fetch-non-constant-url
  await fetch(url);
  // ruleid: helpdock-fetch-non-constant-url
  await fetch(`https://${url}/hook`, { method: 'POST' });
  // ok: helpdock-fetch-non-constant-url
  await fetch('https://github.com/login/oauth/access_token');

  // ruleid: helpdock-secret-in-log
  log.info({ userId: 1, password }, 'signed in');
  // ruleid: helpdock-secret-in-log
  logger.warn({ accessToken: token }, 'refresh');
  // ok: helpdock-secret-in-log
  log.info({ userId: 1, hasToken: true }, 'signed in');
};

// ruleid: helpdock-any-without-comment
const loose = (value: any) => value;
// ruleid: helpdock-any-without-comment
const cast = loose(1) as any;
// ok: helpdock-any-without-comment
const commented = loose(2) as any; // Socket.IO's own types do not reach this far.
// ruleid: helpdock-any-without-comment
const annotationIsNoReason = loose(3) as any;
// ok: helpdock-any-without-comment
const sentence = 'This is on: any caller may name itself';
