import Link from 'next/link';
import { notFound } from 'next/navigation';
import { apiJson } from '../api-client';
import { ApprovalControls } from '../approval-controls';
import { SchedulingControl } from '../scheduling-control';
import { VideoInputControls } from '../video-input-controls';

export const dynamic = 'force-dynamic';
type Video = {
  videoId: string;
  title: string | null;
  inputVersion: number;
  workflowStatus: string;
  approvalStatus: string;
  face: { name: string } | null;
  previewUrl: string | null;
  sourceUrl: string | null;
  thumbnailUrl: string | null;
  thumbnailSourceUrl: string | null;
  manualActionRequired: boolean;
  manualActionReason: string | null;
  schedule: {
    businessDate: string;
    slotHour: number;
    status: string;
    mediaAsset: { status: string; errorCode: string | null } | null;
  } | null;
  latestAttempt: {
    id: string;
    status: string;
    errorCode: string | null;
    failureClass: string | null;
    reconcileRequiredAt: string | null;
  } | null;
  generatedContent: {
    version: number;
    caption: string;
    hashtags: string[];
    cta: string;
    provider: string;
    modelName: string;
    promptVersion: string;
    regenerated: boolean;
    createdAt: string;
  } | null;
  postingHistory: {
    instagramMediaId: string;
    permalink: string | null;
    postedAt: string;
  } | null;
  approvals: Array<{
    id: string;
    decision: string;
    actorId: string;
    reason: string | null;
    createdAt: string;
  }>;
};
type List = {
  videos: Video[];
  total: number;
  offset: number;
  limit: number;
  filter: string;
  q: string;
};
type Schedules = {
  schedules: Array<{
    id: string;
    businessDate: string;
    slotHour: number;
    status: string;
    video: { videoId: string; title: string | null; workflowStatus: string };
    face: { name: string };
    mediaAsset: { status: string } | null;
  }>;
};
type Events = {
  total: number;
  offset: number;
  limit: number;
  events: Array<{
    id: string;
    actorId: string;
    action: string;
    entity: string;
    entityId: string;
    createdAt: string;
  }>;
};
type Settings = {
  schedulingAutomationEnabled: boolean;
  instagramWriteEnabled: boolean;
  timezone: string;
  slots: string[];
  dailyLimit: number;
  source: string;
  updatedAt: string | null;
  publishingBlockReason: string;
  version: number;
};
const names: Record<string, string> = {
  videos: 'Videos',
  approvals: 'Approvals',
  schedule: 'Schedule',
  failures: 'Failures',
  audit: 'Audit log',
  settings: 'Settings',
};
const time = (value: string) =>
  new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
const label = (value: string) => value.replaceAll('_', ' ');

