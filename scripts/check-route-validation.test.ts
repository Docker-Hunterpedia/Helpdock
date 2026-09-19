import { describe, expect, it } from 'vitest';
import { findUnvalidatedParameters } from './check-route-validation.ts';

const scan = (source: string) =>
  findUnvalidatedParameters({ file: 'apps/api/src/fixture.ts', source });

const finding = (handler: string, decorator: string, argument: string) => ({
  file: 'apps/api/src/fixture.ts',
  className: 'C',
  handler,
  decorator,
  argument,
});

describe('findUnvalidatedParameters', () => {
  it.each([
    ['the whole object', '@Param(new ZodValidationPipe(BrandIdParamDto)) params: BrandIdParamDto'],
    ['a named key', "@Param('id', new ZodValidationPipe(idSchema)) id: string"],
    [
      'a raw schema rather than a DTO',
      '@Body(new ZodValidationPipe(setupSmtpRequestSchema)) body: SetupSmtpRequest',
    ],
  ])('accepts a parameter that names its schema for %s', (_form, parameter) => {
    expect(
      scan(`
        @Controller('api')
        class C {
          @Get('a')
          read(${parameter}) { return 1; }
        }
      `),
    ).toEqual([]);
  });

  it('reports a bare @Param(), which is what issue #36 was', () => {
    expect(
      scan(`
        @Controller('api')
        class C {
          @Get('brands/:brandId')
          find(@Param() { brandId }: BrandIdParamDto) { return brandId; }
        }
      `),
    ).toEqual([finding('find', 'Param', '')]);
  });

  it.each([
    ['Param', "@Param('token') token: string", "'token'"],
    ['Query', "@Query('code') code: string", "'code'"],
    ['Body', '@Body() body: unknown', ''],
  ])('reports an unvalidated @%s', (decorator, parameter, argument) => {
    expect(
      scan(`
        @Controller('api')
        class C {
          @Post('a')
          act(${parameter}) { return 1; }
        }
      `),
    ).toEqual([finding('act', decorator, argument)]);
  });

  it('reports every unvalidated parameter of one handler, and only those', () => {
    const findings = scan(`
      @Controller('api')
      class C {
        @Get('oauth/:provider/callback')
        callback(
          @Param('provider') provider: string,
          @Query(new ZodValidationPipe(CallbackQueryDto)) query: CallbackQueryDto,
          @Req() request: FastifyRequest,
          @Res() reply: FastifyReply,
        ) { return provider; }
      }
    `);

    expect(findings).toEqual([finding('callback', 'Param', "'provider'")]);
  });

  it('ignores parameters that carry no input, such as @Req and @Res', () => {
    expect(
      scan(`
        @Controller()
        class C {
          @Get('ready')
          ready(@Res({ passthrough: true }) reply: FastifyReply) { return reply; }
        }
      `),
    ).toEqual([]);
  });

  it('ignores a constructor, which is not a route', () => {
    expect(
      scan(`
        @Controller()
        class C {
          constructor(@Inject(BODY) private readonly body: Body) {}
        }
      `),
    ).toEqual([]);
  });

  it('ignores a method with no route decorator', () => {
    expect(
      scan(`
        @Controller()
        class C {
          helper(@Param() params: unknown) { return params; }
        }
      `),
    ).toEqual([]);
  });

  it('ignores a class that is not a controller', () => {
    expect(
      scan(`
        @Injectable()
        class C {
          @Get('not-a-route')
          list(@Query() query: unknown) { return query; }
        }
      `),
    ).toEqual([]);
  });

  /**
   * A gateway's payload is typed `unknown` and parsed inside the handler with
   * `parseMessage(schema, body)`, because a pipe cannot answer through an
   * acknowledgement. `@MessageBody()` is therefore not this check's business.
   */
  it('ignores a websocket gateway', () => {
    expect(
      scan(`
        @WebSocketGateway({ namespace: '/staff' })
        class C {
          @SubscribeMessage('room:join')
          join(@MessageBody() body: unknown) { return body; }
        }
      `),
    ).toEqual([]);
  });

  it('is not fooled by the pipe’s name in a comment or a string', () => {
    expect(
      scan(`
        @Controller()
        class C {
          @Get('a')
          // new ZodValidationPipe(Dto) was removed on purpose
          a(@Query('q') q = 'new ZodValidationPipe(Dto)') { return q; }
        }
      `),
    ).toEqual([finding('a', 'Query', "'q'")]);
  });

  it('does not read a handler’s own decorators as its parameters’', () => {
    expect(
      scan(`
        @Controller()
        class C {
          @Get('a')
          @ZodSerializerDto(ADto)
          a() { return 1; }

          @Get('b')
          b(@Body() body: unknown) { return body; }
        }
      `),
    ).toEqual([finding('b', 'Body', '')]);
  });

  it('keeps two controllers in one file apart', () => {
    const findings = findUnvalidatedParameters({
      file: 'apps/api/src/fixture.ts',
      source: `
        @Controller('a')
        class A {
          @Get() one(@Query() query: unknown) { return query; }
        }

        @Controller('b')
        class B {
          @Get() two(@Query(new ZodValidationPipe(QDto)) query: QDto) { return query; }
        }
      `,
    });

    expect(findings.map((item) => item.className)).toEqual(['A']);
  });

  it('handles a file with no classes at all', () => {
    expect(scan('export const answer = 42;\n')).toEqual([]);
  });

  /**
   * The same regression `check-route-permissions.test.ts` carries: a CSS colour
   * inside a template used to be scanned as a private identifier that consumed
   * nothing, and the checker looped until it ran out of memory (M0-05). Both
   * checks walk the one scanner now, and both prove it here.
   */
  it('reads a template literal as one span, not as code with a brace in it', () => {
    expect(
      scan(`
        @Controller()
        class C {
          css(locale: string): string {
            return \`<p lang="\${locale}" style="color:#1b1f24">{ }</p>\`;
          }

          @Get('x')
          x(@Body() body: unknown) { return body; }
        }
      `),
    ).toEqual([finding('x', 'Body', '')]);
  });
});
