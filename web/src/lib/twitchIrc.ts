"use client";

import { validateToken, canReadChat } from "./twitchAuth";

/**
 * Twitch chat over IRC-on-WebSocket. Replaces TwitchLib.Client, which had no browser
 * equivalent; the protocol is small enough to speak directly.
 *
 * The behaviour that mattered in the desktop build is preserved:
 *  - A stored token is validated before every connect. Twitch answers a token without
 *    `chat:read` with "Login authentication failed" and then drops the socket without a
 *    close handshake — the only visible symptom is a reconnect loop that looks like a
 *    network fault. Checking first turns it into a plain message, and anonymous
 *    credentials still carry chat *and* cheers.
 *  - The IRC username must be the token owner's login, not the channel being watched. They
 *    only coincide when the broadcaster is the one signed in.
 *  - No token at all is fine: `justinfan<random>` reads any public chat anonymously.
 */

const IRC_URL = "wss://irc-ws.chat.twitch.tv:443";

export interface IrcMessage {
  /** Login name, lowercase. */
  user: string;
  /** display-name when the client sent one, otherwise the login. */
  displayName: string;
  /** The chatter's own colour, or "" when they have never set one. */
  color: string;
  text: string;
  bits: number;
  id: string;
  /**
   * The channel-point reward this message was redeemed with, or "" for an ordinary message.
   * A reward that takes text input posts that text to chat as well as raising an EventSub
   * redemption, so this is the only thing marking the PRIVMSG as the second half of a pair.
   * See `Bot.onChatMessage`.
   */
  customRewardId: string;
}

export interface IrcHandlers {
  onMessage: (msg: IrcMessage) => void;
  onConnectionChange: (connected: boolean) => void;
  /** Human-readable notes — why a token was ignored, and so on. */
  onStatus: (message: string) => void;
}

interface ParsedLine {
  tags: Record<string, string>;
  prefix: string;
  command: string;
  params: string[];
}

function parseLine(line: string): ParsedLine {
  let rest = line;
  const tags: Record<string, string> = {};

  if (rest.startsWith("@")) {
    const end = rest.indexOf(" ");
    for (const pair of rest.slice(1, end).split(";")) {
      const eq = pair.indexOf("=");
      if (eq === -1) tags[pair] = "";
      else tags[pair.slice(0, eq)] = unescapeTag(pair.slice(eq + 1));
    }
    rest = rest.slice(end + 1);
  }

  let prefix = "";
  if (rest.startsWith(":")) {
    const end = rest.indexOf(" ");
    prefix = rest.slice(1, end);
    rest = rest.slice(end + 1);
  }

  const params: string[] = [];
  while (rest.length > 0) {
    if (rest.startsWith(":")) {
      params.push(rest.slice(1));
      break;
    }
    const sp = rest.indexOf(" ");
    if (sp === -1) {
      params.push(rest);
      break;
    }
    params.push(rest.slice(0, sp));
    rest = rest.slice(sp + 1);
  }

  return { tags, prefix, command: params.shift() ?? "", params };
}

function unescapeTag(v: string): string {
  return v
    .replace(/\\s/g, " ")
    .replace(/\\:/g, ";")
    .replace(/\\r/g, "\r")
    .replace(/\\n/g, "\n")
    .replace(/\\\\/g, "\\");
}

export class TwitchIrcClient {
  private socket: WebSocket | null = null;
  private channel = "";
  private token: string | null = null;
  /** Set after Twitch refuses the token, so the retry does not offer it again. */
  private forceAnonymous = false;
  private closing = false;
  private reconnectAttempt = 0;
  private reconnectTimer: number | null = null;

  constructor(private readonly handlers: IrcHandlers) {}

  get isConnected(): boolean {
    return this.socket?.readyState === WebSocket.OPEN;
  }

