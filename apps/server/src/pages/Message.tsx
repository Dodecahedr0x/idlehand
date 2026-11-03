import type { FC } from 'hono/jsx';
import type { Me } from '@idlehand/shared';
import { Layout } from './Layout.tsx';

export const Message: FC<{
  me?: Me | null;
  title: string;
  description: string;
  href?: string;
  action?: string;
}> = ({ me = null, title, description, href = '/', action = 'Back to home' }) => (
  <Layout me={me} title={title}>
    <section class="message panel">
      <span class="eyebrow">A little help getting back</span>
      <h1>{title}</h1>
      <p class="lead">{description}</p>
      <div class="actions"><a class="btn primary" href={href}>{action}</a><a class="text-link" href="/">Home →</a></div>
    </section>
  </Layout>
);

export const SignIn: FC<{ next: string; me: Me | null }> = ({ next, me }) => (
  <Layout me={me} title="Sign in">
    <section class="message panel">
      <span class="eyebrow">Your next contribution starts here</span>
      <h1>Welcome to Idlehand.</h1>
      <p class="lead">Sign in to choose the repositories you care about and see what your local runner contributes.</p>
      <a class="btn primary" href={`/auth/github?next=${encodeURIComponent(next)}`}>Continue with GitHub <span aria-hidden="true">↗</span></a>
      <p class="fine-print">GitHub handles sign-in. The web app saves your repository choices; the CLI runs on your machine using your local GitHub account. <a href="/data">See what Idlehand stores</a>.</p>
      {next.startsWith('/cli/approve') ? <div class="notice">After sign-in, you’ll return to the code confirmation screen. Signing in alone does not connect your CLI.</div> : null}
      <a class="text-link" href="/popular">Explore repositories first →</a>
    </section>
  </Layout>
);
