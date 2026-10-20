import { type DynamicModule, Module } from '@nestjs/common';
import { KeyboardController } from './keyboard.controller.js';
import { KeyboardRepository } from './keyboard.repository.js';

/** M14-01: a person's keyboard settings, `/api/me/keyboard`. */
@Module({})
// biome-ignore lint/complexity/noStaticOnlyClass: a Nest module is a decorated class; `forRoot` is the framework's own shape for a dynamic one.
export class KeyboardModule {
  static forRoot(): DynamicModule {
    return {
      module: KeyboardModule,
      controllers: [KeyboardController],
      providers: [{ provide: KeyboardRepository, useFactory: () => new KeyboardRepository() }],
    };
  }
}
