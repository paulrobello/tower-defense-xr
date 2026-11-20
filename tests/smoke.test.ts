import { describe, expect, it } from 'vitest';
import { APP_NAME } from '../src/main.ts';

describe('scaffold smoke', () => {
  it('exports application name', () => {
    expect(APP_NAME).toBe('Rift Bastion');
  });
});
