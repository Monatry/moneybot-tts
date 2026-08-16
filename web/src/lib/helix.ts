"use client";

import { requireClientId } from "./twitchAuth";

/**
 * The slice of the Helix API this app needs. Called straight from the browser: Twitch
 * serves `Access-Control-Allow-Origin: *` on these endpoints, so no proxy is involved and
 * the token never passes through this app's server.
 */

const BASE = "https://api.twitch.tv/helix";

export class HelixError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "HelixError";
    this.status = status;
  }
}

async function helix<T>(
  path: string,
  token: string,
  init?: RequestInit & { signal?: AbortSignal },
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      "Client-Id": requireClientId(),
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      /* no JSON body — the status line is all there is */
    }
    throw new HelixError(res.status, message);
  }
  return (await res.json()) as T;
}

export interface HelixUser {
  id: string;
  login: string;
  display_name: string;
  profile_image_url: string;
}

export async function getUserByLogin(
  login: string,
  token: string,
  signal?: AbortSignal,
): Promise<HelixUser | null> {
  const body = await helix<{ data: HelixUser[] }>(
    `/users?login=${encodeURIComponent(login)}`,
    token,
    { signal },
  );
  return body.data[0] ?? null;
}

export async function getFollowerCount(
  broadcasterId: string,
  token: string,
  signal?: AbortSignal,
): Promise<number | null> {
  try {
    const body = await helix<{ total: number }>(
      `/channels/followers?broadcaster_id=${broadcasterId}&first=1`,
      token,
      { signal },
    );
    return body.total;
  } catch (err) {
    // Follower totals need moderator:read:followers for someone else's channel. Not having
    // it is not an error worth showing — the channel was still found.
    if (err instanceof HelixError && (err.status === 401 || err.status === 403)) return null;
    throw err;
  }
}

export interface CustomReward {
  id: string;
  title: string;
}

/**
 * The channel's own channel-point rewards, so the redeem name can be a picker instead of
 * free text. Only the broadcaster's token can read these, and only for rewards their own
 * app created unless `manage` scope is held — an empty or failed result is expected, and
 * the caller falls back to a text field.
 */
export async function getCustomRewards(
  broadcasterId: string,
  token: string,
  signal?: AbortSignal,
): Promise<CustomReward[]> {
  try {
    const body = await helix<{ data: CustomReward[] }>(
      `/channel_points/custom_rewards?broadcaster_id=${broadcasterId}`,
      token,
      { signal },
    );
    return body.data ?? [];
  } catch {
    return [];
  }
}

export async function getViewerCount(
  login: string,
  token: string,
  signal?: AbortSignal,
): Promise<number | null> {
  try {
    const body = await helix<{ data: { viewer_count: number }[] }>(
      `/streams?user_login=${encodeURIComponent(login)}`,
      token,
      { signal },
    );
    // No entry at all means the channel is offline, which is a real answer, not a failure.
    return body.data[0]?.viewer_count ?? 0;
  } catch {
    return null;
  }
}

export async function createEventSubSubscription(
  sessionId: string,
  broadcasterId: string,
  token: string,
): Promise<void> {
  await helix("/eventsub/subscriptions", token, {
    method: "POST",
    body: JSON.stringify({
      type: "channel.channel_points_custom_reward_redemption.add",
      version: "1",
      condition: { broadcaster_user_id: broadcasterId },
      transport: { method: "websocket", session_id: sessionId },
    }),
  });
}
