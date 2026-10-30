import type { FC } from 'hono/jsx';
import type { Me } from '@idlehand/shared';
import { Layout } from './Layout.tsx';

export const CliApprove: FC<{ me: Me; userCode: string; status: string }> = ({ me, userCode, status }) => (
  <Layout me={me} title="Approve CLI">
    <div class="approve">
      {status === 'pending' ? (
        <>
          <h1>Approve your CLI?</h1>
          <p class="lead">
            The <code>idlehand</code> CLI on your machine wants access as <strong>{me.login}</strong>. It will read the repos you included and post
            run reports.
          </p>
          <div class="code">{userCode}</div>
          <p class="muted">Make sure this code matches the one shown in your terminal.</p>
          <form method="post" action="/cli/approve">
            <input type="hidden" name="userCode" value={userCode} />
            <button class="btn primary" type="submit" name="decision" value="approve">
              Approve
            </button>
            <button class="btn danger" type="submit" name="decision" value="deny">
              Deny
            </button>
          </form>
        </>
      ) : status === 'approved' ? (
        <>
          <h1>Done.</h1>
          <p class="lead">Go back to your terminal. The CLI will pick up its token in a moment.</p>
        </>
      ) : status === 'denied' ? (
        <>
          <h1>Denied.</h1>
          <p class="lead">The CLI was not granted access. You can close this tab.</p>
        </>
      ) : (
        <>
          <h1>Code {status === 'expired' ? 'expired' : 'not found'}.</h1>
          <p class="lead">
            Run <code>idlehand login</code> again to get a fresh code.
          </p>
        </>
      )}
    </div>
  </Layout>
);
