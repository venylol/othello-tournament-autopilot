(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.FTD_PAIRING_PNG_RENDERER = api;
})(typeof window !== "undefined" ? window : globalThis, function () {
  "use strict";

  function norm(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isByeName(value) {
    return norm(value).toLowerCase() === "bye";
  }

  function splitName(value) {
    var parts = norm(value).split(" ");
    if (parts.length <= 1) return [norm(value)];
    return [parts[0], parts.slice(1).join(" ")];
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

  function fitText(ctx, text, maxWidth) {
    var raw = String(text || "");
    if (!raw || !maxWidth || ctx.measureText(raw).width <= maxWidth) return raw;
    var out = raw;
    while (out.length > 1 && ctx.measureText(out + "…").width > maxWidth) out = out.slice(0, -1);
    return out + "…";
  }

  function drawName(ctx, name, x, y, align, maxWidth) {
    var lines = splitName(name);
    ctx.save();
    ctx.textAlign = align || "left";
    ctx.fillStyle = "#b7b7b7";
    ctx.font = "700 22px Arial, sans-serif";
    var first = fitText(ctx, lines[0] || "", maxWidth || 180);
    ctx.fillText(first, x, y);
    var width = ctx.measureText(first).width;
    if (lines.length > 1) {
      ctx.font = "600 22px Arial, sans-serif";
      var second = fitText(ctx, lines[1] || "", maxWidth || 180);
      ctx.fillText(second, x, y + 30);
      width = Math.max(width, ctx.measureText(second).width);
    }
    ctx.restore();
    return width;
  }

  function drawOpponentAccount(ctx, account, x, y, align, maxWidth) {
    var text = norm(account);
    if (!text || text === "?" || text === "？") text = "【裁判未登记】";
    ctx.save();
    ctx.textAlign = align || "left";
    ctx.fillStyle = "#f2d36b";
    ctx.textBaseline = "middle";
    ctx.font = "700 15px Arial, sans-serif";
    var label = fitText(ctx, text, maxWidth || 150);
    ctx.fillText(label, x, y);
    var width = ctx.measureText(label).width;
    ctx.restore();
    return width;
  }

  function pad2(value) {
    var n = Math.max(0, Math.trunc(Number(value) || 0));
    return n < 10 ? "0" + n : String(n);
  }

  function pairingPassword(round, table) {
    return pad2(round || 1) + pad2(table || 1);
  }

  function localTableForPayload(payload, table) {
    return norm(payload && payload.stage).toUpperCase() === "3/4" ? 2 : table;
  }

  function pairingTitle(payload) {
    var stage = norm(payload && payload.stage).toUpperCase();
    if (stage === "SF") return "半决赛";
    if (stage === "F") return "决赛";
    if (stage === "3/4") return "3/4 决赛";
    return "Round " + (payload && payload.round != null ? payload.round : "");
  }

  function drawPassword(ctx, password, x, y, align) {
    ctx.save();
    ctx.textAlign = align || "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#f2d36b";
    ctx.font = "800 21px Arial, sans-serif";
    ctx.fillText(password, x, y);
    ctx.restore();
  }

  function drawPasswordBlock(ctx, password, account, x, y) {
    drawPassword(ctx, password, x, y, "center");
    drawOpponentAccount(ctx, account, x, y + 25, "center", 170);
  }

  function drawByeNotice(ctx, x, y) {
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#f2d36b";
    ctx.font = "700 16px 'Microsoft YaHei', 'PingFang SC', 'Noto Sans SC', Arial, sans-serif";
    ctx.fillText("自动算赢", x, y - 2);
    ctx.font = "700 15px 'Microsoft YaHei', 'PingFang SC', 'Noto Sans SC', Arial, sans-serif";
    ctx.fillText("无需匹配", x, y + 24);
    ctx.restore();
  }

  function buildPairingsCanvas(payload, accountForName) {
    var pairings = payload && payload.blankPairings && payload.blankPairings.length
      ? payload.blankPairings
      : (payload && payload.pairings) || [];
    var resolveAccount = typeof accountForName === "function" ? accountForName : function () { return ""; };
    var scale = Math.max(1, Math.min(3, window.devicePixelRatio || 2));
    var width = 1040;
    var headerHeight = 132;
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
    ctx.fillText(pairingTitle(payload), width / 2, 58);
    ctx.fillStyle = "#d7c77a";
    ctx.font = "600 17px Arial, sans-serif";
    ctx.fillText("四位数字为你本轮的对局密码；密码下方为你对手的OQ账号，若不匹配请及时认输并汇报裁判和对手", width / 2, 92);
    ctx.strokeStyle = "#6d6a66";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, headerHeight - 1);
    ctx.lineTo(width, headerHeight - 1);
    ctx.stroke();

    for (var i = 0; i < pairings.length; i += 1) {
      var row = pairings[i];
      var localTable = localTableForPayload(payload, row.table || i + 1);
      var blackIsBye = isByeName(row.black);
      var whiteIsBye = isByeName(row.white);
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
      ctx.fillText(String(localTable), 48, top + 55);

      if (!blackIsBye) {
        drawChinaFlag(ctx, 84, top + 30, 43, 30);
        drawName(ctx, row.black || "", 138, top + 34, "left", 118);
        if (whiteIsBye) drawByeNotice(ctx, 302, top + 43);
        else drawPasswordBlock(ctx, pairingPassword(payload.round, localTable), row.whiteAccount || resolveAccount(row.white), 302, top + 43);
      }

      drawDisc(ctx, 410, top + 46, 36, "black");
      ctx.fillStyle = "#e8e8e8";
      ctx.font = "800 22px Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("-", 474, top + 54);
      drawDisc(ctx, 538, top + 46, 36, "white");

      if (!whiteIsBye) {
        drawChinaFlag(ctx, 594, top + 30, 43, 30);
        drawName(ctx, row.white || "", 648, top + 34, "left", 118);
        if (blackIsBye) drawByeNotice(ctx, 842, top + 43);
        else drawPasswordBlock(ctx, pairingPassword(payload.round, localTable), row.blackAccount || resolveAccount(row.black), 842, top + 43);
      }
    }

    return canvas;
  }

  return { buildPairingsCanvas: buildPairingsCanvas };
});