  async connect(channel: string, token: string | null): Promise<void> {
    this.disconnect();
    this.closing = false;
    this.forceAnonymous = false;
    this.channel = channel.trim().toLowerCase().replace(/^#/, "");
    this.token = token;
    if (!this.channel) {
      this.handlers.onStatus("No channel set, nothing to connect to.");
      return;
    }
    await this.open();
  }

  private async open(): Promise<void> {
    const creds = await this.buildCredentials();

    const socket = new WebSocket(IRC_URL);
    this.socket = socket;

    socket.onopen = () => {
      if (this.socket !== socket) return;
      socket.send("CAP REQ :twitch.tv/tags twitch.tv/commands");
      socket.send(`PASS ${creds.pass}`);
      socket.send(`NICK ${creds.nick}`);
      socket.send(`JOIN #${this.channel}`);
    };

    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      for (const raw of String(ev.data).split("\r\n")) {
        if (raw.length > 0) this.handleLine(raw, socket);
      }
    };

    socket.onclose = () => {
      // Every handler is gated on this still being the live socket: a superseded socket
      // keeps firing while it tears down, and its "disconnected" would otherwise overwrite
      // the status of the connection that replaced it.
      if (this.socket !== socket) return;
      this.handlers.onConnectionChange(false);
      if (!this.closing) this.scheduleReconnect();
    };

    socket.onerror = () => {
      if (this.socket !== socket) return;
      // A WebSocket error event carries nothing useful; onclose follows and handles it.
    };
  }

  /**
   * Picks the IRC credentials. A stored token is only usable here if it carries
   * `chat:read` and has not expired.
   */
  private async buildCredentials(): Promise<{ nick: string; pass: string }> {
    const token = this.forceAnonymous ? null : this.token;

    if (token) {
      const info = await validateToken(token);
      if (!info) {
        this.handlers.onStatus(
          "Saved Twitch token is expired or invalid, reading chat anonymously.",
        );
      } else if (!canReadChat(info)) {
        this.handlers.onStatus(
          "Saved Twitch token has no chat access, reading chat anonymously. " +
            "Re-authorize in setup to sign in by name.",
        );
      } else {
        return { nick: info.login, pass: `oauth:${token}` };
      }
    }

    return {
      nick: `justinfan${Math.floor(Math.random() * 89999) + 10000}`,
      pass: "oauth:",
    };
  }

  private handleLine(raw: string, socket: WebSocket) {
    const line = parseLine(raw);

    switch (line.command) {
      case "PING":
        socket.send(`PONG :${line.params[0] ?? "tmi.twitch.tv"}`);
        return;

      case "001":
        // Welcome — the login was accepted. JOIN was already sent optimistically.
        this.reconnectAttempt = 0;
        this.handlers.onConnectionChange(true);
        return;

      case "NOTICE": {
        const text = line.params[line.params.length - 1] ?? "";
        if (/login (authentication|unsuccessful)/i.test(text)) {
          // Twitch refused the token. Retrying with the same bad credentials would loop
          // forever, so drop them and come back anonymously — chat and cheers do not need
          // a token at all.
          void this.reconnectAnonymously(
            "Twitch rejected the saved token, reading chat anonymously.",
          );
        } else {
          this.handlers.onStatus(text);
        }
        return;
      }

      case "PRIVMSG": {
        const user = line.prefix.split("!")[0] ?? "";
        const text = line.params[line.params.length - 1] ?? "";
        const bits = Number.parseInt(line.tags["bits"] ?? "0", 10) || 0;
        this.handlers.onMessage({
          user: user.toLowerCase(),
          displayName: line.tags["display-name"] || user,
          color: line.tags["color"] || "",
          text,
          bits,
          id: line.tags["id"] || `${Date.now()}-${Math.random().toString(36).slice(2)}`,
          customRewardId: line.tags["custom-reward-id"] || "",
        });
        return;
      }

      default:
        return;
    }
  }

  private async reconnectAnonymously(reason: string) {
    if (this.forceAnonymous) return; // already the anonymous attempt — do not loop
    this.forceAnonymous = true;
    this.handlers.onStatus(reason);
    this.closeSocket();
    await this.open();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer !== null) return;
    // 1s, 2s, 4s … capped at 30s. Twitch drops idle sockets routinely, so a reconnect is
    // ordinary rather than exceptional.
    const delay = Math.min(30_000, 1000 * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.closing) void this.open();
    }, delay);
  }

  private closeSocket() {
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
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
    this.closeSocket();
  }
}
