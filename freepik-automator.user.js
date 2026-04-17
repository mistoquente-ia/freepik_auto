// ==UserScript==
// @name         @andrevidmob
// @namespace    https://tampermonkey.net/
// @version      1.0.0
// @description  Automatiza fila de prompts no Freepik (gerar + baixar + proximo), com painel de personalizacao.
// @author       Andre + Codex
// @match        https://freepik.com/*
// @match        https://www.freepik.com/*
// @match        https://*.freepik.com/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'myBabyRunner:v1';
  const PANEL_ID = 'my-baby-runner-panel';
  const STYLE_ID = 'my-baby-runner-style';
  const LAUNCHER_ID = 'my-baby-runner-launcher';
  const YOUTUBE_URL = 'https://www.youtube.com/@andrevidmob';
  const INSTAGRAM_URL = 'https://www.instagram.com/andrevidmob/';
  const REFERRAL_URL = 'https://referral.freepik.com/mQMBJvX';
  const CUSTOM_MODEL_VALUE = '__custom__';
  const MODEL_PRESETS = [
    'Nano Banana 2',
    'Nano Banana Pro',
    'Flux 1.1 Pro',
    'Seedream 5 Lite',
    'Imagen 4',
    'Mystic 2.5'
  ];
  const BOOT_TIMEOUT_MS = 30000;
  const BOOT_RETRY_MS = 700;

  const DEFAULTS = {
    modelPreset: 'Nano Banana 2',
    modelName: 'Nano Banana 2',
    promptsText: '',
    aspectRatio: 'keep',
    quality: 'keep',
    autoDownload: false,
    autoApplyModel: true,
    autoOpenPersonalization: true,
    minWaitBeforeDownloadMs: 9000,
    delayBetweenPromptsMs: 1600,
    maxWaitPerImageSec: 180
  };

  const state = {
    running: false,
    stopRequested: false,
    ui: null,
    bootStartedAt: 0,
    bootTimer: null,
    observer: null
  };

  // ---------- Storage ----------

  function readSetting(key, fallback) {
    try {
      if (typeof GM_getValue === 'function') return GM_getValue(key, fallback);
    } catch (_) {}

    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (_) {
      return fallback;
    }
  }

  function writeSetting(key, value) {
    try {
      if (typeof GM_setValue === 'function') {
        GM_setValue(key, value);
        return;
      }
    } catch (_) {}

    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (_) {}
  }

  function loadConfig() {
    const saved = readSetting(STORAGE_KEY, null);
    if (!saved || typeof saved !== 'object') return { ...DEFAULTS };
    const migrated = { ...saved };
    if (typeof migrated.autoApplyModel === 'undefined' && typeof migrated.autoApplyTemplateModel !== 'undefined') {
      migrated.autoApplyModel = migrated.autoApplyTemplateModel;
    }

    if (typeof migrated.modelPreset === 'undefined') {
      const savedModel = (migrated.modelName || '').trim();
      if (savedModel && MODEL_PRESETS.includes(savedModel)) {
        migrated.modelPreset = savedModel;
      } else {
        migrated.modelPreset = CUSTOM_MODEL_VALUE;
      }
    }

    return { ...DEFAULTS, ...migrated };
  }

  function saveConfig(cfg) {
    writeSetting(STORAGE_KEY, cfg);
  }

  // ---------- Utils ----------

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  function normalize(text) {
    return (text || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  function escapeRegExp(text) {
    return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function isVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function textFromElement(el) {
    const parts = [
      el?.innerText,
      el?.textContent,
      el?.getAttribute?.('aria-label'),
      el?.getAttribute?.('title'),
      el?.getAttribute?.('data-testid')
    ].filter(Boolean);
    return normalize(parts.join(' '));
  }

  function isRunnerElement(el) {
    return !!el?.closest?.(`#${PANEL_ID}`);
  }

  function getClickableCandidates(root = document) {
    const selector = [
      'button',
      'a',
      '[role="button"]',
      '[role="menuitem"]',
      '[aria-label]',
      '[data-testid]',
      'li',
      'div[tabindex]'
    ].join(',');

    return Array.from(root.querySelectorAll(selector)).filter(isVisible);
  }

  function getTextMatchScore(candidateText, targetText, useTokenMatch = false) {
    const candidate = normalize(candidateText);
    const target = normalize(targetText);
    if (!candidate || !target) return -1;

    if (candidate === target) return 1000;
    if (candidate.startsWith(`${target} `)) return 850;
    if (candidate.endsWith(` ${target}`)) return 830;
    if (candidate.includes(` ${target} `)) return 800;

    if (useTokenMatch) {
      const tokenRe = new RegExp(`(^|\\s|[\\[\\(])${escapeRegExp(target)}($|\\s|[\\]\\),.;:!?])`);
      if (tokenRe.test(candidate)) return 740;
    }

    if (candidate.includes(target)) return 620;
    return -1;
  }

  function hasMatchingChildClickable(el, normalizedTargets, useTokenMatch) {
    if (!el || !normalizedTargets.length) return false;
    const childClicks = Array.from(el.querySelectorAll('button, a, [role="button"], [role="menuitem"]'));
    for (const child of childClicks) {
      if (child === el || !isVisible(child)) continue;
      const childText = textFromElement(child);
      if (!childText) continue;
      const childMatched = normalizedTargets.some((target) => getTextMatchScore(childText, target, useTokenMatch) > -1);
      if (childMatched) return true;
    }
    return false;
  }

  function findClickableByTexts(texts, options = {}) {
    const opts = {
      exact: false,
      root: document,
      mustIncludeOne: [],
      reject: null,
      preferElement: null,
      tokenMatch: false,
      maxTextLength: 0,
      avoidTexts: [],
      avoidContainers: false,
      ...options
    };

    const normalizedTexts = texts.map(normalize).filter(Boolean);
    const mustIncludeOne = opts.mustIncludeOne.map(normalize).filter(Boolean);
    const avoidTexts = opts.avoidTexts.map(normalize).filter(Boolean);

    if (!normalizedTexts.length) return null;

    const candidates = getClickableCandidates(opts.root);

    let best = null;
    let bestScore = -Infinity;

    for (const el of candidates) {
      if (el.closest(`#${PANEL_ID}`)) continue;

      const t = textFromElement(el);
      if (!t) continue;

      if (typeof opts.reject === 'function' && opts.reject(el, t)) {
        continue;
      }

      if (opts.maxTextLength && t.length > opts.maxTextLength) continue;
      if (avoidTexts.some((bad) => t.includes(bad))) continue;

      let matchScore = -1;
      for (const needle of normalizedTexts) {
        if (!needle) continue;
        const score = opts.exact
          ? (t === needle ? 1000 : -1)
          : getTextMatchScore(t, needle, opts.tokenMatch);
        if (score > matchScore) matchScore = score;
      }

      if (matchScore < 0) continue;

      if (mustIncludeOne.length && !mustIncludeOne.some((needle) => t.includes(needle))) {
        continue;
      }

      if (opts.avoidContainers && hasMatchingChildClickable(el, normalizedTexts, opts.tokenMatch)) {
        continue;
      }

      const rect = el.getBoundingClientRect();
      // Prioriza elementos com texto mais enxuto (mais chance de ser o botao alvo)
      let score = (matchScore * 4) + (1000 - t.length - Math.abs(rect.top));

      if (opts.preferElement && isVisible(opts.preferElement)) {
        const prefRect = opts.preferElement.getBoundingClientRect();
        const dx = (rect.left + rect.width / 2) - (prefRect.left + prefRect.width / 2);
        const dy = (rect.top + rect.height / 2) - (prefRect.top + prefRect.height / 2);
        const dist = Math.sqrt(dx * dx + dy * dy);
        score -= Math.min(450, Math.round(dist / 3));
      }

      if (score > bestScore) {
        bestScore = score;
        best = el;
      }
    }

    return best;
  }

  async function humanClick(el) {
    if (!el) return false;
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'smooth' });
    await sleep(randomInt(120, 260));
    el.click();
    await sleep(randomInt(120, 260));
    return true;
  }

  async function waitFor(predicate, timeoutMs = 10000, intervalMs = 250) {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (state.stopRequested) throw new Error('Execucao interrompida.');
      // Suporta predicados sincronos e assincronos sem "truthy" falso-positivo de Promise.
      const out = await Promise.resolve(predicate());
      if (out) return out;
      await sleep(intervalMs);
    }
    return null;
  }

  function getPromptInput() {
    const candidates = Array.from(document.querySelectorAll(
      'textarea, div[contenteditable="true"][role="textbox"], div[contenteditable="true"]'
    )).filter((el) => isVisible(el) && !isRunnerElement(el));

    if (!candidates.length) return null;

    const scored = candidates
      .map((el) => {
        const t = textFromElement(el);
        const rect = el.getBoundingClientRect();
        let score = rect.width * rect.height;

        if (t.includes('prompt')) score += 10000;
        if (t.includes('describe')) score += 4000;
        if (t.includes('descreva')) score += 4000;

        const ph = normalize(el.getAttribute('placeholder') || '');
        if (ph.includes('prompt')) score += 12000;
        if (ph.includes('descreva')) score += 6000;

        return { el, score };
      })
      .sort((a, b) => b.score - a.score);

    return scored[0].el;
  }

  function isGenerateLikeText(text) {
    const t = normalize(text);
    if (!t) return false;
    if (t.includes('template') || t.includes('tutorial') || t.includes('community')) return false;
    return (
      t === 'generate' ||
      t === 'gerar' ||
      t === 'create' ||
      t === 'criar' ||
      t.includes('generate') ||
      t.includes('gerar') ||
      t.includes('create') ||
      t.includes('criar') ||
      t.includes('create image') ||
      t.includes('criar imagem') ||
      t.startsWith('generate ') ||
      t.startsWith('gerar ') ||
      t.startsWith('create ') ||
      t.startsWith('criar ')
    );
  }

  function findNearestGenerateForPrompt(promptEl) {
    if (!promptEl) return null;

    const promptRect = promptEl.getBoundingClientRect();
    let node = promptEl;

    while (node && node !== document.body) {
      const candidates = Array.from(node.querySelectorAll('button, [role="button"]'))
        .filter((el) => isVisible(el) && !isRunnerElement(el))
        .filter((el) => !isLikelyGlobalTab(el))
        .filter((el) => isGenerateLikeText(textFromElement(el)));

      if (candidates.length) {
        const withDist = candidates
          .map((el) => {
            const rect = el.getBoundingClientRect();
            const dx = (rect.left + rect.width / 2) - (promptRect.left + promptRect.width / 2);
            const dy = (rect.top + rect.height / 2) - (promptRect.top + promptRect.height / 2);
            const dist = Math.sqrt(dx * dx + dy * dy);
            return { el, dist };
          })
          .sort((a, b) => a.dist - b.dist);

        return { button: withDist[0].el, root: node, distance: withDist[0].dist };
      }

      node = node.parentElement;
    }

    return null;
  }

  function getGeneratorContext() {
    const promptCandidates = Array.from(document.querySelectorAll(
      'textarea, div[contenteditable="true"][role="textbox"], div[contenteditable="true"]'
    )).filter((el) => isVisible(el) && !isRunnerElement(el));

    let best = null;
    let bestScore = -Infinity;

    for (const prompt of promptCandidates) {
      const found = findNearestGenerateForPrompt(prompt);
      if (!found) continue;

      const rect = prompt.getBoundingClientRect();
      const ph = normalize(prompt.getAttribute?.('placeholder') || '');
      let score = 0;
      score += Math.min(60000, Math.round(rect.width * rect.height));
      score += Math.max(0, 20000 - Math.round(found.distance * 18));

      if (ph.includes('describe your image') || ph.includes('descreva') || ph.includes('prompt')) score += 8000;
      if (prompt.tagName === 'TEXTAREA') score += 2500;
      if (prompt.closest('aside')) score += 3000;

      if (score > bestScore) {
        bestScore = score;
        best = {
          promptInput: prompt,
          generateButton: found.button,
          root: found.root
        };
      }
    }

    return best;
  }

  function setNativeValue(input, value) {
    const proto = Object.getPrototypeOf(input);
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) descriptor.set.call(input, value);
    else input.value = value;
  }

  async function putPrompt(promptText) {
    const input = await waitFor(() => getPromptInput(), 10000, 350);
    if (!input) throw new Error('Nao encontrei o campo de prompt. Abra a tela de geracao de imagens do Freepik.');

    if (input.matches('textarea, input')) {
      input.focus();
      setNativeValue(input, promptText);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: promptText, inputType: 'insertText' }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: ' ' }));
    } else {
      input.focus();
      input.textContent = '';
      document.execCommand('insertText', false, promptText);
      input.dispatchEvent(new InputEvent('input', { bubbles: true, data: promptText }));
    }

    await sleep(randomInt(200, 400));
  }

  function getGenerateButton() {
    const ctx = getGeneratorContext();
    if (ctx?.generateButton && isVisible(ctx.generateButton)) return ctx.generateButton;

    const fallback = findClickableByTexts([
      'gerar',
      'generate',
      'criar',
      'create',
      'create image',
      'criar imagem'
    ], {
      reject: (el, t) => {
        if (isLikelyGlobalTab(el, t)) return true;
        if (!isGenerateLikeText(t)) return true;
        return false;
      }
    });

    return fallback;
  }

  function getDownloadButtons(options = {}) {
    const { visibleOnly = true, root = document } = options;
    const candidates = Array.from((root || document).querySelectorAll([
      'button',
      'a',
      '[role="button"]',
      '[aria-label]',
      '[data-testid]'
    ].join(',')));

    return candidates.filter((el) => {
      if (el.closest(`#${PANEL_ID}`)) return false;
      if (visibleOnly && !isVisible(el)) return false;

      const href = normalize(el.getAttribute('href') || '');
      if (href.includes('/templates')) return false;

      const t = textFromElement(el);
      return t.includes('download') || t.includes('baixar');
    });
  }

  function getResultImages(options = {}) {
    const { visibleOnly = true, root = document } = options;
    const imgs = Array.from((root || document).querySelectorAll('img'));
    return imgs.filter((img) => {
      if (!(img instanceof HTMLImageElement)) return false;
      if (isRunnerElement(img)) return false;
      if (visibleOnly && !isVisible(img)) return false;

      const rect = img.getBoundingClientRect();
      if (rect.width < 96 || rect.height < 96) return false;

      const src = normalize(img.currentSrc || img.src || '');
      if (!src) return false;
      if (src.includes('avatar') || src.includes('logo')) return false;
      return true;
    });
  }

  function buildImageSignature(img) {
    if (!img) return '';
    const rect = img.getBoundingClientRect();
    const src = img.currentSrc || img.src || '';
    const parentHref = img.closest('a')?.getAttribute('href') || '';
    const holder = img.closest('[data-testid], article, figure, li, div');
    const holderId = holder?.getAttribute?.('data-testid') || '';
    const alt = img.getAttribute('alt') || '';
    return normalize(`${src}|${parentHref}|${holderId}|${Math.round(rect.width)}x${Math.round(rect.height)}|${alt}`);
  }

  function getImageSignatureSet(options = {}) {
    return new Set(
      getResultImages(options)
        .map((img) => buildImageSignature(img))
        .filter(Boolean)
    );
  }

  function scoreResultImageCandidate(img) {
    const rect = img.getBoundingClientRect();
    const context = textFromElement(img.closest('[data-testid], article, figure, li, div') || img);
    let score = 0;
    if (context.includes('just now') || context.includes('agora') || context.includes('sec') || context.includes('s ago')) {
      score += 120;
    }
    score += Math.min(80, Math.round((rect.width * rect.height) / 5000));
    score += Math.max(0, 45 - Math.floor(Math.abs(rect.top) / 28));
    return score;
  }

  function buildDownloadSignature(button) {
    if (!button) return '';
    const container = button.closest('[data-testid], article, figure, li, div') || button.parentElement || button;
    const relatedImg = container?.querySelector?.('img');
    const buttonHref = button.getAttribute('href') || '';
    const parentHref = button.closest('a')?.getAttribute('href') || '';
    const ids = [
      button.getAttribute('data-testid') || '',
      container?.getAttribute?.('data-testid') || ''
    ].join('|');
    const imgSrc = relatedImg?.currentSrc || relatedImg?.src || '';
    const label = textFromElement(button).slice(0, 120);
    return normalize(`${buttonHref}|${parentHref}|${ids}|${imgSrc}|${label}`);
  }

  function getDownloadSignatureSet(options = {}) {
    return new Set(
      getDownloadButtons(options)
        .map((btn) => buildDownloadSignature(btn))
        .filter(Boolean)
    );
  }

  function findDownloadButtonNearElement(el) {
    if (!el) return null;

    let node = el;
    for (let depth = 0; depth < 6 && node; depth += 1) {
      const candidates = getDownloadButtons({ visibleOnly: true, root: node })
        .filter((btn) => !isLikelyGlobalTab(btn));
      if (candidates.length) {
        const ranked = candidates
          .map((btn) => ({ btn, score: scoreDownloadButtonCandidate(btn) }))
          .sort((a, b) => b.score - a.score);
        return ranked[0].btn;
      }
      node = node.parentElement;
    }

    return null;
  }

  function revealActionsNearElement(el) {
    if (!el) return;
    const targets = [el, el.parentElement, el.closest('article, figure, li, [data-testid], div')].filter(Boolean);
    for (const target of targets) {
      const events = ['mouseenter', 'mouseover', 'mousemove'];
      events.forEach((name) => {
        target.dispatchEvent(new MouseEvent(name, { bubbles: true, cancelable: true }));
      });
    }
  }

  function findMenuButtonNearElement(el) {
    if (!el) return null;

    let node = el;
    for (let depth = 0; depth < 6 && node; depth += 1) {
      const menuCandidates = Array.from(node.querySelectorAll([
        'button[aria-haspopup="menu"]',
        '[role="button"][aria-haspopup="menu"]',
        'button[data-testid*="menu" i]',
        'button[data-testid*="more" i]',
        '[aria-label*="menu" i]',
        '[aria-label*="more" i]',
        '[aria-label*="options" i]',
        '[aria-label*="mais" i]',
        '[title*="menu" i]',
        '[title*="more" i]',
        '[title*="options" i]'
      ].join(',')))
        .filter((btn) => isVisible(btn) && !isRunnerElement(btn))
        .filter((btn) => !isLikelyGlobalTab(btn));

      if (menuCandidates.length) {
        const refRect = el.getBoundingClientRect();
        const ranked = menuCandidates
          .map((btn) => {
            const rect = btn.getBoundingClientRect();
            const dx = (rect.left + rect.width / 2) - (refRect.right - 10);
            const dy = (rect.top + rect.height / 2) - (refRect.top + 12);
            const dist = Math.sqrt(dx * dx + dy * dy);
            return { btn, dist };
          })
          .sort((a, b) => a.dist - b.dist);
        return ranked[0].btn;
      }

      node = node.parentElement;
    }

    return null;
  }

  async function tryDownloadFromAssetMenu(imageEl) {
    if (!imageEl) return false;

    revealActionsNearElement(imageEl);
    await sleep(220);

    const menuBtn = findMenuButtonNearElement(imageEl);
    if (!menuBtn) return false;

    await humanClick(menuBtn);
    await sleep(260);

    const menuDownload = await waitFor(() => findClickableByTexts([
      'download',
      'baixar'
    ], {
      tokenMatch: true,
      maxTextLength: 120,
      reject: (el, t) => isLikelyGlobalTab(el, t)
    }), 2800, 160);

    if (!menuDownload) return false;

    await humanClick(menuDownload);
    log('Download acionado (menu do card).');
    await clickSecondaryDownloadOption(menuDownload);
    return true;
  }

  async function clickSecondaryDownloadOption(exceptButton = null) {
    await sleep(800);
    const secondary = findClickableByTexts([
      'download',
      'baixar',
      'original',
      'png',
      'jpg'
    ], {
      tokenMatch: true,
      maxTextLength: 120,
      reject: (el, t) => isLikelyGlobalTab(el, t)
    });

    if (secondary && secondary !== exceptButton) {
      await humanClick(secondary);
      log('Opcao secundaria de download acionada.');
      return true;
    }
    return false;
  }

  async function triggerImageDownload(candidate) {
    if (!candidate) return false;

    if (candidate.type === 'downloadButton' && candidate.btn) {
      await humanClick(candidate.btn);
      log('Download acionado (botao direto).');
      await clickSecondaryDownloadOption(candidate.btn);
      return true;
    }

    if (candidate.type === 'image' && candidate.imageEl) {
      revealActionsNearElement(candidate.imageEl);
      await sleep(200);

      const nearBtn = findDownloadButtonNearElement(candidate.imageEl);
      if (nearBtn) {
        await humanClick(nearBtn);
        log('Download acionado (card).');
        await clickSecondaryDownloadOption(nearBtn);
        return true;
      }

      const byMenu = await tryDownloadFromAssetMenu(candidate.imageEl);
      if (byMenu) return true;

      const previewTarget = candidate.imageEl.closest('a, button, [role="button"]') || candidate.imageEl;
      await humanClick(previewTarget);
      await sleep(650);

      const previewDownload = await waitFor(() => findClickableByTexts([
        'download',
        'baixar'
      ], {
        tokenMatch: true,
        avoidContainers: false,
        maxTextLength: 140,
        reject: (el, t) => isLikelyGlobalTab(el, t)
      }), 5500, 240);

      if (!previewDownload) return false;

      await humanClick(previewDownload);
      log('Download acionado (preview).');
      await clickSecondaryDownloadOption(previewDownload);
      return true;
    }

    return false;
  }

  function isLikelyGlobalTab(el, normalizedText = '') {
    if (!el) return false;
    const t = normalizedText || textFromElement(el);
    const role = normalize(el.getAttribute('role') || '');
    const href = normalize(el.getAttribute('href') || '');
    const inGlobalNav = !!el.closest('header, nav');
    const inTabList = !!el.closest('[role="tablist"]');

    if (href.includes('/templates') || href.includes('/template')) return true;
    if (role === 'tab' || inTabList) return true;
    if (inGlobalNav && (t.includes('template') || t.includes('model') || t.includes('community'))) return true;
    return false;
  }

  function getGeneratorRoot() {
    const ctx = getGeneratorContext();
    if (ctx?.root) return ctx.root;
    const generateBtn = getGenerateButton();
    return generateBtn?.parentElement || null;
  }

  async function ensurePersonalizationTabOpen() {
    const tab = findClickableByTexts([
      'personalizacao',
      'personalization',
      'customization',
      'personalize'
    ]);
    if (tab) {
      await humanClick(tab);
      await sleep(450);
      return true;
    }
    return false;
  }

  function findPreciseOption(optionText, preferElement = null, root = document) {
    return findClickableByTexts([optionText], {
      exact: false,
      tokenMatch: true,
      avoidContainers: true,
      maxTextLength: 120,
      root,
      preferElement,
      reject: (el, t) => isLikelyGlobalTab(el, t)
    });
  }

  function findModelControl() {
    const generatorRoot = getGeneratorRoot();
    const ctx = getGeneratorContext();
    const preferElement = ctx?.promptInput || null;
    const modelHints = [
      'model',
      'modelo',
      'nano banana',
      'flux',
      'seedream',
      'imagen',
      'mystic'
    ];

    if (generatorRoot) {
      const inRoot = findClickableByTexts(modelHints, {
        root: generatorRoot,
        tokenMatch: true,
        avoidContainers: true,
        maxTextLength: 120,
        preferElement,
        reject: (el, t) => isLikelyGlobalTab(el, t)
      });
      if (inRoot) return inRoot;
    }

    return findClickableByTexts(modelHints, {
      tokenMatch: true,
      avoidContainers: true,
      maxTextLength: 120,
      preferElement,
      reject: (el, t) => isLikelyGlobalTab(el, t)
    });
  }

  function getModelAliases(modelName) {
    const base = normalize(modelName);
    if (!base) return [];

    const aliasSet = new Set();
    aliasSet.add(modelName);

    const raw = modelName.trim();
    if (!raw.toLowerCase().startsWith('google ')) {
      aliasSet.add(`Google ${raw}`);
    } else {
      aliasSet.add(raw.replace(/^google\s+/i, '').trim());
    }

    return Array.from(aliasSet).filter(Boolean);
  }

  async function clickOptionValue(value, options = {}) {
    const target = normalize(value);
    if (!target || target === 'keep') return true;

    const generatorRoot = getGeneratorRoot();
    const ctx = getGeneratorContext();
    const preferElement = ctx?.promptInput || null;

    let button = null;
    if (generatorRoot) {
      button = findPreciseOption(value, preferElement, generatorRoot);
    }
    if (!button) {
      button = findPreciseOption(value, preferElement, document);
    }

    if (!button && Array.isArray(options.openers) && options.openers.length) {
      const opener = findClickableByTexts(options.openers, {
        tokenMatch: true,
        avoidContainers: true,
        maxTextLength: 120,
        preferElement,
        reject: (el, t) => isLikelyGlobalTab(el, t)
      });
      if (opener) {
        await humanClick(opener);
        await sleep(380);
        button = findPreciseOption(value, preferElement, document);
      }
    }

    if (!button) return false;

    await humanClick(button);
    await sleep(300);
    return true;
  }

  async function setDropdownOption(controlTexts, optionText, options = {}) {
    const optionTexts = Array.isArray(optionText) ? optionText.filter(Boolean) : [optionText];
    if (!optionTexts.length) return true;
    if (optionTexts.some((text) => normalize(text) === 'keep')) return true;

    const generatorRoot = getGeneratorRoot();
    const ctx = getGeneratorContext();
    const preferElement = ctx?.promptInput || null;
    const rejectUnsafeControl = (el, normalizedText) => isLikelyGlobalTab(el, normalizedText);

    let control = null;
    if (generatorRoot) {
      control = findClickableByTexts(controlTexts, {
        exact: false,
        tokenMatch: true,
        avoidContainers: true,
        maxTextLength: 120,
        preferElement,
        root: generatorRoot,
        reject: rejectUnsafeControl
      });
    }
    if (!control) {
      control = findClickableByTexts(controlTexts, {
        exact: false,
        tokenMatch: true,
        avoidContainers: true,
        maxTextLength: 120,
        preferElement,
        reject: rejectUnsafeControl
      });
    }

    if (control) {
      await humanClick(control);
      await sleep(350);
    } else {
      return false;
    }

    const option = await waitFor(() => findClickableByTexts(optionTexts, {
      exact: false,
      tokenMatch: true,
      avoidContainers: !!options.avoidContainers,
      maxTextLength: Number(options.maxTextLength) || 0,
      root: document,
      preferElement: control || preferElement,
      reject: rejectUnsafeControl
    }), 4200, 180);
    if (!option) return false;

    await humanClick(option);
    await sleep(300);
    return true;
  }

  async function applyModel(cfg) {
    if (!cfg.autoApplyModel) return;

    if (cfg.modelName) {
      const modelAliases = getModelAliases(cfg.modelName);
      const controlTexts = ['model', 'modelo'];
      let byDropdown = await setDropdownOption(controlTexts, modelAliases, {
        avoidContainers: false,
        maxTextLength: 0
      });

      if (!byDropdown) {
        const modelControl = findModelControl();
        if (modelControl) {
          await humanClick(modelControl);
          await sleep(350);
          const option = await waitFor(() => findClickableByTexts(modelAliases, {
            exact: false,
            tokenMatch: true,
            avoidContainers: false,
            maxTextLength: 0,
            root: document,
            preferElement: modelControl,
            reject: (el, t) => isLikelyGlobalTab(el, t)
          }), 4200, 180);
          if (option) {
            await humanClick(option);
            byDropdown = true;
          }
        }
      }

      if (!byDropdown) {
        log(`Modelo nao aplicado automaticamente (${cfg.modelName}).`);
      } else {
        log(`Modelo aplicado: ${cfg.modelName}`);
      }
    }
  }

  async function applyPersonalization(cfg) {
    if (cfg.autoOpenPersonalization) {
      await ensurePersonalizationTabOpen();
    }

    if (cfg.aspectRatio && cfg.aspectRatio !== 'keep') {
      const ok = await clickOptionValue(cfg.aspectRatio, {
        openers: ['aspect ratio', 'ratio', 'proporcao', 'proporção', '1:1', '3:4', '4:3', '16:9', '9:16']
      });
      log(ok ? `Proporcao aplicada: ${cfg.aspectRatio}` : `Nao achei proporcao: ${cfg.aspectRatio}`);
    }

    if (cfg.quality && cfg.quality !== 'keep') {
      const ok = await clickOptionValue(cfg.quality, {
        openers: ['quality', 'qualidade', '1k', '2k', '4k']
      });
      log(ok ? `Qualidade aplicada: ${cfg.quality}` : `Nao achei qualidade: ${cfg.quality}`);
    }
  }

  async function clickGenerate() {
    const ctx = await waitFor(() => {
      const ctx = getGeneratorContext();
      if (ctx?.generateButton && isVisible(ctx.generateButton)) return ctx;

      const btn = getGenerateButton();
      if (!btn) return null;
      return { generateButton: btn, promptInput: getPromptInput(), root: getGeneratorRoot() };
    }, 7000, 250);

    const btn = ctx?.generateButton;
    if (!btn) throw new Error('Nao encontrei o botao Gerar.');

    const promptInput = ctx?.promptInput || getPromptInput();
    const beforeLabel = textFromElement(btn);
    const beforeDisabled = !!btn.disabled;
    const beforeBusy = normalize(btn.getAttribute('aria-busy') || '');

    const didStart = () => {
      if (hasGenerationInProgress()) return true;
      const current = getGenerateButton();
      if (!current) return false;

      const currentLabel = textFromElement(current);
      const currentDisabled = !!current.disabled;
      const currentBusy = normalize(current.getAttribute('aria-busy') || '');

      if (currentDisabled && !beforeDisabled) return true;
      if (currentBusy && currentBusy !== beforeBusy) return true;
      if (currentLabel && currentLabel !== beforeLabel && !currentLabel.includes('generate') && !currentLabel.includes('gerar')) return true;
      return false;
    };

    async function triggerKeyboardGenerate(targetInput) {
      if (!targetInput) return;
      targetInput.focus();
      const keydowns = [
        new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter', ctrlKey: true }),
        new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter', ctrlKey: true }),
        new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter' }),
        new KeyboardEvent('keyup', { bubbles: true, key: 'Enter', code: 'Enter' })
      ];
      keydowns.forEach((evt) => targetInput.dispatchEvent(evt));
    }

    async function dispatchMouseClick(target) {
      if (!target) return;
      const events = ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'];
      events.forEach((name) => {
        target.dispatchEvent(new MouseEvent(name, { bubbles: true, cancelable: true }));
      });
    }

    const attempts = [
      {
        name: 'click',
        run: async () => { await humanClick(btn); }
      },
      {
        name: 'mouse-events',
        run: async () => { await dispatchMouseClick(btn); }
      },
      {
        name: 'form-submit',
        run: async () => {
          const form = btn.closest('form') || promptInput?.closest?.('form');
          if (form && typeof form.requestSubmit === 'function') {
            form.requestSubmit();
          } else if (form) {
            form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
          }
        }
      },
      {
        name: 'keyboard-enter',
        run: async () => { await triggerKeyboardGenerate(promptInput); }
      },
      {
        name: 'second-click',
        run: async () => { await sleep(250); await humanClick(btn); }
      }
    ];

    for (const attempt of attempts) {
      await attempt.run();
      const started = await waitFor(() => didStart(), 2200, 180);
      if (started) {
        log(`Geracao iniciada (${attempt.name}).`);
        return Date.now();
      }
    }

    throw new Error('Prompt inserido, mas o Freepik nao iniciou ao clicar em Gerar.');
  }

  function hasGenerationInProgress() {
    const btn = getGenerateButton();
    if (!btn) return false;

    const label = textFromElement(btn);
    if (label.includes('gerando') || label.includes('generating') || label.includes('stop') || label.includes('cancel')) {
      return true;
    }
    if (btn.disabled) return true;
    return false;
  }

  function scoreDownloadButtonCandidate(btn) {
    const rect = btn.getBoundingClientRect();
    const context = textFromElement(btn.closest('[data-testid], article, figure, li, div') || btn);
    let score = 0;
    if (context.includes('just now') || context.includes('agora') || context.includes('sec') || context.includes('s ago')) {
      score += 120;
    }
    if (context.includes('download') || context.includes('baixar')) score += 30;
    score += Math.max(0, 40 - Math.floor(Math.abs(rect.top) / 30));
    return score;
  }

  async function waitForGenerationToComplete(cfg, generatedAtMs) {
    const timeoutMs = Math.max(30, Number(cfg.maxWaitPerImageSec) || 180) * 1000;
    let seenGenerating = false;

    const done = await waitFor(() => {
      const elapsed = Date.now() - generatedAtMs;
      const inProgress = hasGenerationInProgress();
      if (inProgress) seenGenerating = true;

      if (!seenGenerating) return null;
      // Evita falso positivo logo apos clicar em Gerar.
      if (elapsed < 3000) return null;
      if (inProgress) return null;
      return true;
    }, timeoutMs, 900);

    if (!done) {
      throw new Error('Tempo esgotado esperando a imagem finalizar.');
    }

    log('Imagem finalizada.');
  }

  function parsePrompts(text) {
    return (text || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function setModelInputVisibility(ui) {
    if (!ui?.modelCustomWrap || !ui?.modelPreset) return;
    const isCustom = ui.modelPreset.value === CUSTOM_MODEL_VALUE;
    ui.modelCustomWrap.style.display = isCustom ? 'block' : 'none';
  }

  function getUiValues() {
    const ui = state.ui;
    const chosenModel = ui.modelPreset.value === CUSTOM_MODEL_VALUE
      ? ui.modelCustom.value.trim()
      : ui.modelPreset.value.trim();

    return {
      modelPreset: ui.modelPreset.value,
      modelName: chosenModel,
      promptsText: ui.prompts.value,
      aspectRatio: ui.aspectRatio.value,
      quality: ui.quality.value,
      autoDownload: false,
      autoApplyModel: ui.autoApplyModel.checked,
      autoOpenPersonalization: ui.autoOpenPersonalization.checked,
      delayBetweenPromptsMs: Math.max(300, Number(ui.delayBetweenPromptsMs.value) || DEFAULTS.delayBetweenPromptsMs),
      maxWaitPerImageSec: Math.max(30, Number(ui.maxWaitPerImageSec.value) || DEFAULTS.maxWaitPerImageSec)
    };
  }

  function setRunningUi(isRunning) {
    const ui = state.ui;
    ui.runBtn.disabled = isRunning;
    ui.stopBtn.disabled = !isRunning;
    ui.prompts.disabled = isRunning;
    ui.modelPreset.disabled = isRunning;
    ui.modelCustom.disabled = isRunning;
    ui.aspectRatio.disabled = isRunning;
    ui.quality.disabled = isRunning;
    ui.autoApplyModel.disabled = isRunning;
    ui.autoOpenPersonalization.disabled = isRunning;
    ui.delayBetweenPromptsMs.disabled = isRunning;
    ui.maxWaitPerImageSec.disabled = isRunning;
  }

  function log(message) {
    const ui = state.ui;
    if (!ui) {
      console.log('[MY BABY Runner]', message);
      return;
    }
    const stamp = new Date().toLocaleTimeString();
    ui.logs.value = `[${stamp}] ${message}\n${ui.logs.value}`.slice(0, 16000);
    ui.status.textContent = message;
  }

  async function runQueue() {
    const cfg = getUiValues();
    // O modelo escolhido no painel deve sempre prevalecer na execucao.
    cfg.autoApplyModel = true;
    saveConfig(cfg);

    const prompts = parsePrompts(cfg.promptsText);
    if (!prompts.length) {
      log('Adicione ao menos um prompt (1 por linha).');
      return;
    }

    state.running = true;
    state.stopRequested = false;
    setRunningUi(true);

    log(`Fila iniciada com ${prompts.length} prompt(s).`);

    try {
      await applyModel(cfg);
      await applyPersonalization(cfg);

      for (let i = 0; i < prompts.length; i += 1) {
        if (state.stopRequested) throw new Error('Execucao interrompida pelo usuario.');

        try {
          const prompt = prompts[i];
          log(`(${i + 1}/${prompts.length}) Enviando prompt...`);
          await putPrompt(prompt);

          const generatedAt = await clickGenerate();
          await waitForGenerationToComplete(cfg, generatedAt);
        } catch (err) {
          log(`Falha no prompt ${i + 1}: ${err?.message || err}`);
        }

        if (i < prompts.length - 1) {
          const delay = Math.max(300, Number(cfg.delayBetweenPromptsMs) || 1000);
          log(`Aguardando ${delay}ms para o proximo prompt...`);
          await sleep(delay);
        }
      }

      log('Fila concluida com sucesso.');
    } catch (err) {
      log(`Erro: ${err?.message || err}`);
    } finally {
      state.running = false;
      state.stopRequested = false;
      setRunningUi(false);
    }
  }

  function stopQueue() {
    if (!state.running) return;
    state.stopRequested = true;
    log('Parada solicitada. Finalizando etapa atual...');
  }

  // ---------- UI ----------

  function addStyles() {
    if (document.getElementById(STYLE_ID)) return;

    const css = `
      #${PANEL_ID} {
        --mbr-bg: #070809;
        --mbr-surface: #101216;
        --mbr-surface-2: #171a20;
        --mbr-border: #252a33;
        --mbr-text: #f3f6fb;
        --mbr-muted: #9098a8;
        --mbr-accent: #22d3ee;
        --mbr-accent-soft: rgba(34, 211, 238, 0.2);
        position: fixed;
        top: 86px;
        right: 18px;
        z-index: 999999;
        width: 370px;
        max-height: calc(100vh - 110px);
        overflow: auto;
        background:
          radial-gradient(circle at 88% -4%, rgba(34, 211, 238, 0.16), transparent 36%),
          radial-gradient(circle at -10% 115%, rgba(255, 255, 255, 0.05), transparent 30%),
          var(--mbr-bg);
        color: var(--mbr-text);
        border: 1px solid var(--mbr-border);
        border-radius: 16px;
        box-shadow: 0 20px 38px rgba(0, 0, 0, 0.52);
        font-family: Bahnschrift, 'Trebuchet MS', 'Segoe UI', sans-serif;
        padding: 14px;
      }
      #${PANEL_ID} * { box-sizing: border-box; }
      #${PANEL_ID} .brand {
        padding: 2px 2px 12px;
        border-bottom: 1px solid var(--mbr-border);
        margin-bottom: 8px;
      }
      #${PANEL_ID} h3 {
        margin: 0;
        font-size: 17px;
        font-weight: 700;
        letter-spacing: 0.3px;
      }
      #${PANEL_ID} .brand-sub {
        margin-top: 2px;
        font-size: 11px;
        color: var(--mbr-muted);
        letter-spacing: 0.35px;
      }
      #${PANEL_ID} label {
        display: block;
        font-size: 11px;
        margin: 10px 0 4px;
        color: #c4ccda;
        letter-spacing: 0.25px;
      }
      #${PANEL_ID} input,
      #${PANEL_ID} select,
      #${PANEL_ID} textarea,
      #${PANEL_ID} button {
        width: 100%;
        border-radius: 10px;
        border: 1px solid var(--mbr-border);
        background: var(--mbr-surface);
        color: var(--mbr-text);
        padding: 9px 10px;
        font-size: 12px;
        transition: border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease;
      }
      #${PANEL_ID} input:focus,
      #${PANEL_ID} select:focus,
      #${PANEL_ID} textarea:focus {
        outline: none;
        border-color: var(--mbr-accent);
        box-shadow: 0 0 0 3px var(--mbr-accent-soft);
      }
      #${PANEL_ID} textarea {
        min-height: 124px;
        resize: vertical;
        line-height: 1.35;
      }
      #${PANEL_ID} .row {
        display: flex;
        gap: 8px;
      }
      #${PANEL_ID} .row > * { flex: 1; }
      #${PANEL_ID} .checks {
        margin-top: 10px;
        display: grid;
        gap: 6px;
      }
      #${PANEL_ID} .check {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 7px 9px;
        border: 1px solid var(--mbr-border);
        border-radius: 10px;
        background: var(--mbr-surface);
      }
      #${PANEL_ID} .check input {
        width: auto;
        margin: 0;
        accent-color: var(--mbr-accent);
      }
      #${PANEL_ID} .check span { font-size: 12px; }
      #${PANEL_ID} .actions {
        display: flex;
        gap: 8px;
        margin-top: 12px;
      }
      #${PANEL_ID} .actions button {
        font-weight: 700;
        cursor: pointer;
      }
      #${PANEL_ID} button:hover {
        border-color: #374151;
      }
      #${PANEL_ID} .run {
        background: linear-gradient(135deg, #0e7a69 0%, #14b8a6 100%);
        border-color: #149a8d;
        color: #041513;
      }
      #${PANEL_ID} .stop {
        background: #2b0d10;
        border-color: #642029;
        color: #f6dbe0;
      }
      #${PANEL_ID} .social-wrap {
        margin-top: 10px;
        padding: 10px;
        border: 1px solid var(--mbr-border);
        border-radius: 12px;
        background: var(--mbr-surface-2);
      }
      #${PANEL_ID} .social-title {
        font-size: 11px;
        color: var(--mbr-muted);
        margin-bottom: 7px;
      }
      #${PANEL_ID} .socials {
        display: grid;
        gap: 7px;
      }
      #${PANEL_ID} .socials button {
        text-align: left;
        background: #0c0e12;
        border-color: #2a2f39;
        color: #d9e1ef;
        font-weight: 600;
        cursor: pointer;
      }
      #${PANEL_ID} .socials button:hover {
        border-color: var(--mbr-accent);
        box-shadow: 0 0 0 2px var(--mbr-accent-soft);
        transform: translateY(-1px);
      }
      #${PANEL_ID} .status {
        margin-top: 10px;
        font-size: 12px;
        padding: 8px;
        border-radius: 10px;
        background: var(--mbr-surface);
        border: 1px solid var(--mbr-border);
      }
      #${PANEL_ID} .hint {
        margin-top: 8px;
        color: var(--mbr-muted);
        font-size: 11px;
        line-height: 1.35;
      }
      #${PANEL_ID} .logs {
        margin-top: 8px;
        min-height: 88px;
        max-height: 190px;
        font-family: Consolas, monospace;
        font-size: 11px;
        background: #0b0d11;
      }
      #${LAUNCHER_ID} {
        position: fixed;
        right: 18px;
        bottom: 18px;
        z-index: 1000000;
        width: 48px;
        height: 48px;
        border-radius: 999px;
        border: 1px solid #2a2f39;
        background: #0f1318;
        color: #e6edf9;
        font-weight: 800;
        cursor: pointer;
        box-shadow: 0 10px 20px rgba(0, 0, 0, 0.42);
      }
      #${LAUNCHER_ID}:hover {
        border-color: #22d3ee;
        box-shadow: 0 0 0 3px rgba(34, 211, 238, 0.2);
      }
    `;

    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  function buildPanel() {
    const existing = document.getElementById(PANEL_ID);
    if (existing) {
      const hasExpectedLayout = !!(
        existing.querySelector('#mbr-model-preset') &&
        existing.querySelector('#mbr-model-custom') &&
        existing.querySelector('#mbr-prompts') &&
        existing.querySelector('#mbr-youtube') &&
        existing.querySelector('#mbr-instagram') &&
        existing.querySelector('#mbr-referral')
      );

      if (!hasExpectedLayout) {
        existing.remove();
      } else {
        existing.style.display = 'block';
        if (!state.ui) {
          state.ui = {
            panel: existing,
            modelPreset: existing.querySelector('#mbr-model-preset'),
            modelCustomWrap: existing.querySelector('#mbr-model-custom-wrap'),
            modelCustom: existing.querySelector('#mbr-model-custom'),
            prompts: existing.querySelector('#mbr-prompts'),
            aspectRatio: existing.querySelector('#mbr-aspect'),
            quality: existing.querySelector('#mbr-quality'),
            delayBetweenPromptsMs: existing.querySelector('#mbr-delay'),
            maxWaitPerImageSec: existing.querySelector('#mbr-timeout'),
            autoApplyModel: existing.querySelector('#mbr-automodel'),
            autoOpenPersonalization: existing.querySelector('#mbr-autopers'),
            youtubeBtn: existing.querySelector('#mbr-youtube'),
            instagramBtn: existing.querySelector('#mbr-instagram'),
            referralBtn: existing.querySelector('#mbr-referral'),
            runBtn: existing.querySelector('#mbr-run'),
            stopBtn: existing.querySelector('#mbr-stop'),
            status: existing.querySelector('#mbr-status'),
            logs: existing.querySelector('#mbr-logs')
          };
          setModelInputVisibility(state.ui);
        }
        return;
      }
    }

    const cfg = loadConfig();

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.innerHTML = `
      <div class="brand">
        <h3>Freepik automator</h3>
        <div class="brand-sub">Criador @andrevidmob</div>
      </div>

      <label>Modelo</label>
      <select id="mbr-model-preset">
        ${MODEL_PRESETS.map((m) => `<option value="${m}">${m}</option>`).join('')}
        <option value="${CUSTOM_MODEL_VALUE}">Outro (personalizado)</option>
      </select>
      <div id="mbr-model-custom-wrap">
        <label>Outro modelo</label>
        <input id="mbr-model-custom" type="text" placeholder="Digite o nome do modelo" />
      </div>

      <label>Prompts (1 por linha)</label>
      <textarea id="mbr-prompts" placeholder="Prompt 1\nPrompt 2\nPrompt 3"></textarea>

      <div class="row">
        <div>
          <label>Proporcao</label>
          <select id="mbr-aspect">
            <option value="keep">Manter atual</option>
            <option value="1:1">1:1</option>
            <option value="3:4">3:4</option>
            <option value="4:3">4:3</option>
            <option value="16:9">16:9</option>
            <option value="9:16">9:16</option>
          </select>
        </div>
        <div>
          <label>Qualidade</label>
          <select id="mbr-quality">
            <option value="keep">Manter atual</option>
            <option value="1K">1K</option>
            <option value="2K">2K</option>
            <option value="4K">4K</option>
          </select>
        </div>
      </div>

      <div class="row">
        <div>
          <label>Delay entre prompts (ms)</label>
          <input id="mbr-delay" type="number" min="300" step="100" />
        </div>
        <div>
          <label>Timeout por imagem (s)</label>
          <input id="mbr-timeout" type="number" min="30" step="5" />
        </div>
      </div>

      <div class="checks">
        <label class="check"><input id="mbr-automodel" type="checkbox" /><span>Aplicar modelo automatico</span></label>
        <label class="check"><input id="mbr-autopers" type="checkbox" /><span>Abrir aba de personalizacao antes de aplicar opcoes</span></label>
      </div>

      <div class="actions">
        <button id="mbr-run" class="run">Run</button>
        <button id="mbr-stop" class="stop" disabled>Stop</button>
      </div>

      <div class="social-wrap">
        <div class="social-title">Me siga e use meu link:</div>
        <div class="socials">
          <button id="mbr-youtube">Me siga no YouTube</button>
          <button id="mbr-instagram">Me siga no Instagram</button>
          <button id="mbr-referral">Use meu referral Freepik</button>
        </div>
      </div>

      <div id="mbr-status" class="status">Pronto.</div>
      <div class="hint">Dica: deixe o Freepik na tela de geracao de imagens antes de clicar em Run.</div>
      <textarea id="mbr-logs" class="logs" readonly></textarea>
    `;

    document.body.appendChild(panel);

    const ui = {
      panel,
      modelPreset: panel.querySelector('#mbr-model-preset'),
      modelCustomWrap: panel.querySelector('#mbr-model-custom-wrap'),
      modelCustom: panel.querySelector('#mbr-model-custom'),
      prompts: panel.querySelector('#mbr-prompts'),
      aspectRatio: panel.querySelector('#mbr-aspect'),
      quality: panel.querySelector('#mbr-quality'),
      delayBetweenPromptsMs: panel.querySelector('#mbr-delay'),
      maxWaitPerImageSec: panel.querySelector('#mbr-timeout'),
      autoApplyModel: panel.querySelector('#mbr-automodel'),
      autoOpenPersonalization: panel.querySelector('#mbr-autopers'),
      youtubeBtn: panel.querySelector('#mbr-youtube'),
      instagramBtn: panel.querySelector('#mbr-instagram'),
      referralBtn: panel.querySelector('#mbr-referral'),
      runBtn: panel.querySelector('#mbr-run'),
      stopBtn: panel.querySelector('#mbr-stop'),
      status: panel.querySelector('#mbr-status'),
      logs: panel.querySelector('#mbr-logs')
    };

    ui.modelPreset.value = cfg.modelPreset || (MODEL_PRESETS.includes(cfg.modelName) ? cfg.modelName : CUSTOM_MODEL_VALUE);
    ui.modelCustom.value = cfg.modelName || '';
    setModelInputVisibility(ui);
    ui.prompts.value = cfg.promptsText;
    ui.aspectRatio.value = cfg.aspectRatio;
    ui.quality.value = cfg.quality;
    ui.delayBetweenPromptsMs.value = cfg.delayBetweenPromptsMs;
    ui.maxWaitPerImageSec.value = cfg.maxWaitPerImageSec;
    ui.autoApplyModel.checked = cfg.autoApplyModel;
    ui.autoOpenPersonalization.checked = cfg.autoOpenPersonalization;

    state.ui = ui;

    const autoSave = () => saveConfig(getUiValues());

    [
      ui.modelPreset,
      ui.modelCustom,
      ui.prompts,
      ui.aspectRatio,
      ui.quality,
      ui.delayBetweenPromptsMs,
      ui.maxWaitPerImageSec,
      ui.autoApplyModel,
      ui.autoOpenPersonalization
    ].forEach((el) => el.addEventListener('change', autoSave));

    ui.modelPreset.addEventListener('change', () => {
      setModelInputVisibility(ui);
      autoSave();
    });

    ui.youtubeBtn.addEventListener('click', () => {
      window.open(YOUTUBE_URL, '_blank', 'noopener,noreferrer');
    });

    ui.instagramBtn.addEventListener('click', () => {
      window.open(INSTAGRAM_URL, '_blank', 'noopener,noreferrer');
    });

    ui.referralBtn.addEventListener('click', () => {
      window.open(REFERRAL_URL, '_blank', 'noopener,noreferrer');
    });

    ui.runBtn.addEventListener('click', () => {
      if (!state.running) runQueue();
    });

    ui.stopBtn.addEventListener('click', stopQueue);
  }

  function ensureLauncher() {
    let launcher = document.getElementById(LAUNCHER_ID);
    if (!launcher) {
      launcher = document.createElement('button');
      launcher.id = LAUNCHER_ID;
      launcher.type = 'button';
      launcher.textContent = 'FA';
      launcher.title = 'Abrir/Fechar Freepik automator';
      launcher.addEventListener('click', () => {
        const panel = document.getElementById(PANEL_ID);
        if (!panel) {
          buildPanel();
          return;
        }
        panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      });
      (document.body || document.documentElement).appendChild(launcher);
    }
  }

  function isDomReadyForPanel() {
    return !!(document.documentElement && document.head && document.body);
  }

  function scheduleBoot() {
    if (state.bootTimer) clearTimeout(state.bootTimer);
    state.bootTimer = setTimeout(() => {
      state.bootTimer = null;
      boot();
    }, BOOT_RETRY_MS);
  }

  function observePageMutations() {
    if (state.observer) return;
    if (!document.body) return;

    state.observer = new MutationObserver(() => {
      ensureLauncher();
      if (!document.getElementById(PANEL_ID)) {
        try {
          addStyles();
          buildPanel();
          log('Painel restaurado.');
        } catch (err) {
          console.error('[MY BABY Runner] Falha ao restaurar painel:', err);
        }
      }
    });

    state.observer.observe(document.body, { childList: true, subtree: true });
  }

  function boot() {
    try {
      if (!state.bootStartedAt) state.bootStartedAt = Date.now();

      if (!isDomReadyForPanel()) {
        if (Date.now() - state.bootStartedAt < BOOT_TIMEOUT_MS) {
          scheduleBoot();
        } else {
          console.error('[MY BABY Runner] Timeout aguardando DOM pronto.');
        }
        return;
      }

      addStyles();
      ensureLauncher();
      buildPanel();
      observePageMutations();
      log('Painel carregado.');
    } catch (err) {
      console.error('[MY BABY Runner] Erro no boot:', err);
      if (Date.now() - state.bootStartedAt < BOOT_TIMEOUT_MS) {
        scheduleBoot();
      }
    }
  }

  async function init() {
    boot();
  }

  init();
})();
