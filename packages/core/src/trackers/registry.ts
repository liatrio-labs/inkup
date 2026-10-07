// The trackers InkUp can send to (ADR 0028), as data: what a Client's Trackers settings asks the reviewer for, the
// words it shows, and how to build the adapter from what was entered. The extension's options page, the review page's
// send control and bulk bar, and the desktop app's views all read this list, so a new tracker is one entry here and
// nothing per-tracker in a Client's UI. Where a value is stored (the extension's storage.local, the desktop app's
// keychain) is the Client's business; this file never touches storage or the DOM.
import {
  type AdapterOptions,
  type TrackerAdapter,
  type TrackerCredentials,
  TrackerError,
  type TrackerName,
} from './adapter.ts';
import { GITHUB_API, githubAdapter } from './github.ts';
import { jiraAdapter, parseJiraSite } from './jira.ts';
import { LINEAR_API, linearAdapter } from './linear.ts';

/** One thing the reviewer enters for a tracker: a token, an email, a site. */
export interface TrackerField {
  id: string;
  /** Also what a saved field is called back to the reviewer: "GitHub token saved." */
  label: string;
  /** Kept masked in the UI and out of everything but its own stored key (or the keychain). */
  secret: boolean;
  placeholder?: string;
}

/** The one-time notice shown the first time a tracker's credentials are saved: what will leave the machine. */
export interface TrackerNotice {
  title: string;
  body: string;
}

/**
 * What the reviewer entered for a tracker, by field id, plus `destination` (the default repo or team). A Client may
 * add `baseUrl` to point the adapter at a stub (the extension's dev-only overrides); left out, it is the real API.
 */
export type TrackerValues = Record<string, string>;

export interface TrackerDefinition {
  tracker: TrackerName;
  /** "GitHub". */
  label: string;
  /** What the default destination is called: "Default repo". */
  destinationLabel: string;
  destinationPlaceholder: string;
  fields: TrackerField[];
  /** A short explanation of the credentials this tracker needs and what they must be allowed to do. */
  help: string;
  notice: TrackerNotice;
  adapter(fetch: AdapterOptions['fetch'], values: TrackerValues): TrackerAdapter;
  credentials(values: TrackerValues): TrackerCredentials;
  /**
   * Checks and tidies a field before a Client saves it: the value to store, or what to tell the reviewer is wrong.
   * Jira's site must be an Atlassian Cloud site. A Client that points the adapter at a stub may skip it.
   */
  prepare?(fieldId: string, value: string): { value: string } | { error: string };
}

/** The value a Client should save for a field, or what is wrong with it; a tracker with no `prepare` takes it trimmed. */
export function prepareField(
  definition: TrackerDefinition,
  fieldId: string,
  value: string,
): { value: string } | { error: string } {
  return definition.prepare ? definition.prepare(fieldId, value) : { value: value.trim() };
}

export const TRACKERS: TrackerDefinition[] = [
  {
    tracker: 'github',
    label: 'GitHub',
    destinationLabel: 'Default repo',
    destinationPlaceholder: 'owner/repo',
    fields: [{ id: 'token', label: 'GitHub token', secret: true, placeholder: 'github_pat_…' }],
    help: 'GitHub Issues: one issue per Change Item, with its screenshots. Use a fine-grained personal access token with Issues (read and write), Contents (read and write) and Metadata (read) on the repos you send to. Screenshots are stored on the repo’s inkup-assets branch.',
    notice: {
      title: 'What goes to GitHub',
      body: "Nothing is sent until you press Send on a Change Item. Then its text (title, intent, where it is, what you said, the agent prompt) goes to GitHub as a new issue in the repo you picked, and its screenshots and element close-ups are committed to that repo's inkup-assets branch. Anyone who can read the repo can see those screenshots, so pick a private repo for anything private.",
    },
    adapter: (fetch, v) => githubAdapter({ fetch, baseUrl: v.baseUrl || GITHUB_API }),
    credentials: (v) => ({ token: (v.token ?? '').trim() }),
  },
  {
    tracker: 'linear',
    label: 'Linear',
    destinationLabel: 'Default team',
    destinationPlaceholder: 'Pick a team',
    fields: [{ id: 'token', label: 'Linear API key', secret: true, placeholder: 'lin_api_…' }],
    help: 'Linear: one issue per Change Item, in a team, with its screenshots uploaded to Linear. Use a personal API key (Settings, Security & access, Personal API keys) from an account that can create issues in the team.',
    notice: {
      title: 'What goes to Linear',
      body: 'Nothing is sent until you press Send on a Change Item. Then its text (title, intent, where it is, what you said, the agent prompt) goes to Linear as a new issue in the team you picked, and its screenshots and element close-ups are uploaded to Linear. They are visible to the people who can see that issue.',
    },
    adapter: (fetch, v) => linearAdapter({ fetch, baseUrl: v.baseUrl || LINEAR_API }),
    credentials: (v) => ({ token: (v.token ?? '').trim() }),
  },
  {
    tracker: 'jira',
    label: 'Jira',
    destinationLabel: 'Default project',
    destinationPlaceholder: 'Project key, such as ABC',
    fields: [
      { id: 'site', label: 'Jira site', secret: false, placeholder: 'https://your-team.atlassian.net' },
      { id: 'email', label: 'Atlassian email', secret: false, placeholder: 'you@example.com' },
      { id: 'token', label: 'Jira API token', secret: true, placeholder: 'Paste an API token' },
    ],
    help: 'Jira Cloud: one issue per Change Item, in a project, with its screenshots attached. Use the email of your Atlassian account and an API token made at id.atlassian.com (Security, API tokens). The account must be able to create issues and attachments in the project.',
    notice: {
      title: 'What goes to Jira',
      body: 'Nothing is sent until you press Send on a Change Item. Then its text (title, intent, where it is, what you said, the agent prompt) goes to Jira as a new issue in the project you picked, and its screenshots and element close-ups are attached to that issue. Everyone who can see the issue can see them.',
    },
    adapter(fetch, v) {
      // `baseUrl` is only ever set by a development build, to point at a stub; the saved site is then not checked.
      const site = parseJiraSite(v.site ?? '');
      const baseUrl = v.baseUrl || site;
      if (!baseUrl)
        throw new TrackerError(
          'other',
          'Enter your Jira site as https://<your-team>.atlassian.net in Trackers settings, then try again.',
        );
      return jiraAdapter({
        fetch,
        baseUrl,
        email: v.email ?? '',
        issueType: v.issueType || null,
        siteUrl: site ?? (v.site ?? '').trim(),
      });
    },
    credentials: (v) => ({ token: (v.token ?? '').trim() }),
    prepare(fieldId, value) {
      if (fieldId !== 'site') return { value: value.trim() };
      const site = parseJiraSite(value);
      return site
        ? { value: site }
        : { error: 'The site must look like https://<your-team>.atlassian.net. Check the address in your Jira URL.' };
    },
  },
];

/** The definition of one tracker. */
export function trackerDefinition(tracker: TrackerName): TrackerDefinition | undefined {
  return TRACKERS.find((t) => t.tracker === tracker);
}
