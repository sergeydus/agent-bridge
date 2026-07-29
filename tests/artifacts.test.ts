import assert from 'node:assert/strict';
import test from 'node:test';

import { patchApplicationRefusalReason } from '../src/artifacts.ts';

test('refuses to auto-apply legacy patches without a recorded base revision', async () => {
  assert.match(
    (await patchApplicationRefusalReason({
      repository: '/path/that/must/not/be-read',
      patchPath: '/path/that/must/not/be-read.patch',
    })) ?? '',
    /predates base-revision tracking/,
  );
});
