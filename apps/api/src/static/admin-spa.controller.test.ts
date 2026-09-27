import { NotFoundException } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { AdminSpaController, type HostPages } from './admin-spa.controller.js';
import type { InstallInfoService } from './install-info.service.js';

const request = (url: string, host = 'help.acme.test') =>
  ({ url, headers: { host } }) as unknown as FastifyRequest;
const reply = {} as FastifyReply;
const installInfo = {} as InstallInfoService;

describe('AdminSpaController and a brand’s host (M5-03)', () => {
  it('hands a help center host’s pages to the help center', async () => {
    const pages: HostPages = {
      serves: vi.fn(() => Promise.resolve(true)),
      serve: vi.fn(() => Promise.resolve()),
    };
    const controller = new AdminSpaController(undefined, installInfo, pages);

    await controller.serve(request('/en/articles/refunds'), reply);

    expect(pages.serve).toHaveBeenCalledOnce();
  });

  it('keeps an unknown /api path a 404 on every host', async () => {
    const pages: HostPages = {
      serves: vi.fn(() => Promise.resolve(true)),
      serve: vi.fn(() => Promise.resolve()),
    };
    const controller = new AdminSpaController(undefined, installInfo, pages);

    await expect(controller.serve(request('/api/nothing'), reply)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(pages.serves).not.toHaveBeenCalled();
  });

  it('serves the admin, as before, on a host that is no help center', async () => {
    const pages: HostPages = {
      serves: vi.fn(() => Promise.resolve(false)),
      serve: vi.fn(() => Promise.resolve()),
    };
    const controller = new AdminSpaController(undefined, installInfo, pages);

    await expect(controller.serve(request('/tickets', 'desk.acme.test'), reply)).rejects.toThrow(
      'This process serves no admin build',
    );
    expect(pages.serve).not.toHaveBeenCalled();
  });
});
