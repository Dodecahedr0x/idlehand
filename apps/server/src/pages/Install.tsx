import type { FC } from 'hono/jsx';
import type { Me } from '@idlehand/shared';
import { Layout } from './Layout.tsx';
import { archiveName, CLI_RELEASE_BASE, CLI_TARGETS, installCommands, loginCommand } from '../cli-release.ts';

export const Install: FC<{ me: Me | null; baseUrl: string }> = ({ me, baseUrl }) => {
  const INSTALL = installCommands();
  const LOGIN = loginCommand(baseUrl);
  return (
    <Layout me={me} title="Install the CLI">
      <div class="page-heading">
        <span class="eyebrow">On your own machine</span>
        <h1>Install your local runner.</h1>
        <p class="lead">Download the Idlehand CLI for macOS or Linux, then connect it to this server.</p>
      </div>
      <section class="section panel" aria-labelledby="install-title">
        <h2 id="install-title">1. Check the prerequisites</h2>
        <p>On macOS or Linux, install <a href="https://git-scm.com/downloads">Git</a> and the <a href="https://cli.github.com">GitHub CLI</a>. Idlehand runs <code>gh auth login</code> itself when you start a run or <code>idlehand dev</code>. Install and sign in to Claude Code, Codex, or the <a href="https://cursor.com/docs/cli/overview">Cursor CLI</a> on the same machine. You do not need Bun to install the published binary.</p>
        <p>Linux also requires <a href="https://github.com/containers/bubblewrap">bubblewrap</a> (<code>bwrap</code>) and enabled user namespaces. On Debian or Ubuntu, install it with <code>sudo apt install bubblewrap</code>. macOS uses its built-in <code>sandbox-exec</code>. Verification stops if the sandbox cannot start.</p>
        <p class="fine-print">Verification commands can use the public internet to install declared dependencies. They have no personal credentials and no access to your home directory. On macOS they cannot contact localhost.</p>
        <h2>2. Download Idlehand</h2>
        <p>Run these commands in your terminal. They download the published Bun binary for your machine, verify its SHA-256 checksum, and install it. No source build is required.</p>
        <div class="command"><pre><code>{INSTALL}</code></pre><button class="btn small" type="button" data-copy={INSTALL} aria-label="Copy installation commands">Copy</button></div>
        <p class="fine-print">Archives: {CLI_TARGETS.map((t, i) => <>{i ? ', ' : ''}<a href={`${CLI_RELEASE_BASE}/${archiveName(t.id)}`}>{t.label}</a></>)}. Checksums: <a href={`${CLI_RELEASE_BASE}/SHA256SUMS`}>SHA256SUMS</a>. The PATH command applies to this terminal session. Add <code>export PATH="$HOME/.local/bin:$PATH"</code> to your shell profile to make <code>idlehand</code> available in new terminals.</p>
        <h2>3. Connect and check your setup</h2>
        <p>Connect this machine to <strong>this</strong> Idlehand server, then run <code>idlehand doctor</code> and refresh the dashboard.</p>
        <div class="command"><code>{LOGIN}</code><button class="btn small" type="button" data-copy={LOGIN} aria-label="Copy CLI login command">Copy</button></div>
        <div class="command"><code>idlehand doctor</code><button class="btn small" type="button" data-copy="idlehand doctor" aria-label="Copy setup check command">Copy</button></div>
        <p>Preview the queue before your first contribution. Claude dollar budgets use an estimated spending threshold; in-flight calls can exceed it, so leave headroom. Codex and the Cursor CLI report estimated spending with no dollar cap and require a task, time, or remaining budget.</p>
      </section>
    </Layout>
  );
};
