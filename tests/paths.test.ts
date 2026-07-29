import assert from 'node:assert/strict';
import test from 'node:test';

import { applicationDataRoot, getAppPaths } from '../src/paths.ts';

test('uses platform application-data locations', () => {
  assert.equal(
    applicationDataRoot({ platform: 'darwin', home: '/Users/test', env: {} }),
    '/Users/test/Library/Application Support/Agent Bridge',
  );
  assert.equal(
    applicationDataRoot({ platform: 'linux', home: '/home/test', env: {} }),
    '/home/test/.local/state/agent-bridge',
  );
  assert.equal(
    applicationDataRoot({
      platform: 'linux',
      home: '/home/test',
      env: { XDG_STATE_HOME: '/state' },
    }),
    '/state/agent-bridge',
  );
});

test('supports an isolated application-data override', () => {
  const paths = getAppPaths({
    env: { AGENT_BRIDGE_HOME: '/tmp/custom-bridge' },
  });
  assert.equal(paths.root, '/tmp/custom-bridge');
  assert.equal(paths.configFile, '/tmp/custom-bridge/config.json');
  assert.equal(paths.stateDirectory, '/tmp/custom-bridge/runs/state');
  assert.equal(paths.chatsDirectory, '/tmp/custom-bridge/chats');
});
