import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { applicationDataRoot, getAppPaths } from '../src/paths.ts';

test('uses platform application-data locations', () => {
  assert.equal(
    applicationDataRoot({ platform: 'darwin', home: '/Users/test', env: {} }),
    join('/Users/test', 'Library', 'Application Support', 'Agent Bridge'),
  );
  assert.equal(
    applicationDataRoot({ platform: 'linux', home: '/home/test', env: {} }),
    join('/home/test', '.local', 'state', 'agent-bridge'),
  );
  assert.equal(
    applicationDataRoot({
      platform: 'linux',
      home: '/home/test',
      env: { XDG_STATE_HOME: '/state' },
    }),
    join('/state', 'agent-bridge'),
  );
});

test('supports an isolated application-data override', () => {
  const root = join(tmpdir(), 'custom-bridge');
  const paths = getAppPaths({
    env: { AGENT_BRIDGE_HOME: root },
  });
  assert.equal(paths.root, root);
  assert.equal(paths.configFile, join(root, 'config.json'));
  assert.equal(paths.stateDirectory, join(root, 'runs', 'state'));
  assert.equal(paths.chatsDirectory, join(root, 'chats'));
});
