"use client";

import { createEventSubSubscription } from "./helix";
import { validateToken } from "./twitchAuth";

/**
 * Channel-point redemptions over the EventSub websocket. Replaces
 * TwitchLib.EventSub.Websockets; the browser speaks the same protocol directly.
 *
 * (TwitchLib.PubSub, the old way to do this, was discontinued in April 2025 — do not go
 * looking for it.)
 *
 * The teardown before every connect is load-bearing: the dashboard reconnects whenever
 * settings change, and a second live websocket is a second EventSub *session* with its own
 * subscription. Twitch then delivers every redemption once per session, so a single redeem
 * is spoken twice.
 */

const WS_URL = "wss://eventsub.wss.twitch.tv/ws";

export interface RedemptionEvent {
  user: string;
  displayName: string;
  rewardTitle: string;
  userInput: string;
}

export interface EventSubHandlers {
  onRedemption: (event: RedemptionEvent) => void;
  onStatus: (message: string) => void;
}

interface EnvelopeMeta {
  message_type: string;
}

interface Envelope {
  metadata: EnvelopeMeta;
  payload: {
    session?: { id: string; reconnect_url?: string };
    event?: {
      user_login?: string;
      user_name?: string;
      user_input?: string;
      reward?: { title?: string };
    };
  };
}

export class TwitchEventSubClient {
  private socket: WebSocket | null = null;
  private closing = false;
  private broadcasterId: string | null = null;
  private token: string | null = null;
  private reconnectTimer: number | null = null;
  private reconnectAttempt = 0;

  constructor(private readonly handlers: EventSubHandlers) {}

  /**
   * Opens the websocket and subscribes.
   *
   * `broadcaster_user_id` is the *token owner's* id, not a lookup of the channel name:
   * `channel:read:redemptions` only ever grants access to the signed-in user's own channel,
   * so redemptions are read from the account that authorized, whatever channel name is set
   * for chat.
   */
  async connect(token: string | null): Promise<void> {
    this.disconnect();
    this.closing = false;
    if (!token) return;

    const info = await validateToken(token);
    if (!info) {
      this.handlers.onStatus("Twitch token is expired, channel point redeems are off.");
      return;
    }
    if (!info.scopes.includes("channel:read:redemptions")) {
      this.handlers.onStatus(
        "Twitch token cannot read redemptions, re-authorize in setup to turn them on.",
      );
      return;
    }

    this.token = token;
    this.broadcasterId = info.userId;
    this.open(WS_URL);
  }

  private open(url: string) {
    const socket = new WebSocket(url);
    this.socket = socket;

    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      let envelope: Envelope;
      try {
        envelope = JSON.parse(String(ev.data)) as Envelope;
      } catch {
        return;
      }
      void this.handleEnvelope(envelope, socket);
    };

    socket.onclose = () => {
      if (this.socket !== socket) return;
      if (!this.closing) this.scheduleReconnect();
    };
  }

  private async handleEnvelope(envelope: Envelope, socket: WebSocket) {
    switch (envelope.metadata.message_type) {
      case "session_welcome": {
        const sessionId = envelope.payload.session?.id;
        if (!sessionId || !this.broadcasterId || !this.token) return;
        this.reconnectAttempt = 0;
        try {
          await createEventSubSubscription(sessionId, this.broadcasterId, this.token);
        } catch (err) {
          this.handlers.onStatus(
            `Could not subscribe to redemptions: ${(err as Error).message}`,
          );
        }
        return;
      }

      case "session_reconnect": {
        // Twitch is retiring this socket. It hands over a pre-authorised URL whose session
        // inherits the existing subscriptions, so this path must NOT re-subscribe.
        const url = envelope.payload.session?.reconnect_url;
        if (!url) return;
        this.closeSocket(socket);
        this.open(url);
        return;
      }

      case "notification": {
        const event = envelope.payload.event;
        if (!event) return;
        this.handlers.onRedemption({
          user: event.user_login ?? "",
          displayName: event.user_name ?? event.user_login ?? "",
          rewardTitle: event.reward?.title ?? "",
          userInput: event.user_input ?? "",
        });
        return;
      }

      default:
        // session_keepalive and revocation notices need no action here.
        return;
    }
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) return;
    const delay = Math.min(30_000, 1000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closing && this.token) void this.connect(this.token);
    }, delay);
  }

  private closeSocket(socket: WebSocket | null) {
    if (!socket) return;
    if (this.socket === socket) this.socket = null;
    socket.onmessage = null;
    socket.onclose = null;
    try {
      socket.close();
    } catch {
      /* already gone */
    }
  }

  disconnect() {
    this.closing = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectAttempt = 0;
    this.closeSocket(this.socket);
    this.broadcasterId = null;
    this.token = null;
  }
}
