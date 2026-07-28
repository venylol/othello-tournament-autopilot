(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FTD_SCORE_PNG_RENDERER = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  function norm(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function splitName(value) {
    var parts = norm(value).split(" ");
    if (parts.length <= 1) return [norm(value)];
    return [parts[0], parts.slice(1).join(" ")];
  }

  function isByeName(value) {
    return norm(value).toLowerCase() === "bye";
  }

  function hasScoreValue(value) {
    return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
  }

  function hasPairingScore(row) {
    return Boolean(row && hasScoreValue(row.blackScore) && hasScoreValue(row.whiteScore));
  }

  function roundTitle(round) {
    var label = norm(round).replace(/^round(?:\s+|[-_]+)*/i, "");
    return label ? "Round " + label : "Round";
  }

  function buildScoreRow(input) {
    var row = input || {};
    var blackBye = isByeName(row.black);
    var whiteBye = isByeName(row.white);
    var writtenHasScore = hasPairingScore(row.written) && Math.trunc(Number(row.written.blackScore)) + Math.trunc(Number(row.written.whiteScore)) === 64;
    var localHasScore = hasPairingScore(row.local) && Math.trunc(Number(row.local.blackScore)) + Math.trunc(Number(row.local.whiteScore)) === 64;
    var ftdBlackScore = Number(row.ftdBlackScore);
    var hasFtdScore = !blackBye && !whiteBye && Number.isFinite(ftdBlackScore) && Math.trunc(ftdBlackScore) !== 0;
    return {
      table: row.table,
      black: row.black || "",
      white: row.white || "",
      blackScore: blackBye || whiteBye ? (blackBye ? 31 : 33) : writtenHasScore ? Math.trunc(Number(row.written.blackScore)) : localHasScore ? Math.trunc(Number(row.local.blackScore)) : hasFtdScore ? Math.trunc(ftdBlackScore) : null,
      whiteScore: blackBye || whiteBye ? (whiteBye ? 31 : 33) : writtenHasScore ? Math.trunc(Number(row.written.whiteScore)) : localHasScore ? Math.trunc(Number(row.local.whiteScore)) : hasFtdScore ? 64 - Math.trunc(ftdBlackScore) : null,
    };
  }

  function drawChinaFlag(ctx, x, y, w, h) {
    ctx.save();
    ctx.fillStyle = "#ee1c25";
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = "#ffde00";
    function star(cx, cy, r) {
      ctx.beginPath();
      for (var i = 0; i < 10; i += 1) {
        var angle = -Math.PI / 2 + (i * Math.PI) / 5;
        var radius = i % 2 === 0 ? r : r * 0.42;
        ctx.lineTo(cx + Math.cos(angle) * radius, cy + Math.sin(angle) * radius);
      }
      ctx.closePath();
      ctx.fill();
    }
    star(x + w * 0.22, y + h * 0.28, h * 0.14);
    star(x + w * 0.42, y + h * 0.16, h * 0.05);
    star(x + w * 0.50, y + h * 0.30, h * 0.05);
    star(x + w * 0.50, y + h * 0.46, h * 0.05);
    star(x + w * 0.40, y + h * 0.58, h * 0.05);
    ctx.restore();
  }

  function drawDisc(ctx, x, y, r, color) {
    ctx.save();
    var gradient = ctx.createRadialGradient(x - r * 0.4, y - r * 0.5, r * 0.1, x, y, r);
    if (color === "white") {
      gradient.addColorStop(0, "#ffffff");
      gradient.addColorStop(1, "#d8d8d8");
      ctx.shadowColor = "rgba(255,255,255,.34)";
    } else {
      gradient.addColorStop(0, "#111111");
      gradient.addColorStop(1, "#000000");
      ctx.shadowColor = "rgba(255,255,255,.28)";
    }
    ctx.shadowBlur = 8;
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color === "white" ? "#f4f4f4" : "#666";
    ctx.stroke();
    ctx.restore();
  }

  function drawName(ctx, name, x, y, align) {
    var lines = splitName(name);
    ctx.save();
    ctx.textAlign = align || "left";
    ctx.fillStyle = "#b7b7b7";
    ctx.font = "700 22px Arial, sans-serif";
    ctx.fillText(lines[0] || "", x, y);
    if (lines.length > 1) {
      ctx.font = "600 22px Arial, sans-serif";
      ctx.fillText(lines[1] || "", x, y + 34);
    }
    ctx.restore();
  }

  function drawScoreDisc(ctx, x, y, r, color, value) {
    drawDisc(ctx, x, y, r, color);
    if (!hasScoreValue(value)) return;
    ctx.save();
    ctx.fillStyle = color === "white" ? "#111111" : "#ffffff";
    ctx.strokeStyle = color === "white" ? "rgba(255,255,255,.55)" : "rgba(0,0,0,.55)";
    ctx.lineWidth = color === "white" ? 2 : 3;
    ctx.font = "900 21px Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.strokeText(String(Math.trunc(Number(value))), x, y + 1);
    ctx.fillText(String(Math.trunc(Number(value))), x, y + 1);
    ctx.restore();
  }

  function buildPairingsCanvas(pairings, round) {
    var scale = Math.max(1, Math.min(3, window.devicePixelRatio || 2));
    var width = 1040;
    var headerHeight = 122;
    var rowHeight = 92;
    var footerHeight = 24;
    var height = headerHeight + rowHeight * pairings.length + footerHeight;
    var canvas = document.createElement("canvas");
    canvas.width = Math.round(width * scale);
    canvas.height = Math.round(height * scale);
    canvas.style.width = width + "px";
    canvas.style.height = height + "px";
    var ctx = canvas.getContext("2d");
    ctx.scale(scale, scale);

    ctx.fillStyle = "#211f1d";
    ctx.fillRect(0, 0, width, height);
    ctx.fillStyle = "#2b2927";
    ctx.fillRect(0, 0, width, headerHeight);
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "center";
    ctx.font = "700 34px Arial, sans-serif";
    ctx.fillText(roundTitle(round), width / 2, 74);
    ctx.strokeStyle = "#6d6a66";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, headerHeight - 1);
    ctx.lineTo(width, headerHeight - 1);
    ctx.stroke();

    for (var i = 0; i < pairings.length; i += 1) {
      var row = pairings[i];
      var top = headerHeight + i * rowHeight;
      ctx.fillStyle = i % 2 === 0 ? "#242321" : "#211f1d";
      ctx.fillRect(10, top, width - 20, rowHeight);
      ctx.strokeStyle = "#33302d";
      ctx.beginPath();
      ctx.moveTo(10, top + rowHeight);
      ctx.lineTo(width - 10, top + rowHeight);
      ctx.stroke();

      ctx.fillStyle = "#e8e8e8";
      ctx.textAlign = "center";
      ctx.font = "700 22px Arial, sans-serif";
      ctx.fillText(String(row.table || i + 1), 48, top + 55);

      drawChinaFlag(ctx, 84, top + 30, 43, 30);
      drawName(ctx, row.black || "", 138, top + 38, "left");

      drawScoreDisc(ctx, 455, top + 46, 36, "black", row.blackScore);
      ctx.fillStyle = "#e8e8e8";
      ctx.font = "800 22px Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("-", 520, top + 54);
      drawScoreDisc(ctx, 585, top + 46, 36, "white", row.whiteScore);

      drawChinaFlag(ctx, 686, top + 30, 43, 30);
      drawName(ctx, row.white || "", 740, top + 38, "left");
    }

    return canvas;
  }

  return {
    buildScoreRow: buildScoreRow,
    buildPairingsCanvas: buildPairingsCanvas,
    hasPairingScore: hasPairingScore,
    hasScoreValue: hasScoreValue,
    roundTitle: roundTitle,
  };
});
