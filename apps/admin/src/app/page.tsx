import Link from 'next/link';
import { apiJson } from './api-client';
import { SyncControl } from './sync-control';
import { MetaStatusControl } from './meta-status-control';
import { SchedulingControl } from './scheduling-control';
import { WorkflowControls } from './workflow-controls';

export const dynamic = 'force-dynamic';

type Slot = {
  time: string;
  scheduledAt: string | null;
  status: string;
  videoId: string | null;
  title: string | null;
  face: string | null;
  workflowStatus: string | null;
  approvalStatus: string | null;
};

type Dashboard = {
  businessDate: string;
  timezone: string;
  automation: { enabled: boolean; version: number; updatedAt: string | null; source: string };
  slots: Slot[];
  counts: {
    waiting: number;
    ready: number;
    scheduled: number;
    failed: number;
    manualAction: number;
    total: number;
  };
  google: {
    ready: boolean;
    credentialsConfigured: boolean;
    authType: string | null;
    missing: string[];
    configuredIds: {
      sheetId: string | null;
      videoFolderId: string | null;
      thumbnailFolderId: string | null;
      archiveFolderId: string | null;
    };
  };
  sync: {
    lastSync: {
      id: string | null;
      queuedAt: string;
      startedAt: string | null;
      finishedAt: string | null;
    } | null;
    videosSeen: number;
    unmatchedThumbnails: number;
    openConflicts: number;
    errors: number;
    pending: number;
  };
  videos: Array<{
    videoId: string;
    title: string | null;
    face: string | null;
    approvalStatus: string;
    workflowStatus: string;
    content: {
      version: number;
      caption: string;
      hashtags: string[];
      cta: string;
    } | null;
    scheduledDate: string | null;
    scheduledTime: string | null;
    contentGenerationStatus: string;
    durableMediaObjectStatus: string;
    deliveryUrlPolicy: 'EPHEMERAL_JIT';
    lastError: string | null;
    retryCount: number;
  }>;
};

type QueueStatus = {
  healthy: boolean;
  metaPublishingEnabled: boolean;
  queues: Array<{
    name: string;
    available: boolean;
    counts: { waiting: number; active: number; delayed: number; completed: number; failed: number };
    schedulers: Array<{ key: string | null; nextRunAt: string | null }>;
  }>;
};

type IntegrationStatus = {
  contentGenerator: { provider: string; configured: boolean; model: string | null };
  mediaStorage: {
    provider: string;
    cloudinaryConfigured: boolean;
    r2Configured: boolean;
  };
  safety: { metaPublishingEnabled: boolean; phaseBoundary: string };
};

type MetaStatus = {
  implementationReadyForMetaCredentials: boolean;
  readyForFirstControlledMetaPublish: boolean;
  readiness: { state: string; blockers: string[] };
  configured: boolean;
  graphApiVersion: string;
  authPath: 'facebook_login' | 'instagram_login';
  identity: { configuredPairMatchesExpected: boolean; externallyVerified: boolean };
  credentials: {
    accessTokenConfigured: boolean;
    pageIdConfigured: boolean;
    accountIdConfigured: boolean;
    appIdConfigured: boolean;
    appSecretConfigured: boolean;
  };
  accountCheck: { status: string; externalRequestMade: boolean };
  publishing: {
    configuredFlagEnabled: boolean;
    effectiveEnabled: boolean;
    blockReason: string;
  };
  capabilities: Record<string, 'SUPPORTED' | 'UNSUPPORTED' | 'REQUIRES_VERIFICATION'>;
};

type OperationsStatus = {
  status: string;
  revision: string | null;
  dependencies: { postgres: string; redis: string };
  worker: { status: string; revision: string | null; observedAt: string | null };
};

const getDashboard = () => apiJson<Dashboard>('/api/v1/dashboard');
const getApiJson = apiJson;

function localTime(value: string | null, timezone: string): string {
  if (!value) return 'Not scheduled';
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: timezone,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
}

function label(value: string | null): string {
  return value
    ? value
        .replaceAll('_', ' ')
        .toLowerCase()
        .replace(/\b\w/g, (letter) => letter.toUpperCase())
    : '—';
}

