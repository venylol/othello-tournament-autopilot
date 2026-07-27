(function () {
  function norm(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function isNumberText(value) {
    return /^\d+$/.test(String(value || "").trim());
  }

  function safeFilePart(value) {
    return (
      String(value || "")
        .replace(/[\\/:*?"<>|\u0000-\u001F]/g, "_")
        .replace(/\s+/g, "_")
        .replace(/_+/g, "_")
        .replace(/^_+|_+$/g, "")
        .slice(0, 80) || "ftd"
    );
  }

  function downloadBlob(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(url);
      if (a.parentNode) a.parentNode.removeChild(a);
    }, 1000);
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

  function drawName(ctx, name, x, y, align) {
    var lines = splitName(name);
    ctx.save();
    ctx.textAlign = align || "left";
    ctx.fillStyle = "#b7b7b7";
    ctx.font = "700 22px Arial, sans-serif";
    ctx.fillText(lines[0] || "", x, y);
    var width = ctx.measureText(lines[0] || "").width;
    if (lines.length > 1) {
      ctx.font = "600 22px Arial, sans-serif";
      ctx.fillText(lines[1] || "", x, y + 34);
      width = Math.max(width, ctx.measureText(lines[1] || "").width);
    }
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

  function drawPassword(ctx, password, x, y, align) {
    ctx.save();
    ctx.textAlign = align || "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = "#f2d36b";
    ctx.font = "800 21px Arial, sans-serif";
    ctx.fillText(password, x, y);
    ctx.restore();
  }

  function buildPairingsCanvas(payload) {
    var pairings = payload && payload.blankPairings && payload.blankPairings.length
      ? payload.blankPairings
      : (payload && payload.pairings) || [];
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
    ctx.fillText("Round " + (payload.round == null ? "" : payload.round), width / 2, 74);
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
      var blackNameWidth = drawName(ctx, row.black || "", 138, top + 38, "left");
      drawPassword(ctx, pairingPassword(payload.round, row.table || i + 1), 138 + blackNameWidth + 26, top + 55, "left");

      drawDisc(ctx, 415, top + 46, 31, "black");
      ctx.fillStyle = "#e8e8e8";
      ctx.font = "700 24px Arial, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("-", 474, top + 55);
      drawDisc(ctx, 535, top + 46, 31, "white");

      drawChinaFlag(ctx, 594, top + 30, 43, 30);
      var whiteNameWidth = drawName(ctx, row.white || "", 648, top + 38, "left");
      drawPassword(ctx, pairingPassword(payload.round, row.table || i + 1), 648 + whiteNameWidth + 26, top + 55, "left");
    }

    return canvas;
  }

  function downloadPairingsPng(payload, filename) {
    var canvas = buildPairingsCanvas(payload);
    if (canvas.toBlob) {
      canvas.toBlob(function (blob) {
        if (blob) downloadBlob(blob, filename);
      }, "image/png");
    } else {
      var a = document.createElement("a");
      a.href = canvas.toDataURL("image/png");
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      if (a.parentNode) a.parentNode.removeChild(a);
    }
  }

  function showBox(value) {
    var old = document.getElementById("__ftd_json_dump__");
    if (old && old.parentNode) old.parentNode.removeChild(old);
    var box = document.createElement("textarea");
    box.id = "__ftd_json_dump__";
    box.value = value;
    box.setAttribute(
      "style",
      "position:fixed;left:10px;top:10px;width:90vw;height:80vh;z-index:2147483647;background:white;color:black;border:2px solid #111;padding:10px;font:13px monospace;"
    );
    document.body.appendChild(box);
    box.focus();
    box.select();
  }

  function extractFtdRound() {
    var rawLines = String(document.body.innerText || "").split(/\n+/);
    var lines = [];
    var i;
    for (i = 0; i < rawLines.length; i += 1) {
      var line = norm(rawLines[i]);
      if (line) lines.push(line);
    }

    var roundIndex = -1;
    for (i = 0; i < lines.length; i += 1) {
      if (/^Round\s+\d+/i.test(lines[i])) {
        roundIndex = i;
        break;
      }
    }

    var round = null;
    if (roundIndex >= 0) {
      var match = lines[roundIndex].match(/\d+/);
      round = match ? Number(match[0]) : null;
    }

    var pairings = [];
    i = roundIndex >= 0 ? roundIndex + 1 : 0;
    while (i < lines.length) {
      if (!isNumberText(lines[i])) {
        i += 1;
        continue;
      }

      var table = Number(lines[i]);
      i += 1;
      var blackParts = [];
      var whiteParts = [];

      while (i < lines.length && lines[i] !== "-" && !isNumberText(lines[i])) {
        if (!/^(black:|white:)/i.test(lines[i])) blackParts.push(lines[i]);
        i += 1;
      }

      if (lines[i] === "-") i += 1;

      while (i < lines.length && !isNumberText(lines[i])) {
        if (!/^(black:|white:)/i.test(lines[i])) whiteParts.push(lines[i]);
        i += 1;
      }

      if (blackParts.length && whiteParts.length) {
        pairings.push({
          table: table,
          black: blackParts.join(" "),
          white: whiteParts.join(" "),
          blackScore: null,
          whiteScore: null,
        });
      }
    }

    var inputNodes = document.querySelectorAll("input");
    var scoreValues = [];
    for (i = 0; i < inputNodes.length; i += 1) {
      var value = norm(inputNodes[i].value);
      if (isNumberText(value)) scoreValues.push(Number(value));
    }

    for (i = 0; i < pairings.length; i += 1) {
      var blackScore = scoreValues[i * 2];
      var whiteScore = scoreValues[i * 2 + 1];
      if (isFinite(blackScore)) pairings[i].blackScore = blackScore;
      if (isFinite(whiteScore)) pairings[i].whiteScore = whiteScore;
    }

    var blankPairings = [];
    for (i = 0; i < pairings.length; i += 1) {
      blankPairings.push({
        table: pairings[i].table,
        black: pairings[i].black,
        white: pairings[i].white,
        blackScore: null,
        whiteScore: null,
      });
    }

    return {
      source: "ftd-console-dom",
      url: location.href,
      title: document.title,
      exportedAt: new Date().toISOString(),
      competitionName: norm(lines[0] || ""),
      round: round,
      pairings: pairings,
      blankPairings: blankPairings,
      debug: {
        lineCount: lines.length,
        pairingCount: pairings.length,
        scoreInputCount: scoreValues.length,
        scoreValues: scoreValues,
        textLines: lines,
      },
    };
  }

  var payload = extractFtdRound();
  var json = JSON.stringify(payload, null, 2);
  console.log(json);
  if (console.table) console.table(payload.pairings);
  window.__ftdPayload = payload;
  downloadPairingsPng(
    payload,
    "ftd-round-" + safeFilePart(payload.round == null ? "unknown" : String(payload.round)) + "-pairings.png"
  );

  fetch("http://127.0.0.1:4174/api/ftd-round", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: json,
  })
    .then(function (response) {
      return response.json();
    })
    .then(function (result) {
      console.log("FTD local sync result:", result);
      showBox(JSON.stringify({ payload: payload, result: result }, null, 2));
    })
    .catch(function (error) {
      console.error("FTD local sync failed:", error);
      showBox(JSON.stringify({ payload: payload, error: String(error) }, null, 2));
    });
})();