export default async function OperationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ section: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { section } = await params;
  if (!Object.hasOwn(names, section)) notFound();
  const search = await searchParams;
  const query = new URLSearchParams();
  for (const key of ['filter', 'q', 'offset'])
    if (typeof search[key] === 'string') query.set(key, search[key]);
  const endpoint = section === 'audit' ? 'audit-events' : section;
  let data: List | Schedules | Events | Settings;
  try {
    data = await apiJson(`/api/v1/${endpoint}?${query}`);
  } catch {
    return (
      <main className="shell">
        <section className="error-panel" role="alert">
          <h1>{names[section]} unavailable</h1>
          <p>
            The API did not return this view. Check authenticated API access and dependencies, then
            refresh.
          </p>
        </section>
      </main>
    );
  }
  const list = 'videos' in data ? data : null;
  const nextQuery = new URLSearchParams(query);
  if ('offset' in data) nextQuery.set('offset', String(data.offset + data.limit));
  return (
    <main className="shell">
      <section className="overview-heading">
        <div>
          <p className="eyebrow">REEL OPERATIONS · IST</p>
          <h1>{names[section]}</h1>
          <p className="muted">
            {section === 'approvals'
              ? 'Review the source, cover and current input version before deciding.'
              : section === 'failures'
                ? 'Inspect failure classification and reconciliation state before recovery.'
                : 'Current PostgreSQL workflow state'}
          </p>
        </div>
      </section>
      {list ? (
        <>
          <form className="filter-bar" method="get">
            <label>
              Search ID, title or face <input name="q" maxLength={100} defaultValue={list.q} />
            </label>
            {section === 'videos' ? (
              <label>
                Workflow{' '}
                <select name="filter" defaultValue={list.filter}>
                  {['all', 'waiting', 'ready', 'scheduled', 'failed', 'manualAction'].map(
                    (filter) => (
                      <option key={filter} value={filter}>
                        {label(filter)}
                      </option>
                    ),
                  )}
                </select>
              </label>
            ) : null}
            <button type="submit">Apply filters</button>
          </form>
          <p>
            {list.total} matching videos · Showing {list.videos.length ? list.offset + 1 : 0}–
            {list.offset + list.videos.length}
          </p>
          {!list.videos.length ? (
            <section className="integration-card">No videos match this view.</section>
          ) : null}
          <section className="video-list">
            {list.videos.map((video) => (
              <article className="video-card" key={video.videoId}>
                <div className="video-card-heading">
                  <div>
                    <strong className="video-id">{video.videoId}</strong>
                    <h2>{video.title || 'Title needed'}</h2>
                    <p>Face: {video.face?.name || 'Not assigned'}</p>
                  </div>
                  <span className="status">{label(video.workflowStatus)}</span>
                </div>
                <p>
                  Approval: {label(video.approvalStatus)} · Input version {video.inputVersion}
                </p>
                {section === 'videos' &&
                [
                  'WAITING_VIDEO',
                  'WAITING_FACE',
                  'WAITING_TITLE',
                  'WAITING_THUMBNAIL',
                  'WAITING_APPROVAL',
                  'READY',
                ].includes(video.workflowStatus) ? (
                  <VideoInputControls
                    videoId={video.videoId}
                    currentTitle={video.title}
                    currentFace={video.face?.name ?? null}
                  />
                ) : null}
                {section === 'approvals' ? (
                  <div className="approval-previews">
                    {video.previewUrl ? (
                      <iframe
                        title={`${video.videoId} source video`}
                        src={video.previewUrl}
                        loading="lazy"
                        allowFullScreen
                      />
                    ) : (
                      <p>Video preview unavailable</p>
                    )}
                    {video.thumbnailUrl ? (
                      <iframe
                        title={`${video.videoId} thumbnail`}
                        src={video.thumbnailUrl}
                        loading="lazy"
                      />
                    ) : (
                      <p>Thumbnail unavailable</p>
                    )}
                  </div>
                ) : null}
                <div className="action-row">
                  {video.sourceUrl ? (
                    <a href={video.sourceUrl} target="_blank" rel="noreferrer">
                      Open source video
                    </a>
                  ) : null}
                  {video.thumbnailSourceUrl ? (
                    <a href={video.thumbnailSourceUrl} target="_blank" rel="noreferrer">
                      Open thumbnail
                    </a>
                  ) : null}
                </div>
                <p>
                  Schedule:{' '}
                  {video.schedule
                    ? `${video.schedule.businessDate} ${video.schedule.slotHour}:00 IST · ${label(video.schedule.status)}`
                    : 'Not scheduled'}
                </p>
                {video.manualActionRequired ? (
                  <p role="note">
                    Manual action: {video.manualActionReason || 'Inspect operator history'}
                  </p>
                ) : null}
                {video.latestAttempt ? (
                  <p>
                    Attempt {video.latestAttempt.id}: {label(video.latestAttempt.status)} ·{' '}
                    {video.latestAttempt.failureClass || 'Unclassified'} ·{' '}
                    {video.latestAttempt.errorCode || 'No error code'}
                    {video.latestAttempt.reconcileRequiredAt
                      ? ' · Reconciliation required before retry'
                      : ''}
                  </p>
                ) : null}
                {video.schedule?.mediaAsset ? (
                  <p>
                    Media: {video.schedule.mediaAsset.status}{' '}
                    {video.schedule.mediaAsset.errorCode || ''}
                  </p>
                ) : null}
                {video.generatedContent ? (
                  <div className="content-preview">
                    <p>{video.generatedContent.caption}</p>
                    <small>{video.generatedContent.hashtags.join(' ')}</small>
                    <strong>CTA: {video.generatedContent.cta}</strong>
                    <small>
                      Version {video.generatedContent.version} · {video.generatedContent.provider} /{' '}
                      {video.generatedContent.modelName} · prompt{' '}
                      {video.generatedContent.promptVersion}
                    </small>
                  </div>
                ) : null}
                {video.postingHistory ? (
                  <p>
                    Posted {time(video.postingHistory.postedAt)} · Media ID{' '}
                    {video.postingHistory.instagramMediaId}
                    {video.postingHistory.permalink ? (
                      <>
                        {' '}
                        · <a href={video.postingHistory.permalink}>Open Reel</a>
                      </>
                    ) : null}
                  </p>
                ) : null}
                {section === 'failures' ? (
                  <p>
                    Recovery requires inspection of the stored attempt and audit history. Uncertain
                    Instagram outcomes require reconciliation before any retry.
                  </p>
                ) : null}
                {section === 'approvals' ? (
                  <ApprovalControls videoId={video.videoId} inputVersion={video.inputVersion} />
                ) : null}
                <details>
                  <summary>Approval history ({video.approvals.length} latest)</summary>
                  {video.approvals.length ? (
                    <ol>
                      {video.approvals.map((event) => (
                        <li key={event.id}>
                          {label(event.decision)} · {event.actorId} · {time(event.createdAt)}
                          <p>{event.reason || 'No reason supplied'}</p>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <p>No decisions recorded.</p>
                  )}
                </details>
              </article>
            ))}
          </section>
          {list.offset > 0 ? (
            <Link
              href={`/${section}?${new URLSearchParams({ ...Object.fromEntries(query), offset: String(Math.max(0, list.offset - list.limit)) })}`}
            >
              Previous page
            </Link>
          ) : null}
          {list.offset + list.limit < list.total ? (
            <Link href={`/${section}?${nextQuery}`}>Next page</Link>
          ) : null}
        </>
      ) : null}
      {'schedules' in data ? (
        <>
          <p>Latest 100 reservations · 19:00 and 20:00 IST · Scheduled does not mean published.</p>
          <section className="video-list">
            {data.schedules.map((schedule) => (
              <article className="video-card" key={schedule.id}>
                <strong>
                  {schedule.businessDate} · {schedule.slotHour}:00 IST
                </strong>
                <h2>{schedule.video.videoId}</h2>
                <p>
                  {schedule.video.title || 'Untitled'} · {schedule.face.name}
                </p>
                <p>
                  Reservation: {label(schedule.status)} · Workflow:{' '}
                  {label(schedule.video.workflowStatus)}
                </p>
                <p>Media: {schedule.mediaAsset?.status || 'Not prepared'}</p>
              </article>
            ))}
          </section>
          {!data.schedules.length ? <p>No reservations.</p> : null}
        </>
      ) : null}
      {'events' in data ? (
        <>
          <p>{data.total} recorded audit events. Event summaries exclude sensitive payloads.</p>
          <ol className="audit-list">
            {data.events.map((event) => (
              <li className="integration-card" key={event.id}>
                <strong>{label(event.action)}</strong>
                <p>
                  {event.actorId} · {time(event.createdAt)}
                </p>
                <code>
                  {event.entity} / {event.entityId}
                </code>
              </li>
            ))}
          </ol>
          {!data.events.length ? <p>No events recorded.</p> : null}
          {data.offset > 0 ? (
            <Link href={`/audit?offset=${Math.max(0, data.offset - data.limit)}`}>
              Previous page
            </Link>
          ) : null}
          {data.offset + data.limit < data.total ? (
            <Link href={`/audit?${nextQuery}`}>Next page</Link>
          ) : null}
        </>
      ) : null}
      {'schedulingAutomationEnabled' in data ? (
        <section className="integration-card">
          <h2>Scheduling automation: {data.schedulingAutomationEnabled ? 'Enabled' : 'Off'}</h2>
          <p>Instagram writes: {data.instagramWriteEnabled ? 'Enabled' : 'Disabled'}</p>
          <p>
            Timezone: {data.timezone} · Slots: {data.slots.join(', ')} · Daily limit:{' '}
            {data.dailyLimit}
          </p>
          <p>
            Setting source: {data.source} · Updated:{' '}
            {data.updatedAt ? time(data.updatedAt) : 'Default off'}
          </p>
          <p>Publishing gate: {label(data.publishingBlockReason)}</p>
          <p>
            Scheduling and publishing are separate controls. Integration configuration and readiness
            are on Overview.
          </p>
          <SchedulingControl enabled={data.schedulingAutomationEnabled} version={data.version} />
        </section>
      ) : null}
    </main>
  );
}
