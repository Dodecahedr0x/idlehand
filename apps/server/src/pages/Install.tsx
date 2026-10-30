import type { FC } from 'hono/jsx';
import type { Me } from '@idlehand/shared';
import { Layout } from './Layout.tsx';

const INSTALL = `git clone https://github.com/Dodecahedr0x/idlehand.git
cd idlehand
bun install
bun run --cwd apps/cli build
mkdir -p "$HOME/.local/bin"
cp apps/cli/dist/idlehand "$HOME/.local/bin/idlehand"
export PATH="$HOME/.local/bin:$PATH"`;

export const Install: FC<{ me: Me | null }> = ({ me }) => (
  <Layout me={me} title="Install the CLI">
    <div class="page-heading">
      <span class="eyebrow">On your own machine</span>
      <h1>Install your local runner.</h1>
      <p class="lead">Build Idlehand from source, then connect it to your dashboard.</p>
    </div>
    <section class="section panel" aria-labelledby="install-title">
      <h2 id="install-title">1. Check the prerequisites</h2>
      <p>On macOS or Linux, install <a href="https://git-scm.com/downloads">Git</a>, <a href="https://bun.sh">Bun</a>, and the <a href="https://cli.github.com">GitHub CLI</a>. Run <code>gh auth login</code>. Install and sign in to Claude Code or Codex on the same machine.</p>
      <p>Linux also requires <a href="https://github.com/containers/bubblewrap">bubblewrap</a> (<code>bwrap</code>) and enabled user namespaces. On Debian or Ubuntu, install it with <code>sudo apt install bubblewrap</code>. macOS uses its built-in <code>sandbox-exec</code>. Verification stops if the sandbox cannot start.</p>
      <p class="fine-print">Verification commands run without network access, personal credentials, or access to your home directory. Dependencies must be prepared inside the contribution checkout; verification setup cannot download packages.</p>
      <h2>2. Build and install Idlehand</h2>
      <p>Run these commands in your terminal. They download the <a href="https://github.com/Dodecahedr0x/idlehand">Idlehand source repository</a> and build a binary for your machine.</p>
      <div class="command"><pre><code>{INSTALL}</code></pre><button class="btn small" type="button" data-copy={INSTALL} aria-label="Copy installation commands">Copy</button></div>
      <p class="fine-print">The PATH command applies to this terminal session. Add <code>export PATH="$HOME/.local/bin:$PATH"</code> to your shell profile to make <code>idlehand</code> available in new terminals. If you already have the source, start with <code>bun install</code> in that checkout.</p>
      <h2>3. Connect and check your setup</h2>
      <p><a href="/dashboard#setup-title">Return to your dashboard</a> for your server’s login command. After signing in, run <code>idlehand doctor</code>, then refresh the dashboard to confirm the connection.</p>
      <p>Preview the queue before your first contribution. Claude dollar budgets use an estimated spending threshold; in-flight calls can exceed it, so leave headroom. Codex reports estimated spending with no dollar cap and requires a task, time, or remaining budget.</p>
    </section>
  </Layout>
);
