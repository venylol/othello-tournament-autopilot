"use strict";

function normalize(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s\u3000\[\]()（）【】{}<>《》.,，。:：;；'"“”‘’\-_\/\\|]+/g, "");
}

function asciiTokens(value) {
  return String(value || "")
    .toLowerCase()
    .match(/[a-z0-9_]{4,}/g) || [];
}

function compactPinyinName(value) {
  return normalize(value).replace(/[^a-z0-9_]/g, "");
}

const HAN_ALIASES = new Map([
  ["王万里", "wangwanli"],
  ["彭献鲁", "pengxianlu"],
  ["林峰", "linfeng"],
  ["吕子墨", "lvzimo"],
  ["邓钰琦", "dengyuqi"],
]);

function senderAliases(sender) {
  const out = new Set([normalize(sender)]);
  for (const [han, pinyin] of HAN_ALIASES.entries()) {
    if (String(sender || "").includes(han)) out.add(pinyin);
  }
  for (const token of asciiTokens(sender)) out.add(normalize(token));
  return [...out].filter(Boolean);
}

function senderLeadAlias(sender) {
  const token = String(sender || "")
    .toLowerCase()
    .match(/[a-z0-9_]{4,}/);
  if (token) return normalize(token[0]);
  for (const [han, pinyin] of HAN_ALIASES.entries()) {
    if (String(sender || "").includes(han)) return pinyin;
  }
  return "";
}

function playerAliases(player) {
  const out = new Set();
  const name = player.displayName || "";
  const account = player.account || "";
  const groupNick = player.groupNick || player.group_nick || "";
  out.add(normalize(name));
  out.add(compactPinyinName(name));
  if (account) out.add(normalize(account));
  if (groupNick) {
    out.add(normalize(groupNick));
    for (const token of asciiTokens(groupNick)) out.add(normalize(token));
  }
  return [...out].filter((x) => x && x.length >= 4);
}

function matchReasons(player, sender) {
  const reasons = [];
  const sAliases = senderAliases(sender);
  const pAliases = playerAliases(player);
  const account = normalize(player.account || "");
  const display = compactPinyinName(player.displayName || "");
  const groupNick = normalize(player.groupNick || player.group_nick || "");

  if (account && sAliases.some((s) => s.includes(account))) {
    reasons.push("account");
  }
  if (groupNick && sAliases.some((s) => s.includes(groupNick) || groupNick.includes(s))) {
    reasons.push("groupNick");
  }
  if (display && sAliases.some((s) => s.includes(display) || display.includes(s))) {
    reasons.push("name");
  }
  for (const pa of pAliases) {
    if (sAliases.some((sa) => sa.includes(pa))) {
      reasons.push("alias");
      break;
    }
  }
  return [...new Set(reasons)];
}

function candidateMatches(players, sender) {
  return (Array.isArray(players) ? players : [])
    .map((player) => ({
      player,
      reasons: matchReasons(player || {}, sender),
    }))
    .filter((x) => x.reasons.length);
}

function chooseEffectiveCandidates(candidates, sender) {
  const accountCandidates = candidates.filter((x) => x.reasons.includes("account"));
  const lead = senderLeadAlias(sender);
  const leadCandidates = lead
    ? candidates.filter((x) => compactPinyinName(x.player.displayName).includes(lead))
    : [];
  return leadCandidates.length === 1
    ? leadCandidates
    : accountCandidates.length === 1
      ? accountCandidates
      : candidates;
}

function matchPlayer(players, sender) {
  const candidates = candidateMatches(players, sender);
  const effective = chooseEffectiveCandidates(candidates, sender);
  const candidateDisplayNames = candidates.map((x) => x.player.displayName || "");
  if (effective.length !== 1) {
    return {
      status: effective.length === 0 ? "unmatched" : "ambiguous",
      matchedDisplayName: "",
      matchedAccount: "",
      matchReasons: [],
      candidateDisplayNames,
      candidates: candidates.map((x) => ({
        displayName: x.player.displayName || "",
        account: x.player.account || "",
        reasons: x.reasons,
      })),
    };
  }
  const player = effective[0].player;
  return {
    status: "matched",
    matchedDisplayName: player.displayName || "",
    matchedAccount: player.account || "",
    matchReasons: effective[0].reasons,
    candidateDisplayNames,
  };
}

function matchPlayerPreferChecked(players, sender) {
  const checked = (Array.isArray(players) ? players : []).filter((p) => Boolean(p && p.checkedIn));
  const checkedHint = matchPlayer(checked, sender);
  if (checkedHint.status === "matched") {
    return { ...checkedHint, source: "checked-in-roster" };
  }
  const allHint = matchPlayer(players, sender);
  return {
    ...allHint,
    source: allHint.status === "matched" ? "all-roster" : "wechat-sender",
  };
}

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function cli() {
  const raw = await readStdin();
  const payload = raw.trim() ? JSON.parse(raw) : {};
  const players = Array.isArray(payload.players) ? payload.players : [];
  const senders = Array.isArray(payload.senders) ? payload.senders : [];
  const preferChecked = Boolean(payload.preferChecked);
  const matches = {};
  for (const sender of senders) {
    matches[sender] = preferChecked
      ? matchPlayerPreferChecked(players, sender)
      : matchPlayer(players, sender);
  }
  process.stdout.write(`${JSON.stringify({ ok: true, matches })}\n`);
}

if (require.main === module) {
  cli().catch((error) => {
    process.stderr.write(`${error && error.stack ? error.stack : error}\n`);
    process.exit(1);
  });
}

module.exports = {
  normalize,
  compactPinyinName,
  senderLeadAlias,
  matchReasons,
  candidateMatches,
  chooseEffectiveCandidates,
  matchPlayer,
  matchPlayerPreferChecked,
};
