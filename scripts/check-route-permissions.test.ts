import { describe, expect, it } from 'vitest';
import { findUndeclaredRoutes } from './check-route-permissions.ts';

const scan = (source: string) => findUndeclaredRoutes({ file: 'apps/api/src/fixture.ts', source });

describe('the scanner', () => {
  it('reads a template literal as one span, not as code with a brace in it', () => {
    // A CSS colour inside a template used to be scanned as a private
    // identifier that consumed nothing, and the checker looped until it ran
    // out of memory (M0-05).
    const source = `
      @Controller()
      class Styles {
        css(locale: string): string {
          return \`<p lang="\${locale}" style="color:#1b1f24">{ }</p>\`;
        }

        @Get('x')
        @Public()
        route(): void {}
      }
    `;

    expect(findUndeclaredRoutes({ file: 'styles.ts', source })).toEqual([]);
  });
});

describe('findUndeclaredRoutes', () => {
  it('accepts a handler that declares a permission', () => {
    expect(
      scan(`
        @Controller('api')
        export class BrandsController {
          @Get('brands/:brandId')
          @Requires('brand:read')
          find(@Param() params: BrandIdParamDto) { return params; }
        }
      `),
    ).toEqual([]);
  });

  it.each(['@Public()', '@Authenticated()', "@Requires('ticket:read')"])(
    'accepts %s',
    (declaration) => {
      expect(
        scan(`
          @Controller()
          class C {
            @Get('x')
            ${declaration}
            read() { return 1; }
          }
        `),
      ).toEqual([]);
    },
  );

  it('reports a handler that declares nothing', () => {
    expect(
      scan(`
        @Controller('api')
        export class TicketsController {
          @Get('tickets')
          list() { return []; }
        }
      `),
    ).toEqual([
      {
        file: 'apps/api/src/fixture.ts',
        className: 'TicketsController',
        handler: 'list',
        route: 'Get',
      },
    ]);
  });

  it('reports every undeclared handler, and only those', () => {
    const undeclared = scan(`
      @Controller('api')
      class C {
        @Get('a') @Public() a() { return 1; }
        @Post('b') b() { return 2; }
        @Delete('c') c() { return 3; }
        @Patch('d') @Requires('ticket:write') d() { return 4; }
      }
    `);

    expect(undeclared.map((route) => route.handler)).toEqual(['b', 'c']);
    expect(undeclared.map((route) => route.route)).toEqual(['Post', 'Delete']);
  });

  it('accepts a controller that declares once for all of its handlers', () => {
    expect(
      scan(`
        @Controller('internal')
        @Requires('install:admin')
        class C {
          @Get('a') a() { return 1; }
          @Get('b') b() { return 2; }
        }
      `),
    ).toEqual([]);
  });

  it('ignores a class that is not a controller', () => {
    expect(
      scan(`
        @Injectable()
        class BrandsService {
          @Get('not-a-route')
          list() { return []; }
        }
      `),
    ).toEqual([]);
  });

  it('ignores a method with no HTTP decorator', () => {
    expect(
      scan(`
        @Controller()
        class C {
          constructor(@Inject(DB) db: Db) {}
          private helper() { return 1; }
        }
      `),
    ).toEqual([]);
  });

  it('is not fooled by a decorator name in a comment or a string', () => {
    expect(
      scan(`
        @Controller()
        class C {
          // @Requires('ticket:read') was removed on purpose
          @Get('a')
          a() { return '@Public()'; }
        }
      `),
    ).toEqual([{ file: 'apps/api/src/fixture.ts', className: 'C', handler: 'a', route: 'Get' }]);
  });

  it('does not credit a handler for a decorator inside another one’s arguments', () => {
    expect(
      scan(`
        @Controller()
        class C {
          @UseInterceptors(wrap(Public()))
          @Get('a')
          a() { return 1; }
        }
      `),
    ).toEqual([{ file: 'apps/api/src/fixture.ts', className: 'C', handler: 'a', route: 'Get' }]);
  });

  it('does not credit a handler for a parameter decorator on the one before it', () => {
    expect(
      scan(`
        @Controller()
        class C {
          @Get('a') @Public() a(@Param('id') id: string) { return id; }
          @Get('b') b() { return 2; }
        }
      `),
    ).toEqual([{ file: 'apps/api/src/fixture.ts', className: 'C', handler: 'b', route: 'Get' }]);
  });

  it('does not mistake an object key inside a method body for a handler', () => {
    expect(
      scan(`
        @Controller()
        class C {
          @Get('a')
          @Public()
          a() {
            const handlers = { list() { return 1; } };
            return handlers.list();
          }
        }
      `),
    ).toEqual([]);
  });

  it('keeps two controllers in one file apart', () => {
    const undeclared = scan(`
      @Controller('a')
      class A {
        @Get() one() { return 1; }
      }

      @Controller('b')
      @Public()
      class B {
        @Get() two() { return 2; }
      }
    `);

    expect(undeclared).toEqual([
      { file: 'apps/api/src/fixture.ts', className: 'A', handler: 'one', route: 'Get' },
    ]);
  });

  it('handles a file with no classes at all', () => {
    expect(scan('export const answer = 42;\n')).toEqual([]);
  });
});

/**
 * "HTTP/WebSocket guard: role and scope check per route **or event**"
 * (DOMAIN-RULES §1.3). A socket event is a route as far as this check cares.
 */
describe('socket event handlers', () => {
  it('reports a @SubscribeMessage handler that declares nothing', () => {
    expect(
      scan(`
        @WebSocketGateway({ namespace: '/staff' })
        export class StaffGateway {
          @SubscribeMessage('room:join')
          join(@ConnectedSocket() socket: StaffSocket) { return socket.id; }
        }
      `),
    ).toEqual([
      {
        file: 'apps/api/src/fixture.ts',
        className: 'StaffGateway',
        handler: 'join',
        route: 'SubscribeMessage',
      },
    ]);
  });

  it.each(['@Public()', '@Authenticated()', "@Requires('brand:read')"])(
    'accepts a socket event declared with %s',
    (declaration) => {
      expect(
        scan(`
          @WebSocketGateway({ namespace: '/staff' })
          class StaffGateway {
            @SubscribeMessage('room:join')
            ${declaration}
            join() { return 1; }
          }
        `),
      ).toEqual([]);
    },
  );

  it('ignores a decorated gateway member that is not an event handler', () => {
    expect(
      scan(`
        @WebSocketGateway({ namespace: '/staff' })
        class StaffGateway {
          @WebSocketServer()
          namespace!: Namespace;

          afterInit(namespace: Namespace) { return namespace; }
        }
      `),
    ).toEqual([]);
  });

  it('ignores a @SubscribeMessage on a class that is neither controller nor gateway', () => {
    expect(
      scan(`
        @Injectable()
        class NotAGateway {
          @SubscribeMessage('room:join')
          join() { return 1; }
        }
      `),
    ).toEqual([]);
  });
});
