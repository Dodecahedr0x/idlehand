/** OS-enforced boundary for untrusted setup, reproduction and test commands. */
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { exec, type ExecResult } from './shell.ts';

export async function sandboxedSh(command: string, cwd: string, timeoutMs: number): Promise<ExecResult> {
  const root = realpathSync(cwd);
  const scratch = mkdtempSync(join(root, '.idlehand-sandbox-'));
  // The compiled runner's executable is not Bun. Expose an installed Bun too,
  // without exposing the private tool directory or its credentials.
  const runtimes = [...new Set([process.execPath, Bun.which('bun')].filter((path): path is string => !!path).map((path) => realpathSync(path)))];
  const marker = `idlehand-sandbox-${randomUUID()}\n`;
  // A marker from inside the boundary distinguishes sandbox launch failure from
  // the expected nonzero result of a reproduction. Never fall back to plain sh.
  const shell = ['/bin/sh', '-c', 'printf "%s" "$0"; exec /bin/sh -c "$1"', marker, command];
  const env = {
    PATH: `${runtimes.map((path) => dirname(path)).join(':')}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: scratch, TMPDIR: scratch, TMP: scratch, TEMP: scratch,
    CI: '1', FORCE_COLOR: '0', NO_COLOR: '1', TERM: 'dumb', LANG: 'C',
  };
  try {
    let argv: string[];
    if (process.platform === 'darwin') {
      const subpath = (path: string) => `(subpath ${JSON.stringify(path)})`;
      const profile = [
        '(version 1)', '(deny default)', '(allow process-exec process-fork)',
        '(allow signal (target children))', '(allow sysctl-read)',
        '(allow mach-lookup (global-name "com.apple.system.logger"))',
        `(allow file-read* ${[root, '/System', '/Library', '/usr', '/bin', '/sbin', '/opt/homebrew', '/opt/local', '/dev', '/etc', '/private/etc'].map(subpath).join(' ')} (literal "/") ${runtimes.map((path) => `(literal ${JSON.stringify(path)})`).join(' ')})`,
        `(allow file-read-metadata)`,
        `(allow file-write* ${subpath(root)} (literal "/dev/null"))`,
        '(allow system-socket)',
        '(allow mach-lookup (global-name "com.apple.trustd") (global-name "com.apple.trustd.agent") (global-name "com.apple.securityd") (global-name "com.apple.securityd.xpc") (global-name "com.apple.ocspd") (global-name "com.apple.mDNSResponder") (global-name "com.apple.mDNSResponder.reconfirm") (global-name "com.apple.CoreServices.launchservicesd") (global-name "com.apple.coreservices.launchservicesd") (global-name "com.apple.lsd.mapdb") (global-name "com.apple.distributed_notifications@Uv3") (global-name "com.apple.system.notification_center") (global-name "com.apple.bsd.dirhelper") (global-name "com.apple.system.DirectoryService.libinfo_v1") (global-name "com.apple.system.DirectoryService.membership_v1"))',
        // Public web, git, and DNS only. Other ports, including localhost services, stay closed.
        '(deny network-outbound (remote ip "localhost:*"))',
        '(deny network-outbound (remote tcp "localhost:*"))',
        '(deny network-inbound (local ip "localhost:*"))',
        '(allow network*)',
      ].join('\n');
      argv = ['/usr/bin/sandbox-exec', '-p', profile, ...shell];
    } else if (process.platform === 'linux') {
      const bwrap = ['/usr/bin/bwrap', '/bin/bwrap'].find(existsSync);
      if (!bwrap) throw new Error('install bubblewrap (bwrap) to enable verification');
      argv = [bwrap, '--unshare-user', '--unshare-ipc', '--unshare-pid', '--unshare-uts', '--unshare-cgroup', '--die-with-parent', '--new-session', '--cap-drop', 'ALL'];
      for (const path of ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/opt', '/etc']) {
        if (existsSync(path)) argv.push('--ro-bind', path, path);
      }
      argv.push('--proc', '/proc', '--dev', '/dev');
      // Bun can live in a private tool directory; expose only its executable,
      // never that directory's credentials, configuration or other contents.
      for (const runtime of runtimes) {
        if (!['/usr/', '/bin/', '/sbin/', '/opt/'].some((p) => runtime.startsWith(p))) argv.push('--ro-bind', runtime, runtime);
      }
      argv.push('--bind', root, root, '--chdir', root, ...shell);
    } else {
      throw new Error(`verification sandbox is unsupported on ${process.platform}`);
    }
    let prefix = '';
    let started = false;
    const result = await exec(argv, {
      cwd: root, timeoutMs, env, inheritEnv: false, killProcessGroup: true,
      onOutput(chunk, stream) {
        if (stream === 'stdout' && !started && prefix.length < marker.length) {
          prefix += chunk.slice(0, marker.length - prefix.length);
          started = prefix === marker;
        }
      },
    });
    if (!started) throw new Error(`could not start the enforced sandbox: ${result.stderr.trim() || `exit ${result.code}`}`);
    return { ...result, stdout: result.stdout.startsWith(marker) ? result.stdout.slice(marker.length) : result.stdout };
  } catch (error) {
    throw new Error(`Verification sandbox unavailable: ${(error as Error).message}`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
