/**
 * Delivery channels, Web3 Actions and Alerts through the REST API (API reference, https://api.tenderly.co/api/v1).
 * Every call here is listed in the README's "API calls" section, in the order setup.ts makes them.
 */
import { redact, short } from "./log.js";
import { ApiError, DASHBOARD, type Credentials } from "./tenderly.js";

const API = "https://api.tenderly.co/api/v1";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/** A failed call. `slug` is the API's error slug (quota_limit_reached), `detail` the first sentence of its message. */
export class CallError extends ApiError {
  constructor(call: string, status: number, readonly slug: string, readonly detail: string) {
    super(`${call} failed: HTTP ${status}${slug ? ` ${slug}` : ""}`, status);
  }
}

async function call<T>(c: Credentials, method: string, path: string, body?: unknown): Promise<T> {
  // How a failure names the call: "PATCH /alert/0e3b1c2a…" (a project path without its prefix, ids shortened).
  const where = path.replace(project(c), "").replace(`/account/${c.account}`, "/account/{a}").replace(UUID, short);
  const shown = `${method} ${where.split("?")[0]}`;
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { "X-Access-Key": c.accessKey, "Content-Type": "application/json", Accept: "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  }).catch((err: Error) => {
    throw new Error(`${shown} failed: ${err.message}`);
  });
  const text = await res.text();
  if (!res.ok) {
    let slug = "";
    let detail = text.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160); // text or an HTML page
    try {
      const error = (JSON.parse(text) as { error?: { slug?: string; message?: string } }).error;
      slug = error?.slug ?? "";
      // The first sentence is enough: "You've reached the quota limit for your current plan."
      if (error?.message) detail = error.message.split(/(?<=\.)\s/)[0];
    } catch {
      // not JSON, keep the text
    }
    throw new CallError(shown, res.status, slug, redact(detail));
  }
  return (text ? JSON.parse(text) : {}) as T;
}

const project = (c: Credentials): string => `/account/${c.account}/project/${c.project}`;

// ---- delivery channels ----------------------------------------------------------------------------

export interface DeliveryChannel {
  id: string;
  /** email, slack, telegram, discord, webhook, action, ... */
  type: string;
  enabled: boolean;
}

/** Account channels (email, Slack, Telegram, ...): GET /account/{a}/delivery-channels. */
export const accountChannels = async (c: Credentials): Promise<DeliveryChannel[]> =>
  (await call<{ delivery_channels?: DeliveryChannel[] }>(c, "GET", `/account/${c.account}/delivery-channels`))
    .delivery_channels ?? [];

/** Project channels (webhooks and alert-triggered Web3 Actions): GET /account/{a}/project/{p}/delivery-channels. */
export const projectChannels = async (c: Credentials): Promise<DeliveryChannel[]> =>
  (await call<{ delivery_channels?: DeliveryChannel[] }>(c, "GET", `${project(c)}/delivery-channels`))
    .delivery_channels ?? [];

// ---- Web3 Actions -------------------------------------------------------------------------------

export interface Action {
  id: string;
  name: string;
  /** PUBLISHED until the deploy finishes, then DEPLOYED. */
  status: string;
  stopped: boolean;
  version: {
    id: string;
    index: number;
    /** An ALERT action is stored and returned as TRANSACTIONSIMPLE. */
    triggerType: string;
    /** Only in GET /actions/action/{id}, not in the list. */
    source?: string;
    deployError?: string | null;
  };
}

export interface ActionSpec {
  name: string;
  description: string;
  source: string;
  triggerType: "ALERT";
  trigger: { type: "alert"; alert: Record<string, never> };
  runtime: "V2";
  function: string;
  invocationType: "SYNC" | "ASYNC";
}

/** GET /account/{a}/project/{p}/actions */
export const listActions = (c: Credentials): Promise<Action[]> => call<Action[]>(c, "GET", `${project(c)}/actions`);

/** GET /account/{a}/project/{p}/actions/action/{id} */
export const getAction = (c: Credentials, id: string): Promise<Action> =>
  call<Action>(c, "GET", `${project(c)}/actions/action/${id}`);

/** POST /account/{a}/project/{p}/actions/publishFile: publishes a new version and deploys it. Returns the version. */
export async function publishAction(
  c: Credentials,
  spec: ActionSpec,
): Promise<{ actionId: string; versionId: string; index: number }> {
  const res = await call<{ actions?: Record<string, { id: string; actionId: string; index: number }> }>(
    c, "POST", `${project(c)}/actions/publishFile`, { action: spec, deploy: true });
  const version = res.actions?.[spec.name];
  if (!version) throw new Error(`publishFile returned no version for ${spec.name}`);
  return { actionId: version.actionId, versionId: version.id, index: version.index };
}

/** POST /account/{a}/project/{p}/actions/action/{id}/resume: start a stopped action again. */
export const resumeAction = (c: Credentials, id: string): Promise<unknown> =>
  call(c, "POST", `${project(c)}/actions/action/${id}/resume`);

// ---- Alerts ---------------------------------------------------------------------------------------

export interface Expression {
  type: string;
  expression: Record<string, unknown>;
}

export interface AlertSpec {
  name: string;
  description: string;
  color: string;
  simple_type: string;
  enabled: boolean;
  expressions: Expression[];
  delivery_channels: Array<{ id: string; enabled: boolean }>;
}

export interface Alert {
  id: string;
  name: string;
  description?: string;
  color?: string;
  enabled: boolean;
  expressions: Expression[];
  delivery_channels?: Array<{ delivery_channel_id: string; enabled: boolean }>;
}

/** GET /account/{a}/project/{p}/alerts */
export const listAlerts = async (c: Credentials): Promise<Alert[]> =>
  (await call<{ alerts?: Alert[] }>(c, "GET", `${project(c)}/alerts`)).alerts ?? [];

/** POST /account/{a}/project/{p}/alert */
export const createAlert = async (c: Credentials, spec: AlertSpec): Promise<Alert> =>
  (await call<{ alert: Alert }>(c, "POST", `${project(c)}/alert`, spec)).alert;

/** PATCH /account/{a}/project/{p}/alert/{id}: replaces the rule with the full spec. */
export const updateAlert = async (c: Credentials, id: string, spec: AlertSpec): Promise<Alert> =>
  (await call<{ alert: Alert }>(c, "PATCH", `${project(c)}/alert/${id}`, spec)).alert;

// ---- dashboard links (they need a login to the project) ---------------------------------------------

export const alertUrl = (c: Credentials, id: string): string => `${DASHBOARD}/${c.account}/${c.project}/alerts/rules/${id}`;
export const actionUrl = (c: Credentials, id: string): string => `${DASHBOARD}/${c.account}/${c.project}/action/${id}`;
export const alertHistoryUrl = (c: Credentials): string => `${DASHBOARD}/${c.account}/${c.project}/alerts/history`;
