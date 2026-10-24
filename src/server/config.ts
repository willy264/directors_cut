import "dotenv/config";
import { resolve } from "node:path";
import { DEFAULT_ENGINE_CONFIG } from "../core/config.js";
import type { ActionKind, EngineConfig } from "../core/types.js";

export const ACTION_SCOPES: Record<ActionKind, string> = {
  set_title: "channel:manage:broadcast", set_category: "channel:manage:broadcast",
  create_poll: "channel:manage:polls", create_prediction: "channel:manage:predictions",
  create_clip: "clips:edit", create_marker: "channel:manage:broadcast",
  shoutout: "moderator:manage:shoutouts", snooze_ad: "channel:manage:ads",
  resolve_prediction: "channel:manage:predictions", raid: "channel:manage:raids",
};
export interface AppConfig {
  mode: "demo" | "live"; host: string; port: number; clientId: string; clientSecret: string;
  broadcasterLogin: string; redirectUri: string; scopes: string[]; engine: EngineConfig;
  enabledActions: ActionKind[]; blockedTerms: string[]; eventLogPath: string; tokenStorePath: string;
  channelPoints: boolean; rewardCost: number;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env, args = process.argv.slice(2)): AppConfig {
  const number = (key: string, fallback: number, min: number, max: number) => {
    const value = env[key]?.trim() ? Number(env[key]) : fallback;
    if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer from ${min} to ${max}.`);
    return value;
  };
  const mode = args.includes("--live") ? "live" : args.includes("--demo") ? "demo" : env.APP_MODE ?? "demo";
  if (mode !== "demo" && mode !== "live") throw new Error("APP_MODE must be demo or live.");
  const host = env.HOST || "127.0.0.1";
  if (!["127.0.0.1", "localhost", "::1"].includes(host)) throw new Error("HOST must be a loopback address; the control panel runs locally.");
  const enabledActions = (env.ENABLED_ACTIONS || "set_title,set_category,create_poll,create_clip,create_marker").split(",").map(x => x.trim());
  for (const action of enabledActions) if (!(action in ACTION_SCOPES)) throw new Error(`Unknown enabled action: ${action}`);
  if (env.ENABLE_AI === "true") throw new Error("The optional AI mapper is not implemented. Set ENABLE_AI=false; typed proposals are fully supported.");
  return {
    mode, host, port: number("PORT", 3000, 1, 65535), clientId: env.CLIENT_ID || "", clientSecret: env.CLIENT_SECRET || "",
    broadcasterLogin: (env.BROADCASTER_LOGIN || "").toLowerCase(), redirectUri: env.OAUTH_REDIRECT_URI || "http://localhost:3000/auth/callback",
    scopes: (env.TWITCH_SCOPES || "user:read:chat channel:manage:broadcast channel:manage:polls clips:edit").split(/\s+/).filter(Boolean),
    engine: { ...DEFAULT_ENGINE_CONFIG,
      quorum: number("QUORUM", 3, 1, 10000), roundWindowMs: number("ROUND_WINDOW_MS", 25000, 1000, 300000),
      cooldownMs: number("COOLDOWN_MS", 10000, 0, 3600000), confirmTimeoutMs: number("CONFIRM_TIMEOUT_MS", 8000, 1000, 120000),
      minRateLimitRemaining: number("MIN_RATE_LIMIT_REMAINING", 5, 1, 1000),
      actionCooldownMs: { shoutout: number("SHOUTOUT_COOLDOWN_MS", 120000, 120000, 3600000) },
      shoutoutTargetCooldownMs: number("SHOUTOUT_TARGET_COOLDOWN_MS", 3600000, 3600000, 86400000),
    },
    enabledActions: enabledActions as ActionKind[], blockedTerms: (env.BLOCKED_TERMS || "").split(",").map(x => x.trim()).filter(Boolean),
    eventLogPath: resolve(env.EVENT_LOG_PATH || `./data/${mode}-events.jsonl`), tokenStorePath: resolve(env.TOKEN_STORE_PATH || "./data/tokens.json"),
    channelPoints: env.ENABLE_CHANNEL_POINTS === "true", rewardCost: number("REWARD_COST", 100, 1, 1000000000),
  };
}
