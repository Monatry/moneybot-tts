export type TtsSource = "chat" | "cheer" | "redeem";

export interface TtsRequest {
  id: string;
  /** What actually gets synthesised, after cleaning and after the [voice] prefix is split off. */
  text: string;
  /** Chatter login. "" for the setup/avatar test buttons — those never burn a voice entry. */
  user: string;
  source: TtsSource;
  bits?: number;
  /** Voice the chatter asked for by name, before it has been validated against the live list. */
  voiceOverride?: string;
  /** Resolved once the runner picks it up; what the row and the log display. */
  voice?: string;
  /** Rough seconds of speech, for the queue's per-row duration and the "1m 12s" total. */
  estSeconds: number;
  receivedAt: number;
}

export interface ChatEntry {
  id: string;
  user: string;
  /** Twitch's own per-user color when the client sends one; otherwise a stable fallback. */
  color: string;
  text: string;
  kind: "chat" | "cheer" | "redeem";
  bits?: number;
  rewardName?: string;
  at: number;
}

export interface NowPlaying {
  request: TtsRequest;
  /** 0–1. Estimated until the stream completes, exact after. */
  progress: number;
}

export type ConnectionStatus = "offline" | "connecting" | "connected" | "reconnecting";
