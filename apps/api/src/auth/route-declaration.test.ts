import type { ExecutionContext } from '@nestjs/common';
import { Controller, Get } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { Authenticated, Public, Requires, routeDeclarationOf } from './route-declaration.js';

@Controller()
class MixedController {
  @Get('open')
  @Public()
  open(): string {
    return 'open';
  }

  @Get('me')
  @Authenticated()
  me(): string {
    return 'me';
  }

  @Get('brand')
  @Requires('brand:read')
  brand(): string {
    return 'brand';
  }

  @Get('undeclared')
  undeclared(): string {
    return 'undeclared';
  }
}

@Controller()
@Requires('install:admin')
class InstallController {
  @Get('a')
  a(): string {
    return 'a';
  }

  @Get('b')
  @Public()
  b(): string {
    return 'b';
  }
}

const reflector = new Reflector();

/** The two things `Reflector.getAllAndOverride` reads: the method, then its class. */
const declarationOf = (controller: new () => unknown, handler: string) =>
  routeDeclarationOf(reflector, {
    getHandler: () => (controller.prototype as Record<string, unknown>)[handler],
    getClass: () => controller,
  } as unknown as ExecutionContext);

describe('route declaration metadata', () => {
  it('records what each decorator means', () => {
    expect(declarationOf(MixedController, 'open')).toEqual({ kind: 'public' });
    expect(declarationOf(MixedController, 'me')).toEqual({ kind: 'authenticated' });
    expect(declarationOf(MixedController, 'brand')).toEqual({
      kind: 'permission',
      permission: 'brand:read',
    });
  });

  it('is undefined for a handler nobody declared', () => {
    expect(declarationOf(MixedController, 'undeclared')).toBeUndefined();
  });

  it('falls back to the controller when the handler is silent', () => {
    expect(declarationOf(InstallController, 'a')).toEqual({
      kind: 'permission',
      permission: 'install:admin',
    });
  });

  it('lets a handler override its controller', () => {
    expect(declarationOf(InstallController, 'b')).toEqual({ kind: 'public' });
  });
});
