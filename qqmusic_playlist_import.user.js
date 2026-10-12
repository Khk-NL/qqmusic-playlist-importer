// ==UserScript==
// @name         QQ音乐歌单导入 · 改造版
// @namespace    https://y.qq.com/
// @version      0.2.1
// @downloadURL  https://raw.githubusercontent.com/Khk-NL/qqmusic-playlist-importer/main/qqmusic_playlist_import.user.js
// @updateURL    https://raw.githubusercontent.com/Khk-NL/qqmusic-playlist-importer/main/qqmusic_playlist_import.user.js
// @description  根据 CSV 中的 song,artist 列表批量添加歌曲到指定 QQ 音乐歌单，不存在时自动创建。
// @author       Codex
// @match        https://y.qq.com/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function () {
  "use strict";

  const STORAGE_KEY = "__qqmusic_playlist_import_job_v2__";
  const LAST_PLAYLIST_KEY = "__qqmusic_playlist_import_last_playlist__";
  const PANEL_ID = "qqmusic-playlist-import-panel";
  const STYLE_ID = "qqmusic-playlist-import-style";
  const PROFILE_CREATE_URL = "https://y.qq.com/n/ryqq_v2/profile/create";
  const SEARCH_URL = "https://y.qq.com/n/ryqq_v2/search";
  const POLL_INTERVAL_MS = 1600;
  const MAX_LOGS = 250;

  const runtime = {
    automationLocked: false,
    mounted: false,
    activeJobId: null,
  };

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function nowText() {
    const d = new Date();
    return d.toLocaleTimeString("zh-CN", { hour12: false });
  }

  function safeJsonParse(text, fallback) {
    try {
      return JSON.parse(text);
    } catch (_) {
      return fallback;
    }
  }

  function loadJob() {
    return safeJsonParse(localStorage.getItem(STORAGE_KEY), null);
  }

  function saveJob(job, initial = false) {
    const stored = loadJob();
    if (!initial) {
      if (!stored || stored.id !== job.id) return false;
      // A stop/clear/new task can occur while an async operation is awaiting.
      job.stopRequested = job.stopRequested || stored.stopRequested;
      if (job.stopRequested && job.status === "running") job.status = "stopped";
    }
    job.updatedAt = Date.now();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(job));
    renderPanel();
    return true;
  }

  function assertActive() {
    if (!runtime.activeJobId) return;
    const latest = loadJob();
    if (!latest || latest.id !== runtime.activeJobId || latest.stopRequested || latest.status !== "running") {
      const error = new Error("任务已停止、清除或替换。");
      error.cancelled = true;
      throw error;
    }
  }

  function clearJob() {
    localStorage.removeItem(STORAGE_KEY);
    renderPanel();
  }

  function getLastPlaylistName() {
    return localStorage.getItem(LAST_PLAYLIST_KEY) || "";
  }

  function setLastPlaylistName(name) {
    localStorage.setItem(LAST_PLAYLIST_KEY, name || "");
  }

  function jobLog(job, level, message) {
    if (!job.logs) {
      job.logs = [];
    }
    job.logs.push({
      time: nowText(),
      level,
      message,
    });
    if (job.logs.length > MAX_LOGS) {
      job.logs = job.logs.slice(job.logs.length - MAX_LOGS);
    }
  }

  function withJob(mutator) {
    const job = loadJob();
    if (!job) {
      return null;
    }
    mutator(job);
    saveJob(job);
    return job;
  }

  function isVisible(element) {
    if (!element || !element.isConnected) {
      return false;
    }
    if (element.closest(`#${PANEL_ID}`)) {
      return false;
    }
    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function normalizeText(input) {
    return String(input || "")
      .normalize("NFKC")
      .replace(/[（）]/g, (m) => (m === "（" ? "(" : ")"))
      .replace(/[【】]/g, (m) => (m === "【" ? "[" : "]"))
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .replace(/\u3000/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  }

  function compactText(input) {
    return normalizeText(input).replace(/\s+/g, "");
  }

  function stripActionSuffix(input) {
    return String(input || "")
      .replace(/播放添加到歌单(?:vip下载)?分享.*$/i, "")
      .replace(/播放添加到歌单分享.*$/i, "")
      .replace(/播放分享.*$/i, "")
      .trim();
  }

  function getCleanNodeText(node) {
    if (!node) {
      return "";
    }
    const clone = node.cloneNode(true);
    clone.querySelectorAll(
      [
        "button",
        "i",
        "svg",
        "use",
        ".icon_txt",
        ".mod_list_menu",
        ".list_menu",
        ".songlist__edit",
        ".songlist__number",
        ".songlist__other",
        "[class*='icon']",
        "[class*='mv']",
        "[class*='vip']",
        "[title='MV']",
        "[title='VIP']",
        "[title='SQ']",
        "[title='HQ']",
        "[aria-label='MV']",
        "[aria-label='VIP']",
        "[aria-label='SQ']",
        "[aria-label='HQ']",
      ].join(", ")
    ).forEach((child) => child.remove());
    return String(clone.textContent || "").trim();
  }

  function stripDecorativeTitleParts(input) {
    return String(input || "")
      .replace(/[《【\[][^》】\]]+[》】\]]/g, "")
      .replace(/[（(][^)）]+[)）]\s*$/g, "")
      .replace(/\s*[-|_]\s*.*$/g, "")
      .trim();
  }

  function splitArtists(input) {
    const normalized = String(input || "")
      .replace(/\s+(feat\.?|ft\.?|with)\s+/gi, "/")
      .replace(/[()（）[\]【】]/g, "/")
      .replace(/[、，,&+／/|;；]/g, "/")
      .replace(/\s+x\s+/gi, "/")
      .replace(/\s+/g, " ")
      .trim();
    const parts = normalized
      .split("/")
      .map((item) => normalizeText(item))
      .filter(Boolean);
    return [...new Set(parts)];
  }

  function normalizeArtistName(input) {
    return normalizeText(input);
  }

  function buildArtistTokens(input) {
    return [...new Set(
      splitArtists(input)
        .map((item) => normalizeArtistName(item))
        .filter(Boolean)
    )];
  }

  function getArtistMatchInfo(candidateArtists, targetArtistText) {
    const targetArtists = buildArtistTokens(targetArtistText);
    const compactTargetArtistText = compactText(targetArtistText);
    const candidateTokens = [...new Set(
      (candidateArtists || [])
        .flatMap((item) => buildArtistTokens(item))
        .filter(Boolean)
    )];
    const hasExactArtistText = !!(candidateArtists || []).some(
      (item) => compactText(item) === compactTargetArtistText
    );

    const matchedTargets = targetArtists.filter((target) =>
      candidateTokens.some((candidate) => candidate === target)
    );
    const looselyMatchedTargets = targetArtists.filter((target) =>
      candidateTokens.some((candidate) => candidate === target || candidate.includes(target) || target.includes(candidate))
    );
    const extraCandidates = candidateTokens.filter((candidate) =>
      !targetArtists.some((target) => candidate === target || candidate.includes(target) || target.includes(candidate))
    );

    return {
      targetArtists,
      candidateTokens,
      exactMatchedCount: matchedTargets.length,
      looseMatchedCount: looselyMatchedTargets.length,
      targetCoveredExactly: targetArtists.length > 0 && matchedTargets.length === targetArtists.length,
      targetCoveredLoosely: targetArtists.length > 0 && looselyMatchedTargets.length === targetArtists.length,
      exactSetEqual: targetArtists.length > 0 && matchedTargets.length === targetArtists.length && extraCandidates.length === 0,
      hasExactArtistText,
      extraCount: extraCandidates.length,
    };
  }

  function makeSongKey(song, artist) {
    return `${compactText(song)}||${compactText(artist)}`;
  }

  function parseCsv(text) {
    const rows = [];
    let current = "";
    let row = [];
    let insideQuote = false;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      const next = text[i + 1];
      if (char === '"') {
        if (insideQuote && next === '"') {
          current += '"';
          i += 1;
        } else {
          insideQuote = !insideQuote;
        }
        continue;
      }
      if (!insideQuote && char === ",") {
        row.push(current);
        current = "";
        continue;
      }
      if (!insideQuote && (char === "\n" || char === "\r")) {
        if (char === "\r" && next === "\n") {
          i += 1;
        }
        row.push(current);
        current = "";
        rows.push(row);
        row = [];
        continue;
      }
      current += char;
    }
    row.push(current);
    rows.push(row);
    if (insideQuote) throw new Error("CSV 中存在未闭合的引号。");

    const cleanRows = rows
      .map((cells) => cells.map((cell) => String(cell || "").trim()))
      .filter((cells) => cells.some((cell) => cell !== ""));

    if (cleanRows.length === 0) {
      throw new Error("CSV 文件为空。");
    }

    const header = cleanRows[0].map((cell) => normalizeText(cell));
    const songIndex = header.indexOf("song");
    const artistIndex = header.indexOf("artist");
    if (songIndex === -1 || artistIndex === -1) {
      throw new Error("CSV 表头必须包含 song,artist 两列。");
    }

    const optional = (cells, name) => {
      const index = header.indexOf(name);
      return index < 0 ? "" : (cells[index] || "").trim();
    };
    const seen = new Set();
    const songs = [];
    let duplicateCount = 0;

    for (let i = 1; i < cleanRows.length; i += 1) {
      const cells = cleanRows[i];
      const song = (cells[songIndex] || "").trim();
      const artist = (cells[artistIndex] || "").trim();
      if (!song || !artist) throw new Error(`第 ${i + 1} 行缺少 song 或 artist。`);
      const mid = optional(cells, "mid");
      const date = optional(cells, "date");
      const album = optional(cells, "album");
      const variantValue = optional(cells, "allow_variant").toLowerCase();
      if (mid && !/^[A-Za-z0-9]{14}$/.test(mid)) throw new Error(`第 ${i + 1} 行 mid 无效。`);
      if (date && (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date)) {
        throw new Error(`第 ${i + 1} 行 date 必须是有效的 YYYY-MM-DD。`);
      }
      if (variantValue && !["true", "false", "1", "0"].includes(variantValue)) throw new Error(`第 ${i + 1} 行 allow_variant 无效。`);
      const allowVariant = ["true", "1"].includes(variantValue);
      const key = compactText(song);
      if (seen.has(key)) {
        duplicateCount += 1;
        continue;
      }
      seen.add(key);
      songs.push({
        song,
        artist,
        mid, date, album, allowVariant,
        key,
        status: "pending",
        detail: "",
      });
    }

    if (songs.length === 0) {
      throw new Error("CSV 中没有可导入的 song,artist 数据。");
    }

    return { songs, duplicateCount };
  }

  function planSongs(songs, order = "input", insertion = "head") {
    if (!["input", "date-desc"].includes(order) || !["head", "tail"].includes(insertion)) throw new Error("未知排序设置。");
    const desired = songs.map((item) => ({ ...item }));
    if (order === "date-desc") {
      if (desired.some((item) => !item.date)) throw new Error("按发行日期排序要求每首歌都有 date 列；请先核对日期。");
      desired.sort((a, b) => b.date.localeCompare(a.date));
    }
    desired.forEach((item, index) => { item.desiredIndex = index; });
    return insertion === "head" ? desired.reverse() : desired;
  }

  function buildSummary(job) {
    if (!job) {
      return "暂无任务。";
    }
    const total = job.songs.length;
    const added = job.songs.filter((item) => item.status === "added").length;
    const skipped = job.songs.filter((item) => item.status === "skipped").length;
    const notFound = job.songs.filter((item) => item.status === "not_found").length;
    const ambiguous = job.songs.filter((item) => item.status === "ambiguous").length;
    const failed = job.songs.filter((item) => item.status === "failed").length;
    const matched = job.songs.filter((item) => item.status === "matched").length;
    const header = [
      `状态: ${job.status}`,
      `目标歌单: ${job.playlistName}`,
      `总数: ${total}`,
      `added=${added}`,
      `skipped=${skipped}`,
      `not_found=${notFound}`,
      `ambiguous=${ambiguous}`,
      `failed=${failed}`,
      `matched=${matched}`,
    ].join(" | ");
    const details = job.logs && job.logs.length
      ? job.logs.map((item) => `[${item.time}] ${item.message}`).join("\n")
      : "暂无日志。";
    return `${header}\n\n${details}`;
  }

  function createPanel() {
    if (document.getElementById(PANEL_ID)) {
      return;
    }

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="qqm-import__header">
        <strong>QQ 音乐歌单导入</strong>
        <span class="qqm-import__badge" data-role="status-badge">idle</span>
      </div>
      <label class="qqm-import__label">
        <span>目标歌单名</span>
        <input data-role="playlist-name" type="text" placeholder="例如：周杰伦收藏" />
      </label>
      <label class="qqm-import__label">
        <span>CSV 文件</span>
        <input data-role="csv-file" type="file" accept=".csv,text/csv" />
      </label>
      <label class="qqm-import__label"><span>目标顺序</span>
        <select data-role="order"><option value="input">CSV 原顺序</option><option value="date-desc">发行日期从新到旧（需要 date）</option></select>
      </label>
      <label class="qqm-import__label"><span>QQ 新歌插入位置</span>
        <select data-role="insertion"><option value="head">顶部（倒序执行）</option><option value="tail">末尾（正序执行）</option></select>
      </label>
      <div class="qqm-import__hint" data-role="hint">建议先选“仅预检”。排序需空歌单及确认插入位置，已有歌曲不会被重排。</div>
      <label><input data-role="preview" type="checkbox" checked /> 仅预检，搜索匹配并记录结果，不写入歌单</label>
      <div class="qqm-import__buttons">
        <button data-role="start">开始导入</button>
        <button data-role="resume">继续</button>
        <button data-role="retry">重试未成功项</button>
        <button data-role="export">导出结果</button>
        <button data-role="stop" class="qqm-import__ghost">停止</button>
        <button data-role="copy" class="qqm-import__ghost">复制日志</button>
        <button data-role="clear" class="qqm-import__ghost">清除任务</button>
      </div>
      <div class="qqm-import__progress" data-role="progress">尚未开始。</div>
      <textarea data-role="output" readonly></textarea>
    `;

    document.body.appendChild(panel);

    const playlistInput = panel.querySelector('[data-role="playlist-name"]');
    const fileInput = panel.querySelector('[data-role="csv-file"]');
    const startButton = panel.querySelector('[data-role="start"]');
    const stopButton = panel.querySelector('[data-role="stop"]');
    const copyButton = panel.querySelector('[data-role="copy"]');
    const clearButton = panel.querySelector('[data-role="clear"]');

    playlistInput.value = getLastPlaylistName();

    startButton.addEventListener("click", async () => {
      const playlistName = playlistInput.value.trim();
      const file = fileInput.files && fileInput.files[0];
      if (!playlistName) {
        alert("请先填写目标歌单名。");
        return;
      }
      if (playlistName.length > 20) { alert("QQ 音乐歌单名不能超过 20 个字符。"); return; }
      if (!file) {
        alert("请先选择 CSV 文件。");
        return;
      }
      setLastPlaylistName(playlistName);
      const currentJob = loadJob();
      if (currentJob && currentJob.status === "running") {
        const confirmed = window.confirm("当前已有运行中的任务，是否覆盖并重新开始？");
        if (!confirmed) {
          return;
        }
      }
      try {
        const text = await file.text();
        const parsed = parseCsv(text);
        const job = {
          version: 2,
          id: crypto.randomUUID(),
          preview: panel.querySelector('[data-role="preview"]').checked,
          order: panel.querySelector('[data-role="order"]').value,
          insertion: panel.querySelector('[data-role="insertion"]').value,
          status: "running",
          stopRequested: false,
          playlistName,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          currentIndex: 0,
          playlistEnsured: false,
          ensureAttempts: 0,
          activeQuery: "",
          songs: planSongs(parsed.songs, panel.querySelector('[data-role="order"]').value, panel.querySelector('[data-role="insertion"]').value),
          logs: [],
        };
        jobLog(job, "info", `已载入 ${parsed.songs.length} 首歌曲，目标歌单“${playlistName}”。`);
        if (parsed.duplicateCount > 0) {
          jobLog(job, "info", `已跳过 ${parsed.duplicateCount} 条 CSV 内重复记录。`);
        }
        saveJob(job, true);
        fileInput.value = "";
        await runAutomation();
      } catch (error) {
        console.error(error);
        alert(`导入任务创建失败：${error.message}`);
      }
    });

    panel.querySelector('[data-role="resume"]').addEventListener("click", () => {
      if (runtime.automationLocked) return;
      const job = loadJob();
      if (job) { job.stopRequested = false; job.status = "running"; saveJob(job, true); }
    });
    panel.querySelector('[data-role="retry"]').addEventListener("click", () => {
      if (runtime.automationLocked) return;
      const job = loadJob();
      if (!job || job.status === "running") return;
      if (job.order === "date-desc" && !job.preview && [...job.songs, ...(job.history || [])].some((item) => item.status === "added" || item.status === "skipped")) {
        alert("部分歌曲已写入，单独补加会破坏发行日期顺序。请导出结果、补齐清单后使用新空歌单重新导入。");
        return;
      }
      const remaining = job.songs.filter((item) => !["added", "skipped", "matched"].includes(item.status));
      if (!remaining.length) return;
      job.id = crypto.randomUUID();
      job.history = [...(job.history || []), ...job.songs.filter((item) => ["added", "skipped", "matched"].includes(item.status))];
      job.songs = remaining.map((item) => ({ ...item, status: "pending", detail: "" }));
      job.currentIndex = 0; job.stopRequested = false; job.status = "running";
      saveJob(job, true);
    });
    panel.querySelector('[data-role="export"]').addEventListener("click", () => {
      const job = loadJob();
      if (!job) return;
      const link = document.createElement("a");
      const url = URL.createObjectURL(new Blob([JSON.stringify(job, null, 2)], { type: "application/json" }));
      link.href = url; link.download = "qqmusic-import-result.json"; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    stopButton.addEventListener("click", () => {
      withJob((job) => {
        job.stopRequested = true;
        jobLog(job, "warn", "已收到停止请求，将在当前步骤结束后停止。");
      });
    });

    copyButton.addEventListener("click", async () => {
      const summary = buildSummary(loadJob());
      try {
        await navigator.clipboard.writeText(summary);
        const hint = panel.querySelector('[data-role="hint"]');
        hint.textContent = "日志已复制到剪贴板。";
        setTimeout(() => renderPanel(), 1200);
      } catch (error) {
        console.error(error);
        alert("复制失败，请手动从文本框中复制。");
      }
    });

    clearButton.addEventListener("click", () => {
      const job = loadJob();
      if (job && job.status === "running") {
        const confirmed = window.confirm("任务仍在运行中，确认清除吗？");
        if (!confirmed) {
          return;
        }
      }
      clearJob();
    });
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) {
      return;
    }
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${PANEL_ID} {
        position: fixed;
        right: 16px;
        bottom: 16px;
        z-index: 2147483647;
        width: 340px;
        background: rgba(20, 25, 28, 0.96);
        color: #f5f7f8;
        border: 1px solid rgba(255, 255, 255, 0.14);
        border-radius: 14px;
        box-shadow: 0 18px 50px rgba(0, 0, 0, 0.35);
        backdrop-filter: blur(10px);
        padding: 14px;
        font: 13px/1.5 -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
      }
      #${PANEL_ID} * {
        box-sizing: border-box;
      }
      #${PANEL_ID} { max-height: calc(100vh - 36px); overflow-y: auto; }
      #${PANEL_ID} select { width: 100%; padding: 9px; color: #f5f7f8; background: #253139; border-radius: 10px; }
      #${PANEL_ID} .qqm-import__header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 10px;
        font-size: 14px;
      }
      #${PANEL_ID} .qqm-import__badge {
        padding: 2px 8px;
        border-radius: 999px;
        background: rgba(255, 255, 255, 0.12);
        color: #fff;
        font-size: 12px;
      }
      #${PANEL_ID} .qqm-import__label {
        display: block;
        margin-bottom: 8px;
      }
      #${PANEL_ID} .qqm-import__label span {
        display: block;
        margin-bottom: 4px;
        color: #cfd7db;
      }
      #${PANEL_ID} input[type="text"],
      #${PANEL_ID} input[type="file"],
      #${PANEL_ID} textarea {
        width: 100%;
        border: 1px solid rgba(255, 255, 255, 0.18);
        background: rgba(255, 255, 255, 0.06);
        color: #fff;
        border-radius: 10px;
        outline: none;
      }
      #${PANEL_ID} input[type="text"],
      #${PANEL_ID} input[type="file"] {
        padding: 9px 10px;
      }
      #${PANEL_ID} textarea {
        min-height: 160px;
        resize: vertical;
        padding: 10px;
        margin-top: 8px;
      }
      #${PANEL_ID} .qqm-import__buttons {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 8px;
        margin-top: 10px;
      }
      #${PANEL_ID} button {
        border: 0;
        border-radius: 10px;
        padding: 9px 10px;
        cursor: pointer;
        background: #31c27c;
        color: #07130d;
        font-weight: 600;
      }
      #${PANEL_ID} .qqm-import__ghost {
        background: rgba(255, 255, 255, 0.12);
        color: #f5f7f8;
      }
      #${PANEL_ID} .qqm-import__hint,
      #${PANEL_ID} .qqm-import__progress {
        color: #a9b7be;
        font-size: 12px;
      }
      #${PANEL_ID} .qqm-import__progress {
        margin-top: 10px;
        white-space: pre-wrap;
      }
    `;
    document.head.appendChild(style);
  }

  function renderPanel() {
    const panel = document.getElementById(PANEL_ID);
    if (!panel) {
      return;
    }
    const job = loadJob();
    const badge = panel.querySelector('[data-role="status-badge"]');
    const output = panel.querySelector('[data-role="output"]');
    const progress = panel.querySelector('[data-role="progress"]');
    const hint = panel.querySelector('[data-role="hint"]');
    const playlistInput = panel.querySelector('[data-role="playlist-name"]');

    if (playlistInput && !playlistInput.value) {
      playlistInput.value = getLastPlaylistName();
    }

    if (!job) {
      badge.textContent = "idle";
      hint.textContent = "建议先预检。排序需空歌单及确认插入位置；已有歌曲不会重排。";
      progress.textContent = "尚未开始。";
      output.value = "暂无任务。";
      return;
    }

    const added = job.songs.filter((item) => item.status === "added").length;
    const skipped = job.songs.filter((item) => item.status === "skipped").length;
    const notFound = job.songs.filter((item) => item.status === "not_found").length;
    const ambiguous = job.songs.filter((item) => item.status === "ambiguous").length;
    const failed = job.songs.filter((item) => item.status === "failed").length;
    const current = job.songs[job.currentIndex];

    badge.textContent = job.status;
    hint.textContent = `${job.preview ? "仅预检" : "写入"}：${job.playlistName}；${job.order === "date-desc" ? "发行日期从新到旧" : "CSV 顺序"}。最终顺序仍需核对。`;
    progress.textContent = [
      `进度：${Math.min(job.currentIndex, job.songs.length)}/${job.songs.length}`,
      `当前：${current ? `${current.song} - ${current.artist}` : "无"}`,
      `统计：added=${added}, skipped=${skipped}, not_found=${notFound}, ambiguous=${ambiguous}, failed=${failed}, matched=${job.songs.filter((item) => item.status === "matched").length}`,
    ].join("\n");
    output.value = buildSummary(job);
  }

  function findByVisibleText(texts, root = document.body) {
    const targets = Array.isArray(texts) ? texts : [texts];
    const normalizedTargets = targets.map((item) => normalizeText(item));
    const nodes = root.querySelectorAll("button, a, span, div, li");
    for (const node of nodes) {
      if (!isVisible(node)) {
        continue;
      }
      const content = normalizeText(node.textContent);
      if (!content) {
        continue;
      }
      if (normalizedTargets.includes(content)) {
        return node;
      }
    }
    return null;
  }

  function findClickableAncestor(element) {
    if (!element) {
      return null;
    }
    return element.closest("button, a, li, div");
  }

  function dispatchInputEvents(element) {
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function setNativeValue(element, value) {
    const prototype = Object.getPrototypeOf(element);
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "value");
    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
    dispatchInputEvents(element);
  }

  async function clickElement(element) {
    if (!element) {
      throw new Error("点击目标不存在。");
    }
    assertActive();
    element.scrollIntoView({ block: "center", behavior: "smooth" });
    await sleep(120);
    element.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    element.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await sleep(80);
    assertActive();
    element.click();
    await sleep(160);
  }

  async function waitFor(fn, timeout = 8000, interval = 160) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      assertActive();
      const result = fn();
      if (result) {
        return result;
      }
      await sleep(interval);
    }
    return null;
  }

  function currentSearchQuery() {
    const params = new URLSearchParams(location.search);
    return params.get("w") || "";
  }

  function isOnCreatePage() {
    return location.pathname.includes("/n/ryqq_v2/profile/create");
  }

  function isOnSearchPage() {
    return location.pathname.includes("/n/ryqq_v2/search");
  }

  function isOnPlaylistDetailPage() {
    return location.pathname.includes("/n/ryqq_v2/playlist/");
  }

  function isLoggedIn() {
    if (document.querySelector(".profile_unlogin__btn")) return false;
    return !!document.querySelector('a[href="/n/ryqq_v2/profile"] img, .js_userInfo_img');
  }

  function navigate(url) {
    if (location.href === url) {
      return false;
    }
    assertActive();
    location.assign(url);
    return true;
  }

  function buildSearchUrl(song, artist) {
    const query = `${song} ${artist}`.trim();
    return `${SEARCH_URL}?w=${encodeURIComponent(query)}&t=song`;
  }

  function findPlaylistRowByName(playlistName) {
    const rows = [...document.querySelectorAll(".playlist__item")].filter((row) => {
      const title = row.querySelector(".playlist__title_txt a");
      return title && normalizeText(title.textContent) === normalizeText(playlistName);
    });
    if (rows.length > 1) throw new Error("存在多个同名歌单，请先改成唯一名称。");
    return rows[0] || null;
  }

  function findCreatePlaylistInput() {
    const input = document.querySelector('[role="dialog"] #new_playlist');
    return isVisible(input) ? input : null;
  }

  async function ensurePlaylist(job) {
    if (!isOnCreatePage()) {
      jobLog(job, "info", "正在跳转到“我创建的歌单”页。");
      saveJob(job);
      navigate(PROFILE_CREATE_URL);
      return false;
    }

    const ready = await waitFor(
      () => document.querySelector(".playlist_toolbar") || document.querySelector("#create_tab"),
      10000
    );
    if (!ready) {
      job.ensureAttempts += 1;
      if (job.ensureAttempts > 4) throw new Error("自建歌单页连续加载超时，请检查页面和登录状态。");
      jobLog(job, "warn", "等待歌单页加载超时，稍后重试。");
      return false;
    }

    const currentTab = document.querySelector("#create_tab");
    if (currentTab && !currentTab.classList.contains("mod_tab__current")) {
      await clickElement(currentTab);
      await sleep(400);
    }

    const existing = findPlaylistRowByName(job.playlistName);
    if (existing) {
      job.playlistUrl = existing.querySelector(".playlist__title_txt a").href;
      const count = Number((existing.querySelector(".playlist__number")?.textContent || "").replace(/\D/g, ""));
      if (job.order === "date-desc" && count > 0) throw new Error("发行日期排序请使用空歌单；重复添加已有歌曲不能保证重排。");
      job.playlistEnsured = true;
      jobLog(job, "info", `已确认目标歌单“${job.playlistName}”存在。`);
      return true;
    }

    job.ensureAttempts += 1;
    if (job.ensureAttempts > 4) {
      throw new Error(`连续 ${job.ensureAttempts} 次未能确认歌单创建成功。`);
    }

    jobLog(job, "info", `未找到歌单“${job.playlistName}”，开始尝试创建。`);
    const createButton = document.querySelector(".js_create_new") || findByVisibleText("新建歌单");
    if (!createButton) {
      throw new Error("未找到“新建歌单”按钮。");
    }
    await clickElement(createButton);

    const input = await waitFor(() => findCreatePlaylistInput(), 6000);
    if (!input) {
      throw new Error("未找到新建歌单输入框。");
    }
    setNativeValue(input, job.playlistName);
    await sleep(150);

    const submitButton = document.querySelector('[role="dialog"] .popup_new_list .popup__ft .mod_btn_green');
    if (!submitButton) {
      throw new Error("未找到新建歌单确认按钮。");
    }
    await clickElement(submitButton);
    await sleep(1200);

    if (isOnPlaylistDetailPage()) {
      jobLog(job, "info", "歌单创建后已进入歌单详情页，返回歌单列表确认。");
      saveJob(job);
      navigate(PROFILE_CREATE_URL);
      return false;
    }

    const created = await waitFor(() => findPlaylistRowByName(job.playlistName), 5000);
    if (created) {
      job.playlistUrl = created.querySelector(".playlist__title_txt a").href;
      job.playlistEnsured = true;
      jobLog(job, "info", `已创建歌单“${job.playlistName}”。`);
      return true;
    }

    jobLog(job, "warn", "创建歌单后暂未在列表中看到结果，将稍后再次确认。");
    return false;
  }

  function collectCandidateArtists(row) {
    return [...row.querySelectorAll(".songlist__artist a")].map((node) => normalizeText(node.getAttribute("title") || node.textContent)).filter(Boolean);
  }

  function getSongLinkFromRow(row) {
    const selectors = [
      ".songlist__songname_txt a",
      ".songlist__songname a",
      "a[href*='/songDetail/']",
      "a[href*='playsong.html']",
      "a[href*='songid=']",
    ];
    for (const selector of selectors) {
      const node = row.querySelector(selector);
      if (node && isVisible(node)) {
        return node;
      }
    }
    return null;
  }

  function getRawTitleFromRow(row) {
    const link = getSongLinkFromRow(row);
    if (link) {
      const titleText =
        link.getAttribute("title") ||
        link.getAttribute("data-title") ||
        link.getAttribute("aria-label") ||
        getCleanNodeText(link) ||
        link.textContent ||
        "";
      if (String(titleText).trim()) {
        return String(titleText).trim();
      }
    }

    const selectors = [
      ".songlist__songname_txt a",
      ".songlist__songname a",
      ".songlist__songname_txt",
      ".songlist__songname",
      ".songlist__title",
      ".songlist__title_txt",
    ];
    for (const selector of selectors) {
      const node = row.querySelector(selector);
      if (node && isVisible(node)) {
        const text = node.getAttribute("title") || getCleanNodeText(node) || node.textContent || "";
        if (text.trim()) {
          return text.trim();
        }
      }
    }
    return "";
  }

  function cleanCandidateTitle(input) {
    return normalizeText(
      stripActionSuffix(String(input || ""))
        .replace(/^(?:mv|vip|sq|hq)\b\s*/gi, "")
        .replace(/^\s*(?:mv|vip|sq|hq)\b/gi, "")
        .trim()
    );
  }

  function getBaseCandidateTitle(input) {
    return normalizeText(stripDecorativeTitleParts(cleanCandidateTitle(input)));
  }

  function hasVariantHint(text) {
    return /\b(?:dj|live|remix|mix|instrumental|karaoke|demo|cover)\b|伴奏|钢琴|纯音乐|合唱|现场|翻唱|改编|剪辑|片段|铃声|广场舞/i.test(normalizeText(text));
  }

  function isLikelyMvCandidate(row, title, link) {
    const href = (link && link.getAttribute("href")) || "";
    return href.includes("/mv/") || !!row.closest(".mv_list__item");
  }

  function extractCandidate(row) {
    const songLink = getSongLinkFromRow(row);
    const rawTitle = getRawTitleFromRow(row);
    const title = cleanCandidateTitle(rawTitle);
    const baseTitle = getBaseCandidateTitle(rawTitle);
    const artists = collectCandidateArtists(row);
    let addButton =
      row.querySelector(".list_menu__add") ||
      row.querySelector('[title="添加到歌单"]') ||
      row.querySelector(".mod_list_menu a:nth-child(2)");

    if (!addButton) {
      const addNode = findByVisibleText("添加到歌单", row);
      addButton = findClickableAncestor(addNode);
    }

    return {
      row,
      rawTitle,
      title,
      baseTitle,
      artists,
      songLink,
      mid: songLink?.getAttribute("href")?.match(/\/songDetail\/([A-Za-z0-9]{14})/)?.[1] || "",
      album: row.querySelector(".songlist__album a")?.textContent?.trim() || "",
      isVariant: hasVariantHint(rawTitle) || (!!baseTitle && compactText(baseTitle) !== compactText(title)),
      isLikelyMv: isLikelyMvCandidate(row, rawTitle, songLink),
      addButton,
    };
  }

  function dedupeCandidates(candidates) {
    const unique = new Map();
    for (const candidate of candidates) {
      if (!candidate.mid) continue;
      if (!unique.has(candidate.mid)) unique.set(candidate.mid, candidate);
    }
    return [...unique.values()];
  }

  function findSearchRows() {
    const root =
      document.querySelector(".result .mod_songlist") ||
      document.querySelector(".main .mod_songlist") ||
      document.querySelector(".mod_songlist");
    const searchScope = root || document;
    const directRows = Array.from(
      searchScope.querySelectorAll(".songlist__item, .mod_songlist li, [class*='songlist__item']")
    )
      .filter((row) => isVisible(row))
      .filter((row) => row.querySelector(".songlist__songname, .songlist__songname_txt"))
      .filter((row) => row.querySelector(".list_menu__add, [title='添加到歌单'], .mod_list_menu"));
    if (directRows.length > 0) {
      return [...new Set(directRows)];
    }

    const addButtons = Array.from(
      searchScope.querySelectorAll(".list_menu__add, [title='添加到歌单']")
    ).filter((button) => isVisible(button));
    return [...new Set(addButtons
      .map((button) => button.closest("li, .songlist__item, .playlist__item, .mod_songlist"))
      .filter(Boolean))];
  }

  function chooseCandidate(candidates, song, artist, options = {}) {
    const eligible = dedupeCandidates(candidates).filter((candidate) => {
      if (candidate.isLikelyMv || compactText(candidate.title) !== compactText(song)) return false;
      const info = getArtistMatchInfo(candidate.artists, artist);
      if (!info.targetCoveredExactly) return false;
      if (options.mid && options.mid !== candidate.mid) return false;
      if (options.album && compactText(options.album) !== compactText(candidate.album)) return false;
      if ((hasVariantHint(candidate.title) || hasVariantHint(candidate.album)) && !options.allowVariant) return false;
      return true;
    });
    if (eligible.length === 1) return { type: "selected", candidate: eligible[0] };
    return { type: eligible.length ? "ambiguous" : "not_found", candidates: eligible };
  }

  async function revealRowActions(row) {
    row.classList.add("songlist__item--hover", "playlist__item--hover");
    row.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
    row.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
    await sleep(140);
  }

  function findOperateMenu() {
    return Array.from(document.querySelectorAll(".mod_operate_menu"))
      .find((node) => isVisible(node) && !node.closest(`#${PANEL_ID}`)) || null;
  }

  function getVisibleOperateMenus() {
    return Array.from(document.querySelectorAll(".mod_operate_menu"))
      .filter((node) => isVisible(node) && !node.closest(`#${PANEL_ID}`));
  }

  function findPlaylistChoiceInMenu(menu, playlistName) {
    const nodes = [...menu.querySelectorAll('ul[role="menu"] .operate_menu__link')].filter((node) =>
      isVisible(node) && normalizeText(node.getAttribute("title") || node.textContent) === normalizeText(playlistName));
    if (nodes.length > 1) throw new Error("添加菜单中存在多个同名歌单，已停止。");
    return nodes[0] || null;
  }

  function getPopupTipText() {
    const tips = Array.from(document.querySelectorAll(".mod_popup_tips, #popup"))
      .filter((node) => isVisible(node) && !node.closest(`#${PANEL_ID}`));
    const latest = tips[tips.length - 1];
    return latest ? normalizeText(latest.textContent || "") : "";
  }

  async function addCandidateToPlaylist(candidate, playlistName) {
    assertActive();
    if (!document.querySelector(".songlist__item input[type='checkbox']")) {
      const batch = document.querySelector(".mod_btn__icon_batch")?.closest("a");
      if (!batch) throw new Error("当前网页没有批量操作入口。");
      await clickElement(batch);
      await waitFor(() => document.querySelector(".songlist__item input[type='checkbox']"), 5000);
    }
    const selectedRow = [...document.querySelectorAll(".songlist__item")].find((row) =>
      getSongLinkFromRow(row)?.getAttribute("href")?.includes(`/songDetail/${candidate.mid}`));
    if (!selectedRow) throw new Error("候选歌曲已不在当前结果中。");
    // Click the checkbox rather than assigning checked: QQ must receive its normal events.
    for (const box of document.querySelectorAll(".songlist__item input[type='checkbox']")) {
      const wanted = selectedRow.contains(box);
      if (box.checked !== wanted) await clickElement(box);
    }
    const checked = [...document.querySelectorAll(".songlist__item input[type='checkbox']")].filter((box) => box.checked);
    if (checked.length !== 1 || !selectedRow.contains(checked[0])) throw new Error("无法确认仅选中了目标歌曲。");
    const add = document.querySelector(".mod_songlist_toolbar .mod_btn__icon_add")?.closest("a");
    if (!add) throw new Error("未找到批量添加入口。");
    await clickElement(add);
    const menu = await waitFor(() => getVisibleOperateMenus().find((node) => node.id === "fav_pop"), 5000);
    if (!menu) throw new Error("未打开歌单菜单。");
    const choice = await waitFor(() => findPlaylistChoiceInMenu(menu, playlistName), 8000);
    if (!choice) throw new Error("未找到名称完全一致的目标歌单。");
    let freshTip = "";
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        const node = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        if (node?.closest(".mod_popup_tips, #popup") || [...record.addedNodes].some((n) => n.nodeType === 1 && (n.matches(".mod_popup_tips, #popup") || n.querySelector(".mod_popup_tips, #popup")))) {
          freshTip = getPopupTipText();
        }
      }
    });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "style"] });
    try {
      await clickElement(choice);
      const result = await waitFor(() => {
        if (/已在歌单中|已经在歌单中/.test(freshTip)) return "skipped";
        if (/添加成功|成功加入歌单|已收藏到歌单/.test(freshTip)) return "added";
        if (/失败|登录|错误/.test(freshTip)) throw new Error(freshTip);
        return null;
      }, 8000, 150);
      if (!result) throw new Error("未检测到本次添加的成功提示；结果待核对，不自动重试。");
      return result;
    } finally { observer.disconnect(); }
  }

  async function processCurrentSong(job) {
    const current = job.songs[job.currentIndex];
    if (!current) {
      job.status = "finished";
      jobLog(job, "info", "任务完成。");
      return;
    }

    const expectedQuery = `${current.song} ${current.artist}`.trim();
    if (!isOnSearchPage() || compactText(currentSearchQuery()) !== compactText(expectedQuery)) {
      job.activeQuery = expectedQuery;
      jobLog(job, "info", `正在搜索：${current.song} - ${current.artist}`);
      saveJob(job);
      navigate(buildSearchUrl(current.song, current.artist));
      return;
    }

    const ready = await waitFor(
      () => document.querySelector(".mod_search_none") || findSearchRows().length > 0,
      12000
    );
    if (!ready) {
      current.status = "failed";
      current.detail = "等待搜索结果超时";
      job.currentIndex += 1;
      jobLog(job, "error", `搜索超时：${current.song} - ${current.artist}`);
      return;
    }

    if (document.querySelector(".mod_search_none")) {
      current.status = "not_found";
      current.detail = "搜索结果为空";
      job.currentIndex += 1;
      jobLog(job, "warn", `未找到：${current.song} - ${current.artist}`);
      return;
    }

    const rows = findSearchRows();
    const candidates = rows.map(extractCandidate).filter((candidate) => candidate.addButton);
    const decision = chooseCandidate(candidates, current.song, current.artist, current);

    if (decision.type === "not_found") {
      current.status = "not_found";
      current.detail = "没有符合保守匹配规则的候选";
      job.currentIndex += 1;
      jobLog(job, "warn", `未找到匹配项：${current.song} - ${current.artist}`);
      return;
    }

    if (decision.type === "ambiguous") {
      current.status = "ambiguous";
      current.detail = "存在多个候选，已跳过";
      job.currentIndex += 1;
      const sample = (decision.candidates || [])
        .map((item) => {
          const flags = [
            item.titleExact ? "exact" : "",
            item.baseTitleExact ? "base" : "",
            item.artistExactSet ? "artist_set" : "",
            item.artistTextExact ? "artist_text" : "",
            item.artistExtraCount > 0 ? `extra${item.artistExtraCount}` : "",
            item.isVariant ? "variant" : "",
            item.isLikelyMv ? "mv" : "",
          ].filter(Boolean).join(",");
          return `${item.title || item.rawTitle} / ${(item.artists || []).join("&") || "未知歌手"}${flags ? ` [${flags}]` : ""}`;
        })
        .join(" | ");
      jobLog(
        job,
        "warn",
        `候选歧义，已跳过：${current.song} - ${current.artist}${sample ? `；候选：${sample}` : ""}`
      );
      return;
    }

    current.matched = { mid: decision.candidate.mid, title: decision.candidate.title, artists: decision.candidate.artists, album: decision.candidate.album };
    if (job.preview) {
      current.status = "matched"; current.detail = "预检匹配成功，未写入";
      job.currentIndex += 1;
      jobLog(job, "info", `预检匹配：${current.song} / ${decision.candidate.mid}`);
      return;
    }
    try {
      const result = await addCandidateToPlaylist(decision.candidate, job.playlistName);
      current.status = result;
      current.detail = result === "skipped" ? "歌曲可能已存在于歌单中" : "添加成功";
      job.currentIndex += 1;
      jobLog(
        job,
        result === "skipped" ? "warn" : "info",
        `${result === "skipped" ? "跳过" : "已添加"}：${current.song} - ${current.artist}`
      );
    } catch (error) {
      if (error.cancelled) throw error;
      current.status = "failed";
      current.detail = error.message;
      job.currentIndex += 1;
      jobLog(job, "error", `添加失败：${current.song} - ${current.artist}，${error.message}`);
    }
  }

  async function runAutomation() {
    if (runtime.automationLocked || loadJob()?.status !== "running") return;
    if (!navigator.locks) {
      withJob((job) => { job.status = "error"; jobLog(job, "error", "浏览器缺少 Web Locks，不能安全协调多个标签页。"); });
      return;
    }
    runtime.automationLocked = true;
    try {
      await navigator.locks.request("qqmusic-import-v2", { ifAvailable: true }, async (lock) => {
        if (!lock) return;
        const job = loadJob();
        if (!job || job.status !== "running") return;
        runtime.activeJobId = job.id;
        try {
          assertActive();
          if (!isLoggedIn()) throw new Error("未检测到 QQ 音乐登录状态，请先在网页登录。");
          if (!job.preview && !job.playlistEnsured) {
            const ensured = await ensurePlaylist(job);
            saveJob(job);
            if (!ensured) return;
          }
          if (job.currentIndex < job.songs.length) await processCurrentSong(job);
          if (job.currentIndex >= job.songs.length) {
            job.status = "finished";
            jobLog(job, "info", job.preview ? "预检结束，请核对导出结果。" : "处理结束，请核对未成功项及歌单实际顺序。");
          }
          saveJob(job);
        } catch (error) {
          const current = loadJob();
          if (current?.id === job.id) {
            current.status = error.cancelled ? "stopped" : "error";
            jobLog(current, error.cancelled ? "warn" : "error", error.message);
            saveJob(current);
          }
        } finally { runtime.activeJobId = null; }
      });
    } finally { runtime.automationLocked = false; }
  }

  function bootstrap() {
    if (!document.body || runtime.mounted) {
      return;
    }
    runtime.mounted = true;
    ensureStyle();
    createPanel();
    renderPanel();

    setInterval(() => {
      renderPanel();
      runAutomation().catch((error) => console.error(error));
    }, POLL_INTERVAL_MS);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bootstrap, { once: true });
  } else {
    bootstrap();
  }
})();