export default async function Home() {
  let dashboard: Dashboard | null = null;
  let queues: QueueStatus | null = null;
  let integrations: IntegrationStatus | null = null;
  let meta: MetaStatus | null = null;
  let operations: OperationsStatus | null = null;
  let partialError = false;
  let error: string | null = null;
  try {
    const results = await Promise.allSettled([
      getDashboard(),
      getApiJson<QueueStatus>('/api/v1/queues/status'),
      getApiJson<IntegrationStatus>('/api/v1/integrations/status'),
      getApiJson<MetaStatus>('/api/v1/integrations/meta/status'),
      getApiJson<OperationsStatus>('/api/v1/operations'),
    ] as const);
    if (results[0].status === 'rejected') throw new Error('Dashboard unavailable');
    dashboard = results[0].value;
    queues = results[1].status === 'fulfilled' ? results[1].value : null;
    integrations = results[2].status === 'fulfilled' ? results[2].value : null;
    meta = results[3].status === 'fulfilled' ? results[3].value : null;
    operations = results[4].status === 'fulfilled' ? results[4].value : null;
    partialError = results.some((result) => result.status === 'rejected');
  } catch {
    error = 'Dashboard data is unavailable. Check that the API and database are running.';
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div className="brand-mark" aria-hidden="true">
          GC
        </div>
        <div className="brand-copy">
          <p className="eyebrow">GREEN CITY SEZ</p>
          <h1>Reel operations</h1>
        </div>
        <span className="read-only">Authenticated operations</span>
      </header>
      {error ? (
        <section className="error-panel" role="alert">
          <strong>Couldn’t load the dashboard</strong>
          <p>{error}</p>
        </section>
      ) : dashboard ? (
        <>
          {partialError ? (
            <p role="status">
              Some integration or operational status is unavailable. Inventory remains visible.
            </p>
          ) : null}
          <section className="phase-grid" aria-label="Operational health">
            <article className="phase-card">
              <span>API</span>
              <strong>{operations ? label(operations.status) : 'Unavailable'}</strong>
              <small>Revision {operations?.revision ?? 'Unknown'}</small>
            </article>
            <article className="phase-card">
              <span>PostgreSQL</span>
              <strong>{label(operations?.dependencies.postgres ?? 'unavailable')}</strong>
            </article>
            <article className="phase-card">
              <span>Redis delivery</span>
              <strong>{label(operations?.dependencies.redis ?? 'unavailable')}</strong>
            </article>
            <article className="phase-card">
              <span>Worker heartbeat</span>
              <strong>{label(operations?.worker.status ?? 'unavailable')}</strong>
              <small>
                {operations?.worker.observedAt
                  ? localTime(operations.worker.observedAt, dashboard.timezone)
                  : 'No recent heartbeat'}{' '}
                · Revision {operations?.worker.revision ?? 'Unknown'}
              </small>
            </article>
          </section>
          <section className="overview-heading">
            <div>
              <p className="eyebrow">OVERVIEW</p>
              <h2>Today’s publishing plan</h2>
              <p className="muted">
                {dashboard.businessDate} · {dashboard.timezone}
              </p>
            </div>
            <div className="automation-control">
              <div className={`automation ${dashboard.automation.enabled ? 'is-on' : 'is-off'}`}>
                <span className="dot" />
                Scheduling {dashboard.automation.enabled ? 'enabled' : 'off'} · Instagram writes
                disabled
              </div>
              <SchedulingControl
                enabled={dashboard.automation.enabled}
                version={dashboard.automation.version}
                compact
              />
            </div>
          </section>
          {dashboard.slots.every((slot) => !slot.videoId) ? (
            <p className="slot-empty-note" role="note">
              No video is assigned yet. Review the{' '}
              <Link href="/videos?filter=waiting">Waiting videos</Link>, complete
              Face/Title/Thumbnail and approval, then enable scheduling.
            </p>
          ) : null}

          <section className="slots" aria-label="Today’s publishing slots">
            {dashboard.slots.map((slot) => (
              <article className="slot-card" key={slot.time}>
                <div className="slot-top">
                  <span className="slot-time">{slot.time}</span>
                  <span className={`status status-${slot.status.toLowerCase()}`}>
                    {label(slot.status)}
                  </span>
                </div>
                <p className="scheduled-time">{localTime(slot.scheduledAt, dashboard.timezone)}</p>
                <div className="slot-details">
                  <div>
                    <span>Video ID</span>
                    <strong className="video-id">{slot.videoId ?? '—'}</strong>
                  </div>
                  <div>
                    <span>Face</span>
                    <strong>{slot.face ?? '—'}</strong>
                  </div>
                  <div className="title-row">
                    <span>Title</span>
                    <strong>{slot.title ?? 'No video assigned'}</strong>
                  </div>
                </div>
                <div className="slot-footer">
                  <span>
                    Workflow <b>{label(slot.workflowStatus)}</b>
                  </span>
                  <span>
                    Approval <b>{label(slot.approvalStatus)}</b>
                  </span>
                </div>
              </article>
            ))}
          </section>

          <section className="section-heading">
            <div>
              <p className="eyebrow">WORKFLOW INVENTORY</p>
              <h2>Current counts</h2>
            </div>
            <span className="total">{dashboard.counts.total} videos</span>
          </section>
          <section className="metrics" aria-label="Workflow counts">
            {[
              ['Waiting', dashboard.counts.waiting, 'Needs an input or review'],
              ['Ready', dashboard.counts.ready, 'Eligible for selection'],
              ['Scheduled', dashboard.counts.scheduled, 'Selected or in publishing flow'],
              ['Failed', dashboard.counts.failed, 'Requires investigation'],
              ['Manual action', dashboard.counts.manualAction, 'Follow-up outside automation'],
            ].map(([name, count, hint]) => (
              <a
                className="metric"
                key={name}
                href={`/videos?filter=${name === 'Manual action' ? 'manualAction' : String(name).toLowerCase()}`}
              >
                <span>{name}</span>
                <strong>{count}</strong>
                <small>{hint}</small>
              </a>
            ))}
          </section>

          <section className="section-heading">
            <div>
              <p className="eyebrow">GOOGLE INTEGRATION</p>
              <h2>Drive and Sheets sync</h2>
            </div>
            <span
              className={`integration-state ${dashboard.google.ready ? 'is-ready' : 'is-missing'}`}
            >
              {dashboard.google.ready ? 'Ready' : 'Needs configuration'}
            </span>
          </section>
          <section className="integration-card" aria-label="Google sync status">
            <div className="integration-topline">
              <div>
                <span className="integration-label">Credentials</span>
                <strong>
                  {dashboard.google.credentialsConfigured
                    ? `Configured · ${dashboard.google.authType}`
                    : 'Not configured'}
                </strong>
              </div>
              <SyncControl ready={dashboard.google.ready} />
            </div>
            <div className="integration-ids">
              {[
                ['Sheet', dashboard.google.configuredIds.sheetId],
                ['Video folder', dashboard.google.configuredIds.videoFolderId],
                ['Thumbnail folder', dashboard.google.configuredIds.thumbnailFolderId],
                ['Archive folder', dashboard.google.configuredIds.archiveFolderId],
              ].map(([name, value]) => (
                <div key={name}>
                  <span>{name}</span>
                  <strong>{value || 'Not set'}</strong>
                </div>
              ))}
            </div>
            <div className="sync-summary">
              <span>
                Last sync{' '}
                <b>
                  {dashboard.sync.lastSync
                    ? localTime(dashboard.sync.lastSync.queuedAt, dashboard.timezone)
                    : 'Never'}
                </b>
              </span>
              <span>
                Videos seen <b>{dashboard.sync.videosSeen}</b>
              </span>
              <span>
                Unmatched thumbnails <b>{dashboard.sync.unmatchedThumbnails}</b>
              </span>
              <span>
                Open conflicts <b>{dashboard.sync.openConflicts}</b>
              </span>
              <span>
                Sync errors <b>{dashboard.sync.errors}</b>
              </span>
            </div>
          </section>

          <section className="section-heading">
            <div>
              <p className="eyebrow">PHASE 3 SAFETY</p>
              <h2>Content, media and queues</h2>
            </div>
            <span className="integration-state is-ready">
              Meta {integrations?.safety.metaPublishingEnabled ? 'enabled' : 'disabled'}
            </span>
          </section>
          <section className="phase-grid" aria-label="Phase 3 integration status">
            <article className="phase-card">
              <span>Content generator</span>
              <strong>{label(integrations?.contentGenerator.provider ?? null)}</strong>
              <small>
                {integrations?.contentGenerator.configured
                  ? integrations.contentGenerator.model
                  : 'Not configured'}
              </small>
            </article>
            <article className="phase-card">
              <span>Media storage</span>
              <strong>
                {(integrations?.mediaStorage.provider ?? 'cloudinary') === 'cloudinary'
                  ? 'Cloudinary'
                  : label(integrations?.mediaStorage.provider ?? 'cloudinary')}
              </strong>
              <small>
                Cloudinary{' '}
                {integrations?.mediaStorage.cloudinaryConfigured ? 'configured' : 'not configured'}
              </small>
            </article>
            <article className="phase-card">
              <span>Phase boundary</span>
              <strong>{label(integrations?.safety.phaseBoundary ?? null)}</strong>
              <small>No Instagram publishing request is allowed</small>
            </article>
            <article className="phase-card">
              <span>Queue health</span>
              <strong>{queues?.healthy ? 'Healthy' : 'Needs attention'}</strong>
              <small>{queues?.queues.length ?? 0} workflow queues visible</small>
            </article>
          </section>

          {meta ? (
            <section className="meta-card" aria-label="Instagram Meta configuration status">
              <div className="meta-card-heading">
                <div>
                  <p className="eyebrow">INSTAGRAM / META</p>
                  <h3>{meta.configured ? 'Configuration present' : 'Configuration incomplete'}</h3>
                </div>
                <MetaStatusControl />
              </div>
              <div className="meta-facts">
                <div>
                  <span>Graph API</span>
                  <strong>{meta.graphApiVersion}</strong>
                </div>
                <div>
                  <span>Login path</span>
                  <strong>
                    {meta.authPath === 'facebook_login' ? 'Facebook Login' : 'Instagram Login'}
                  </strong>
                </div>
                <div>
                  <span>Access token</span>
                  <strong>
                    {meta.credentials.accessTokenConfigured
                      ? 'Configured · value hidden'
                      : 'Not configured'}
                  </strong>
                </div>
                {meta.authPath === 'facebook_login' ? (
                  <div>
                    <span>Facebook Page ID</span>
                    <strong>
                      {meta.credentials.pageIdConfigured
                        ? 'Configured · value hidden'
                        : 'Not configured'}
                    </strong>
                  </div>
                ) : null}
                <div>
                  <span>Instagram account ID</span>
                  <strong>
                    {meta.credentials.accountIdConfigured
                      ? 'Configured · value hidden'
                      : 'Not configured'}
                  </strong>
                </div>
                <div>
                  <span>Page and Instagram identity</span>
                  <strong>
                    {!meta.identity.configuredPairMatchesExpected
                      ? 'Missing or mismatched'
                      : meta.identity.externallyVerified
                        ? 'Expected pair · externally verified'
                        : 'Expected pair · not externally verified'}
                  </strong>
                </div>
                <div>
                  <span>Optional app credentials</span>
                  <strong>
                    {meta.credentials.appIdConfigured && meta.credentials.appSecretConfigured
                      ? 'Configured · values hidden'
                      : meta.credentials.appIdConfigured || meta.credentials.appSecretConfigured
                        ? 'Partially configured'
                        : 'Not set'}
                  </strong>
                </div>
                <div>
                  <span>Account / permission check</span>
                  <strong>
                    {meta.accountCheck.externalRequestMade ? 'Checked' : 'Not checked'}
                  </strong>
                </div>
                <div>
                  <span>Publishing</span>
                  <strong>Blocked by phase safety</strong>
                </div>
                <div>
                  <span>Implementation readiness</span>
                  <strong>
                    {meta.implementationReadyForMetaCredentials
                      ? 'Ready for Meta credentials'
                      : 'Implementation incomplete'}
                  </strong>
                </div>
                <div>
                  <span>First controlled publish</span>
                  <strong>
                    {meta.readyForFirstControlledMetaPublish
                      ? 'Ready'
                      : 'Not ready · approval required'}
                  </strong>
                </div>
              </div>
              <p className="meta-readiness-note">
                Readiness: {label(meta.readiness.state)}. {meta.readiness.blockers.length} gating
                checks remain. Status refresh is local and read-only; no Meta request is made.
              </p>
              <p className="meta-note">
                Configuration status only. No Meta request was made; account access and permissions
                remain unverified.
              </p>
              {meta.publishing.configuredFlagEnabled ? (
                <p className="meta-note meta-warning">
                  The deployment flag is on, but effective publishing remains disabled. There is no
                  publish control here.
                </p>
              ) : null}
              <div className="meta-capabilities">
                {Object.entries(meta.capabilities).map(([name, support]) => (
                  <span key={name}>
                    <b>{label(name.replace(/([a-z])([A-Z])/g, '$1_$2'))}</b>
                    {label(support)}
                  </span>
                ))}
              </div>
            </section>
          ) : null}

          <section className="queue-list" aria-label="Queue status">
            {queues?.queues.map((queue) => (
              <article key={queue.name}>
                <strong>{queue.name}</strong>
                <span>Waiting {queue.counts.waiting}</span>
                <span>Active {queue.counts.active}</span>
                <span>Delayed {queue.counts.delayed}</span>
                <span>Failed {queue.counts.failed}</span>
                <span>Schedulers {queue.schedulers.length}</span>
              </article>
            ))}
          </section>

          <section className="section-heading">
            <div>
              <p className="eyebrow">CONTENT PIPELINE</p>
              <h2>Recent videos and manual controls</h2>
            </div>
          </section>
          <section className="video-list" aria-label="Recent workflow videos">
            {dashboard.videos.map((video) => (
              <article className="video-card" key={video.videoId}>
                <div className="video-card-heading">
                  <div>
                    <strong className="video-id">{video.videoId}</strong>
                    <h3>{video.title ?? 'Untitled'}</h3>
                    <p>{video.face ?? 'Face not assigned'}</p>
                  </div>
                  <span className={`status status-${video.workflowStatus.toLowerCase()}`}>
                    {label(video.workflowStatus)}
                  </span>
                </div>
                <dl>
                  <div>
                    <dt>Approval</dt>
                    <dd>{label(video.approvalStatus)}</dd>
                  </div>
                  <div>
                    <dt>Content</dt>
                    <dd>{label(video.contentGenerationStatus)}</dd>
                  </div>
                  <div>
                    <dt>Durable media object</dt>
                    <dd>{label(video.durableMediaObjectStatus)}</dd>
                  </div>
                  <div>
                    <dt>Temporary delivery URL</dt>
                    <dd>
                      {video.deliveryUrlPolicy === 'EPHEMERAL_JIT'
                        ? 'Issued just in time for publishing · never shown here'
                        : 'Unavailable'}
                    </dd>
                  </div>
                  <div>
                    <dt>Schedule</dt>
                    <dd>
                      {video.scheduledDate
                        ? `${video.scheduledDate} · ${video.scheduledTime}`
                        : 'Not scheduled'}
                    </dd>
                  </div>
                  <div>
                    <dt>Publish attempts</dt>
                    <dd>{video.retryCount}</dd>
                  </div>
                  <div>
                    <dt>Last error</dt>
                    <dd>{video.lastError ?? 'None'}</dd>
                  </div>
                </dl>
                {video.content ? (
                  <div className="content-preview">
                    <p>{video.content.caption}</p>
                    <small>{video.content.hashtags.join(' ')}</small>
                    <strong>CTA: {video.content.cta}</strong>
                  </div>
                ) : (
                  <p className="muted">No generated content yet.</p>
                )}
                {video.workflowStatus.startsWith('WAITING_') ? (
                  <p className="input-needed-note">
                    Required inputs are incomplete.{' '}
                    <Link href={`/videos?q=${encodeURIComponent(video.videoId)}`}>
                      Add Face or Title
                    </Link>
                  </p>
                ) : null}
                <WorkflowControls
                  videoId={video.videoId}
                  approvalStatus={video.approvalStatus}
                  workflowStatus={video.workflowStatus}
                  hasContent={Boolean(video.content)}
                  hasSchedule={Boolean(video.scheduledDate)}
                  mediaStatus={video.durableMediaObjectStatus}
                />
              </article>
            ))}
          </section>
          <footer>
            Operational data from PostgreSQL · Last refreshed{' '}
            {new Date().toLocaleTimeString('en-IN', { timeZone: dashboard.timezone })}
          </footer>
        </>
      ) : null}
    </main>
  );
}
