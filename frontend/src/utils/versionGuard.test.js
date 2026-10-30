import { describe, expect, it } from 'vitest';
import { applyVersioned } from './versionGuard';

describe('applyVersioned', () => {
  it('takes the incoming value when nothing is cached', () => expect(applyVersioned(undefined, { version: 1 })).toEqual({ version: 1 }));
  it('ignores stale and equal versions', () => {
    expect(applyVersioned({ version: 5, a: 1 }, { version: 4, a: 2 })).toEqual({ version: 5, a: 1 });
    expect(applyVersioned({ version: 5, a: 1 }, { version: 5, a: 2 })).toEqual({ version: 5, a: 1 });
  });
  it('applies newer versions', () => expect(applyVersioned({ version: 5 }, { version: 6 })).toEqual({ version: 6 }));
});
