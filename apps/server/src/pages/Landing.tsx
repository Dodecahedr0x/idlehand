import type { FC } from 'hono/jsx';
import type { Me, PopularRepo } from '@idlehand/shared';
import { Layout } from './Layout.tsx';
import { RepoGrid } from './RepoCard.tsx';

export const Landing: FC<{ me: Me | null; popular: PopularRepo[] }> = ({ me, popular }) => (
  <Layout me={me}>
    <section class="hero">
      <div>
        <span class="eyebrow"><span class="status-dot" /> Your machine. A little more useful.</span>
        <h1>Good code.<br />From idle time.</h1>
        <p class="lead">Put your leftover Claude Code or Codex credits to work on open source. Pick a repository, set a budget, and let your local runner lend a hand.</p>
        <div class="actions">
          <a class="btn primary" href={me ? '/dashboard' : '/login'}>{me ? 'Open dashboard' : 'Get started with GitHub'} <span aria-hidden="true">↗</span></a>
          <a class="text-link" href="#how-it-works">How it works <span aria-hidden="true">↓</span></a>
        </div>
        <p class="fine-print">Uses your existing agent subscription. You choose what to spend.</p>
      </div>
      <div class="terminal" aria-label="Example commands for a local run">
        <div class="terminal-bar"><span class="terminal-dots" aria-hidden="true">● ● ●</span><span>your machine / idlehand</span></div>
        <div class="terminal-body">
          <p class="terminal-comment"># Start small. See the plan first.</p>
          <p><span class="prompt">$</span> idlehand run --dry-run</p>
          <div class="terminal-rule" />
          <p class="terminal-comment"># Using Claude? Start with a budget.</p>
          <p><span class="prompt">$</span> idlehand run --provider claude --budget '$2'</p>
          <div class="terminal-note"><span class="status-dot" /> Estimated spending. Leave a little headroom.</div>
        </div>
      </div>
    </section>

    <section id="how-it-works" class="section">
      <div class="section-heading"><div><span class="eyebrow">Small setup. Useful work.</span><h2>From spare credits to contributions.</h2></div><span class="muted">Three steps. On your terms.</span></div>
      <div class="steps">
        <article><span class="step-number">01</span><h3>Pick your projects</h3><p>Your own repositories or public projects you want to support. Keep your list here.</p></article>
        <article><span class="step-number">02</span><h3>Connect your machine</h3><p><a href="/install">Install the Idlehand CLI</a>, then connect it with your Claude Code or Codex and GitHub account.</p></article>
        <article><span class="step-number">03</span><h3>Choose a budget. Lend a hand.</h3><p>The runner reviews pull requests, works on issues, then checks for reproducible bugs. Claude’s estimated spending threshold can overshoot during in-flight calls. Codex has no dollar cap.</p></article>
      </div>
      <div class="notice"><strong>You stay in control.</strong> Work runs locally in a separate checkout. Findings and fixes are rechecked before they reach GitHub. Set <code>policy.merge never</code> to keep merges manual.</div>
    </section>

    <section class="section">
      <div class="section-heading"><div><span class="eyebrow">A shared shortlist</span><h2>Projects people care about.</h2></div><a class="text-link" href="/popular">Explore repositories →</a></div>
      <RepoGrid repos={popular} signedIn={!!me} empty="The shortlist is open. Sign in and choose the first project you’d like to support." />
    </section>
  </Layout>
);
