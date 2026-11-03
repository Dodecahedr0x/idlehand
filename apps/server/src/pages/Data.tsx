import type { FC } from 'hono/jsx';
import type { Me } from '@idlehand/shared';
import { Layout } from './Layout.tsx';

export const Data: FC<{ me: Me | null }> = ({ me }) => (
  <Layout me={me} title="What we store">
    <div class="page-heading">
      <span class="eyebrow">Plainly, and in public</span>
      <h1>What Idlehand stores.</h1>
      <p class="lead">The web service keeps a small account record so you can sign in, pick repositories, and see what your local runner did. This is what is stored today, why it is kept, and how long it lasts.</p>
    </div>
    <section class="section panel" aria-labelledby="stored-title">
      <h2 id="stored-title">What is stored, and why</h2>
      <p>After you sign in, Idlehand stores your GitHub user id, login, name, and avatar URL so the dashboard can show who you are.</p>
      <p>The web app stores the OAuth access token GitHub issues at sign-in so it can list repositories on your account. The default scope is <code>read:user</code>.</p>
      <p>When you approve a device login, Idlehand stores CLI tokens so your local runner can read your repository selections and post run-report summaries.</p>
      <p>Your repository selections are stored so the next run knows what to work on, and so the public shortlist can show how many people included a project.</p>
      <p>Each finished task can post run-report summaries (repository, kind, provider, outcome, optional URL, cost, and duration) so the dashboard can show recent work.</p>
      <h2>How long it lasts</h2>
      <p>The browser session cookie lasts 30 days. CLI tokens do not expire automatically; they remain valid until they are removed from the service.</p>
      <p>Signing out clears that session cookie and does not revoke the GitHub OAuth access token or any CLI tokens. Account records, repository selections, and run-report summaries remain stored after you sign out.</p>
      <p class="fine-print">Device-login codes expire after 15 minutes and are deleted once used. Token revocation is not part of this build.</p>
    </section>
  </Layout>
);
