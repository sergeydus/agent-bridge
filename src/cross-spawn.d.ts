declare module 'cross-spawn' {
  import { spawn as nodeSpawn } from 'node:child_process';

  const spawn: typeof nodeSpawn;
  export default spawn;
}
