import type { FC } from 'hono/jsx';
import type { Me } from '@idlehand/shared';
import { Layout } from './Layout.tsx';

export const CliApprove: FC<{ me: Me; userCode: string; status: string }> = ({ me, userCode, status }) => (
  <Layout me={me} title="Connect your CLI">
    <section class="message panel approve">
      <span class="eyebrow">Your machine, connected</span>
      {status === 'pending' ? <>
        <h1>Is this your terminal?</h1>
        <p class="lead">The Idlehand CLI wants to connect as <strong>{me.login}</strong>. Check that this code matches the one on your machine.</p>
        <div class="code" aria-label={`Confirmation code ${userCode}`}>{userCode}</div>
        <div class="notice">Connecting lets the CLI read your included repositories and send contribution reports. GitHub changes use the GitHub account already signed in on your machine.</div>
        <p class="fine-print">Only connect a login you started. If you weren’t expecting this, choose Deny.</p>
        <form class="actions" method="post" action="/cli/approve">
          <input type="hidden" name="userCode" value={userCode} />
          <button class="btn primary" type="submit" name="decision" value="approve">Connect CLI</button>
          <button class="btn danger" type="submit" name="decision" value="deny">Deny access</button>
        </form>
      </> : status === 'approved' ? <>
        <h1>Your CLI is connected.</h1><p class="lead">Return to your terminal to finish signing in. It will pick up the connection automatically.</p><a class="btn" href="/dashboard">Back to dashboard →</a>
      </> : status === 'denied' ? <>
        <h1>Access denied.</h1><p class="lead">This login was not connected. To try again, run <code>idlehand login</code> in your terminal for a new code.</p><a class="btn" href="/dashboard">Back to dashboard →</a>
      </> : <>
        <h1>{!userCode ? 'Connect your terminal.' : status === 'expired' ? 'This code has expired.' : 'We couldn’t find that code.'}</h1>
        <p class="lead">{!userCode ? 'Enter the code shown by idlehand login on your machine.' : 'Check the code, or run idlehand login again to get a fresh one. Codes expire after 15 minutes.'}</p>
        <form class="search" method="get" action="/cli/approve">
          <label for="user-code">Terminal code</label><input id="user-code" name="code" type="text" placeholder="ABCD-EFGH" value={userCode} required maxlength={9} pattern="[A-Za-z0-9]{4}-[A-Za-z0-9]{4}" autocomplete="off" autocapitalize="characters" spellcheck={false} />
          <button class="btn primary" type="submit">Check code →</button>
        </form>
      </>}
    </section>
  </Layout>
);
